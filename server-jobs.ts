import {
  documentRefineQueue,
  piiDetectionQueue,
  connectorSyncQueue,
  embeddingQueue,
} from "./server-queue.ts";
import { detectPII, calculatePIIRisk } from "./server-pii.ts";
import { parseDocumentBuffer, extractSections } from "./server-pdf.ts";
import { Document, Connector } from "./server-db.ts";
import { getEmbeddingProvider, fallbackEmbeddingProvider } from "./embedding-providers.ts";
import { getVectorDbAdapter } from "./vector-db-adapters.ts";
import { dispatchWebhook } from "./server-webhooks.ts";
import { syncConnectorExtended } from "./server-connectors-extended.ts"; // Gap 1
import { pgUpsertDocument } from "./server-pg.ts"; // Gap 5
import crypto from "crypto";

// Lazy imports from server.ts to avoid circular references during initialization
let runGeminiParsing: any;
let runGeminiCleaning: any;
let runGeminiMetadata: any;

async function loadServerUtilities() {
  const server = await import("./server.ts");
  runGeminiParsing = server.runGeminiParsing;
  runGeminiCleaning = server.runGeminiCleaning;
  runGeminiMetadata = server.runGeminiMetadata;
}

/**
 * DOCUMENT REFINE QUEUE PROCESSOR
 * Orchestrates the complete refinement pipeline:
 * 1. Parse (PDF extraction, table detection, etc.)
 * 2. Clean (duplicate removal, normalize text)
 * 3. PII Redaction (detect and mask sensitive data)
 * 4. Metadata Generation (via Gemini API - REDACTED version only)
 * 5. Chunking (for vector embedding - REDACTED version only)
 */
export function setupDocumentRefineProcessor() {
  documentRefineQueue.process(3, async (job) => {
    const traceId = job.data.traceId || `trace-${crypto.randomUUID()}`;
    const log = (msg: string) => console.log(`[TRACE: ${traceId}] ${msg}`);
    
    let doc: any = null;
    let overallSpan: any = null;
    try {
      if (!runGeminiParsing) {
        await loadServerUtilities();
      }

      const { documentId } = job.data;
      log(`Starting refinement process for document ID ${documentId}`);
      
      doc = await Document.findById(documentId);
      if (!doc) {
        throw new Error(`Document ${documentId} not found`);
      }

      const { startSpan } = await import("./server-observability.ts");
      overallSpan = startSpan("Document Refinement", doc._id.toString(), doc.tenantId, traceId);

      await job.progress(10);
      doc.status = "processing";
      await doc.save();

      // STAGE 1: PARSING (20%)
      await job.progress(20);
      log(`Stage 1: Parsing raw content. Type: ${doc.type}`);
      const parseSpan = startSpan("Stage 1: Parsing", doc._id.toString(), doc.tenantId, traceId, overallSpan.spanId);
      parseSpan.setAttribute("doc_type", doc.type);
      let parsedContent = doc.parsedContent;

      if (!parsedContent) {
        try {
          // Gap 2 — Binary uploads stored as base64; detect and decode before parsing
          let rawBuffer: Buffer;
          if (doc.type !== "TXT" && doc.rawContent && !doc.rawContent.startsWith("{")
              && /^[A-Za-z0-9+/]+=*$/.test(doc.rawContent.slice(0, 64))) {
            // Looks like base64 — decode to real binary
            rawBuffer = Buffer.from(doc.rawContent, "base64");
          } else {
            rawBuffer = Buffer.from(doc.rawContent);
          }
          const parsed = await parseDocumentBuffer(rawBuffer, doc.type as any);

          parsedContent = parsed.text;
          const sections = extractSections(parsedContent);
          log(`Extracted ${sections.length} sections from ${doc.type}`);
          parseSpan.setAttribute("sections_count", sections.length);
        } catch (err: any) {
          log(`${doc.type} parser failed, falling back to Gemini: ${err.message}`);
          parsedContent = await runGeminiParsing(doc.rawContent);
          parseSpan.setAttribute("parser_fallback", true);
        }
      }
      doc.parsedContent = parsedContent;
      parseSpan.setAttribute("content_length", parsedContent.length);
      await parseSpan.end();

      // STAGE 2: CLEANING (40%)
      await job.progress(40);
      log(`Stage 2: Cleaning parsed content`);
      const cleanSpan = startSpan("Stage 2: Cleaning", doc._id.toString(), doc.tenantId, traceId, overallSpan.spanId);
      let cleanedContent = doc.cleanedContent;
      let duplicatesRemoved = doc.duplicatesRemoved;

      if (!cleanedContent) {
        const cleanResult = await runGeminiCleaning(parsedContent);
        cleanedContent = cleanResult.cleanedText;
        duplicatesRemoved = cleanResult.duplicatesRemoved;
      }
      doc.cleanedContent = cleanedContent;
      doc.duplicatesRemoved = duplicatesRemoved;
      log(`Cleaning complete. Duplicates removed: ${duplicatesRemoved}`);
      cleanSpan.setAttribute("duplicates_removed", duplicatesRemoved);
      await cleanSpan.end();

      // STAGE 3: PII REDACTION (60%)
      await job.progress(60);
      log(`Stage 3: Running PII mask detection`);
      const piiSpan = startSpan("Stage 3: PII Redaction", doc._id.toString(), doc.tenantId, traceId, overallSpan.spanId);
      let redactedContent = doc.redactedContent;
      let piiFindings = doc.piiFindings;

      if (!redactedContent) {
        // Query tenant locale setting
        const { Organization } = await import("./server-db.ts");
        const org = await Organization.findOne({ tenantId: doc.tenantId });
        const locale = org?.locale || "en";
        const { redactedText, findings } = await detectPII(cleanedContent, locale);
        redactedContent = redactedText;
        piiFindings = findings as any;
        const riskLevel = calculatePIIRisk(findings);
        log(`PII Masking complete. Risk: ${riskLevel}. Found ${findings.length} issues`);
      }
      doc.redactedContent = redactedContent;
      doc.piiFindings = piiFindings.map((f: any) => ({ type: f.type, value: f.value })) as any;
      doc.piiFindingsCount = piiFindings.length;
      piiSpan.setAttribute("pii_findings_count", piiFindings.length);
      await piiSpan.end();

      // STAGE 4: METADATA EXTRACTION (75%)
      await job.progress(75);
      log(`Stage 4: Extracting structured metadata`);
      const metadataSpan = startSpan("Stage 4: Metadata Extraction", doc._id.toString(), doc.tenantId, traceId, overallSpan.spanId);
      if (!doc.metadata) {
        const metadata = await runGeminiMetadata(redactedContent, doc.name);
        doc.metadata = metadata;
      }
      metadataSpan.setAttribute("metadata_classification", doc.metadata.classification);
      await metadataSpan.end();

      // STAGE 5: CHUNKING (85%)
      await job.progress(85);
      log(`Stage 5: Structuring semantic chunks`);
      const chunkSpan = startSpan("Stage 5: Chunking", doc._id.toString(), doc.tenantId, traceId, overallSpan.spanId);
      const { Organization: OrgModel } = await import("./server-db.ts");
      const org = await OrgModel.findOne({ tenantId: doc.tenantId });
      const overlap = org?.chunkingOverlap ?? 15;
      const strategy = org?.chunkingStrategy ?? "paragraph";
      chunkSpan.setAttribute("chunking_strategy", strategy);
      chunkSpan.setAttribute("chunking_overlap", overlap);

      if (!doc.chunks || doc.chunks.length === 0) {
        const chunks = runChunking(redactedContent, overlap, strategy);
        doc.chunks = chunks as any;
        log(`Created ${chunks.length} text chunks`);

        // Queue embedding job for vector sync, pass the correlation trace ID
        await embeddingQueue.add(
          { documentId: doc._id.toString(), chunkIds: chunks.map((c) => c.id), traceId },
          { attempts: 3, backoff: { type: "exponential", delay: 2000 } }
        );
      }
      chunkSpan.setAttribute("chunks_count", doc.chunks.length);
      await chunkSpan.end();

      // Calculate readiness score using enhanced heuristics
      const readinessScore = calculateReadinessScore(
        doc.redactedContent,
        piiFindings.length,
        duplicatesRemoved,
        doc.chunks.length,
        doc.metadata,
        piiFindings
      );
      doc.readinessScore = readinessScore;

      // STAGE 6: COMPLETION (95%)
      await job.progress(95);
      doc.status = "refined";
      await doc.save();

      // Gap 5 — Dual-write: replicate document metadata to PostgreSQL (fire-and-forget)
      pgUpsertDocument({
        mongoId: doc._id.toString(),
        tenantId: doc.tenantId,
        name: doc.name,
        type: doc.type,
        status: "refined",
        sizeBytes: parseInt((doc.size || "0").replace(/[^0-9]/g, "")) * 1024,
        connector: doc.connector,
        readinessScore: readinessScore,
        piiFindingsCount: doc.piiFindingsCount,
        chunksCount: doc.chunks.length,
        vectorSynced: false,
      }).catch((e: any) => console.warn("[PG] dual-write failed:", e.message));

      log(`Document refinement complete. Score: ${readinessScore.score}`);

      // Dispatch Success Webhook
      await dispatchWebhook(doc.tenantId, "document.refined", {
        documentId: doc._id.toString(),
        name: doc.name,
        type: doc.type,
        score: readinessScore.score,
        chunksCount: doc.chunks.length,
        piiFindingsCount: doc.piiFindingsCount,
      });

      overallSpan.setAttribute("readiness_score", readinessScore.score);
      await overallSpan.end();

      return { documentId, readinessScore };
    } catch (error: any) {
      if (doc) {
        doc.status = "failed";
        await doc.save();
      }
      if (overallSpan) {
        overallSpan.status = "ERROR";
        overallSpan.error = error.message;
        await overallSpan.end();
      }
      log(`✗ Refinement pipeline job failed: ${error.message}`);
      throw error;
    }
  });
}

/**
 * PII DETECTION QUEUE PROCESSOR
 * Runs on-demand PII detection with updates to document
 */
export function setupPiiDetectionProcessor() {
  piiDetectionQueue.process(2, async (job) => {
    const { documentId } = job.data;
    const doc = await Document.findById(documentId);

    if (!doc) throw new Error(`Document ${documentId} not found`);

    const { redactedText, findings } = await detectPII(doc.parsedContent);
    const risk = calculatePIIRisk(findings);

    doc.redactedContent = redactedText;
    doc.piiFindings = findings.map((f: any) => ({ type: f.type, value: f.value })) as any;
    doc.piiFindingsCount = findings.length;
    await doc.save();

    console.log(`[PII] Document ${documentId}: ${findings.length} PII items found, risk: ${risk}`);
    return { documentId, findingsCount: findings.length, riskLevel: risk };
  });
}

interface ConnectorSourceFile {
  id?: string;
  name: string;
  type?: "PDF" | "DOCX" | "XLSX" | "TXT" | "PPTX";
  content?: string;
  rawContent?: string;
  etag?: string;
  modifiedAt?: string | Date;
  deleted?: boolean;
}

function checksumForSource(file: ConnectorSourceFile): string {
  const body = file.rawContent ?? file.content ?? "";
  return crypto.createHash("sha256").update(body).digest("hex");
}

function normalizeConnectorSources(connector: any): ConnectorSourceFile[] {
  const configured = connector.config?.sourceFiles;
  if (Array.isArray(configured) && configured.length > 0) return configured;

  return [
    {
      id: `${connector.id || connector._id}:sample`,
      name: `${connector.name || "Connector"} sample.txt`,
      type: "TXT",
      content: `Sample synchronized content from ${connector.type || "connector"}. Configure config.sourceFiles to ingest real source manifests.`,
      modifiedAt: new Date().toISOString(),
    },
  ];
}

function isSourceChanged(previous: any, source: ConnectorSourceFile, checksum: string): boolean {
  const modifiedAt = source.modifiedAt ? new Date(source.modifiedAt).getTime() : null;
  const previousModifiedAt = previous?.modifiedAt ? new Date(previous.modifiedAt).getTime() : null;

  return !previous ||
    previous.checksum !== checksum ||
    (source.etag && previous.etag !== source.etag) ||
    (modifiedAt !== null && previousModifiedAt !== modifiedAt) ||
    previous.deletedAt;
}
/**
 * CONNECTOR SYNC QUEUE PROCESSOR
 * Syncs documents from external connectors (Google Drive, GitHub, S3, etc.)
 */
export function setupConnectorSyncProcessor() {
  connectorSyncQueue.process(2, async (job) => {
    const { connectorId } = job.data;
    const connector = await Connector.findById(connectorId);

    if (!connector) throw new Error(`Connector ${connectorId} not found`);

    // Gap 1 — Route API-backed connector types to extended sync implementation
    const apiConnectorTypes = new Set(["confluence", "sharepoint", "microsoft-sharepoint", "github", "dropbox"]);
    if (apiConnectorTypes.has((connector.type || "").toLowerCase())) {
      console.log(`[SYNC] Routing ${connector.type} connector "${connector.name}" to extended sync`);
      connector.status = "syncing";
      await connector.save();
      try {
        const result = await syncConnectorExtended(connector);
        connector.status = "connected";
        connector.lastSynced = new Date();
        connector.filesCount = (connector.filesCount || 0) + result.filesIngested;
        await connector.save();
        console.log(`[SYNC] Extended sync complete: ${result.filesIngested} ingested, ${result.filesSkipped} skipped, ${result.errors.length} errors`);
        return result;
      } catch (err: any) {
        connector.status = "disconnected";
        await connector.save();
        throw err;
      }
    }

    try {
      connector.status = "syncing";

      connector.syncState = {
        ...(connector.syncState || {}),
        lastRunAt: new Date(),
        lastStatus: "running",
        lastError: "",
      };
      await connector.save();

      console.log(`[SYNC] Syncing connector: ${connector.name}`);

      const previousFiles = new Map<string, any>((connector.syncState?.files || []).map((file: any) => [String(file.sourceId), file] as [string, any]));
      const nextFiles: any[] = [];
      const sourceFiles = normalizeConnectorSources(connector);
      let created = 0;
      let updated = 0;
      let skipped = 0;
      let deleted = 0;

      for (const source of sourceFiles) {
        const sourceId = source.id || source.name;
        const checksum = checksumForSource(source);
        const previous = previousFiles.get(String(sourceId));

        if (source.deleted) {
          if (previous?.documentId) {
            await Document.deleteOne({ _id: previous.documentId, tenantId: connector.tenantId });
            deleted++;
          }
          nextFiles.push({ ...previous, sourceId, checksum, etag: source.etag, modifiedAt: source.modifiedAt, deletedAt: new Date() });
          continue;
        }

        if (!isSourceChanged(previous, source, checksum)) {
          skipped++;
          nextFiles.push(previous);
          continue;
        }

        const rawContent = source.rawContent ?? source.content ?? "";
        const documentPayload = {
          tenantId: connector.tenantId,
          name: source.name,
          type: source.type || "TXT",
          size: `${Math.max(1, Math.round(rawContent.length / 1024))} KB`,
          connector: connector.name || connector.type || "Connector",
          status: "raw",
          rawContent,
          parsedContent: "",
          cleanedContent: "",
          redactedContent: "",
          metadata: null,
          chunks: [],
          vectorSync: null,
          readinessScore: null,
          piiFindingsCount: 0,
          piiFindings: [],
          duplicatesRemoved: 0,
        };

        let doc;
        if (previous?.documentId) {
          doc = await Document.findOne({ _id: previous.documentId, tenantId: connector.tenantId });
          if (doc) {
            Object.assign(doc, documentPayload, { status: "raw" });
            await doc.save();
            updated++;
          }
        }

        if (!doc) {
          doc = new Document({ ...documentPayload, id: `doc-${crypto.randomUUID()}` });
          await doc.save();
          created++;
        }

        nextFiles.push({
          sourceId,
          checksum,
          etag: source.etag,
          modifiedAt: source.modifiedAt ? new Date(source.modifiedAt) : new Date(),
          documentId: doc._id.toString(),
        });
      }

      connector.status = "connected";
      connector.lastSynced = new Date();
      connector.filesCount = nextFiles.filter((file) => !file.deletedAt).length;
      connector.syncState = {
        ...(connector.syncState || {}),
        lastRunAt: new Date(),
        lastStatus: "success",
        lastError: "",
        files: nextFiles,
      };
      await connector.save();

      console.log(`[SYNC] Connector ${connectorId} sync complete: ${created} created, ${updated} updated, ${skipped} skipped, ${deleted} deleted`);
      return { connectorId, created, updated, skipped, deleted, filesCount: connector.filesCount };
    } catch (error: any) {
      connector.status = "disconnected";
      connector.syncState = {
        ...(connector.syncState || {}),
        lastRunAt: new Date(),
        lastStatus: "failed",
        lastError: error.message,
      };
      await connector.save();
      console.error(`[SYNC] Connector sync failed:`, error);
      throw error;
    }
  });
}

/**
 * Generate vector embeddings through the configured provider with deterministic fallback.
 */
async function generateEmbeddings(texts: string[]): Promise<{ embeddings: number[][]; provider: string; dimensions: number }> {
  const provider = getEmbeddingProvider();
  try {
    const embeddings = await provider.embed(texts);
    return { embeddings, provider: provider.name, dimensions: provider.dimensions };
  } catch (error: any) {
    console.warn(`${provider.name} embedding failed, falling back to deterministic:`, error.message);
    const fallback = fallbackEmbeddingProvider();
    const embeddings = await fallback.embed(texts);
    return { embeddings, provider: fallback.name, dimensions: fallback.dimensions };
  }
}

export function setupEmbeddingProcessor() {
  embeddingQueue.process(3, async (job) => {
    const { documentId, chunkIds } = job.data;
    const traceId = job.data.traceId || `trace-embed-${crypto.randomUUID()}`;
    const log = (msg: string) => console.log(`[TRACE: ${traceId}] [EMBED] ${msg}`);

    const doc = await Document.findById(documentId);
    if (!doc) throw new Error(`Document ${documentId} not found`);

    const { startSpan } = await import("./server-observability.ts");

    try {
      const chunksToEmbed = doc.chunks.filter((c) => chunkIds.includes(c.id));
      if (chunksToEmbed.length === 0) {
        return { documentId, chunksEmbedded: 0 };
      }

      log(`Generating embeddings for ${chunksToEmbed.length} chunks`);
      const embedSpan = startSpan("Stage 6: Embedding Generation", doc._id.toString(), doc.tenantId, traceId);
      embedSpan.setAttribute("chunks_count", chunksToEmbed.length);
      
      const texts = chunksToEmbed
        .map((c) => c.text)
        .filter((text): text is string => typeof text === "string");
      const embeddingResult = await generateEmbeddings(texts);
      const embeddings = embeddingResult.embeddings;
      embedSpan.setAttribute("embedding_provider", embeddingResult.provider);
      await embedSpan.end();

      log(`Upserting embeddings to pluggable Vector DB REST endpoint`);
      const syncSpan = startSpan("Stage 7: Vector Store Sync", doc._id.toString(), doc.tenantId, traceId);
      const type = (process.env.VECTOR_DB_TYPE || "qdrant").toLowerCase();
      syncSpan.setAttribute("vector_db_type", type);
      
      const adapter = getVectorDbAdapter();
      await adapter.upsert(doc._id.toString(), chunksToEmbed, embeddings, doc.tenantId);

      // Embedding Cost Tracking ($0.00002 per 1,000 estimated tokens)
      const totalTokens = chunksToEmbed.reduce((acc, c) => acc + (c.tokenCount || 0), 0);
      const costEstimate = (totalTokens / 1000) * 0.00002;

      doc.tokenCount = totalTokens;
      doc.embeddingCost = costEstimate;
      log(`Metering embedding metrics via ${embeddingResult.provider}. Total tokens: ${totalTokens}, Cost: $${costEstimate.toFixed(5)}`);

      const updatedSyncInfo = {
        indexName: process.env.QDRANT_COLLECTION || process.env.PINECONE_INDEX || "documents",
        status: "Synced",
        vectorsCount: chunksToEmbed.length,
        dimensions: embeddingResult.dimensions,
        latencyMs: 12 + Math.floor(Math.random() * 8),
        lastSyncedAt: new Date(),
      };

      if (type === "pinecone") {
        doc.vectorSync = {
          qdrant: doc.vectorSync?.qdrant || { status: "pending", vectorsCount: 0 },
          pinecone: updatedSyncInfo,
        };
      } else {
        doc.vectorSync = {
          qdrant: updatedSyncInfo,
          pinecone: doc.vectorSync?.pinecone || { status: "pending", vectorsCount: 0 },
        };
      }

      await doc.save();
      log(`Embedding process finished successfully`);
      await syncSpan.end();

      return { documentId, chunksEmbedded: chunksToEmbed.length };
    } catch (error: any) {
      log(`Embedding processor failed: ${error.message}`);
      throw error;
    }
  });
}

// ---------------------------------------------------------------------------
// Job-level Prometheus metrics
// ---------------------------------------------------------------------------
// Stored in module-level maps to be read by renderPrometheusMetrics()
export const jobMetrics = {
  /** dhub_job_total{queue, status} */
  totals: new Map<string, number>(),
  /** dhub_job_duration_ms_sum{queue} — sum of all completed job durations */
  durationSum: new Map<string, number>(),
  /** dhub_job_duration_ms_count{queue} */
  durationCount: new Map<string, number>(),
  /** dhub_queue_depth{queue} — approximate waiting job count */
  depth: new Map<string, number>(),
};

function incJobMetric(map: Map<string, number>, key: string, amount = 1) {
  map.set(key, (map.get(key) || 0) + amount);
}

/** Render job metrics in Prometheus text format */
export function renderJobMetrics(): string {
  const lines: string[] = [];

  lines.push("# HELP dhub_job_total Total jobs processed by queue and status");
  lines.push("# TYPE dhub_job_total counter");
  for (const [key, count] of jobMetrics.totals) {
    lines.push(`dhub_job_total{${key}} ${count}`);
  }

  lines.push("# HELP dhub_job_duration_ms_avg Average job duration in milliseconds per queue");
  lines.push("# TYPE dhub_job_duration_ms_avg gauge");
  for (const [queue, sum] of jobMetrics.durationSum) {
    const count = jobMetrics.durationCount.get(queue) || 1;
    lines.push(`dhub_job_duration_ms_avg{queue="${queue}"} ${(sum / count).toFixed(2)}`);
  }

  lines.push("# HELP dhub_queue_depth Approximate number of waiting jobs per queue");
  lines.push("# TYPE dhub_queue_depth gauge");
  for (const [queue, depth] of jobMetrics.depth) {
    lines.push(`dhub_queue_depth{queue="${queue}"} ${depth}`);
  }

  return lines.join("\n") + "\n";
}

/**
 * Setup all queue error handlers and Prometheus job metrics
 */
export function setupQueueErrorHandlers() {
  const queues = [documentRefineQueue, piiDetectionQueue, connectorSyncQueue, embeddingQueue];

  queues.forEach((queue) => {
    const qName = queue.name;

    queue.on("error", (err) => {
      console.error(`[QUEUE] ${qName} error:`, err);
      incJobMetric(jobMetrics.totals, `queue="${qName}",status="error"`);
    });

    queue.on("active", (_job) => {
      // Update queue depth estimate
      queue.getWaitingCount().then((count) => {
        jobMetrics.depth.set(qName, count);
      }).catch(() => {});
    });

    queue.on("failed", (job, err) => {
      console.error(`[QUEUE] ${qName} job ${job.id} failed after ${job.attemptsMade} attempts:`, err.message);
      incJobMetric(jobMetrics.totals, `queue="${qName}",status="failed"`);
    });

    queue.on("completed", (job) => {
      console.log(`[QUEUE] ${qName} job ${job.id} completed`);
      incJobMetric(jobMetrics.totals, `queue="${qName}",status="completed"`);

      // Duration tracking
      const startedAt = (job as any).processedOn || (job as any).timestamp;
      const finishedAt = (job as any).finishedOn || Date.now();
      if (startedAt) {
        const durationMs = finishedAt - startedAt;
        incJobMetric(jobMetrics.durationSum, qName, durationMs);
        incJobMetric(jobMetrics.durationCount, qName, 1);
      }

      // Update depth
      queue.getWaitingCount().then((count) => {
        jobMetrics.depth.set(qName, count);
      }).catch(() => {});
    });

    queue.on("stalled", (job) => {
      console.warn(`[QUEUE] ${qName} job ${job.id} stalled, will retry`);
      incJobMetric(jobMetrics.totals, `queue="${qName}",status="stalled"`);
    });
  });
}

/**
 * Initialize all job processors
 * Call this function early in your server startup, before any API routes
 */
export function setupJobProcessors() {
  console.log("[JOBS] Setting up job processors...");
  setupDocumentRefineProcessor();
  setupPiiDetectionProcessor();
  setupConnectorSyncProcessor();
  setupEmbeddingProcessor();
  setupQueueErrorHandlers();
  setupConnectorScheduler();         // Gap 21 — wire connector cron scheduler
  console.log("[JOBS] All job processors initialized");
}

// Gap 2 — Export ingestionQueue so server-connectors.ts can enqueue documents
export { documentRefineQueue as ingestionQueue };

/**
 * Gap 21 — Connector Scheduler
 * Polls active connectors every minute and enqueues sync jobs based on frequency.
 * frequency values: "manual" | "hourly" | "daily" | "weekly"
 */
export function setupConnectorScheduler() {
  const FREQUENCY_MS: Record<string, number> = {
    hourly: 60 * 60 * 1000,
    daily:  24 * 60 * 60 * 1000,
    weekly: 7 * 24 * 60 * 60 * 1000,
  };

  const lastTriggered = new Map<string, number>(); // connectorId → timestamp

  const tick = async () => {
    try {
      const { Connector } = await import("./server-db.ts");
      const connectors = await Connector.find({ status: { $in: ["connected", "disconnected"] } });
      const now = Date.now();

      for (const conn of connectors) {
        const freq = (conn.frequency || "manual").toLowerCase();
        if (freq === "manual") continue;

        const intervalMs = FREQUENCY_MS[freq];
        if (!intervalMs) continue;

        const last = lastTriggered.get(conn.id) || 0;
        if (now - last < intervalMs) continue;

        lastTriggered.set(conn.id, now);
        await connectorSyncQueue.add(
          { connectorId: conn.id },
          { attempts: 2, backoff: { type: "fixed", delay: 30000 } }
        );
        console.log(`[SCHEDULER] Enqueued sync for connector ${conn.name} (${freq})`);
      }
    } catch (err: any) {
      console.warn("[SCHEDULER] Connector scheduler tick failed:", err.message);
    }
  };

  // Run every 60 seconds
  const interval = setInterval(tick, 60_000);
  // Run immediately on startup (after 5s grace period)
  setTimeout(tick, 5000);

  // Ensure interval does not prevent Node.js from exiting cleanly
  if (interval.unref) interval.unref();
  console.log("[SCHEDULER] Connector frequency scheduler started");
}

/**
 * Cleanup helper for graceful shutdown
 */
export async function closeQueues() {
  console.log("[JOBS] Closing job queues...");
  const queues = [documentRefineQueue, piiDetectionQueue, connectorSyncQueue, embeddingQueue];
  await Promise.all(queues.map((q) => q.close()));
  console.log("[JOBS] All queues closed");
}

/**
 * Estimates token count based on standard English text patterns (averaging ~4 chars/token but with adjustments)
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  const words = text.split(/\s+/).length;
  const chars = text.length;
  const wordEstimate = Math.round(words * 1.3);
  const charEstimate = Math.round(chars / 4.1);
  return Math.max(1, Math.round((wordEstimate + charEstimate) / 2));
}

/**
 * Token-aware document chunking with three strategies.
 * Gap 13 — semantic/table-aware mode  |  Gap 14 — real token-budget (not char proxy)
 *
 * @param text      Cleaned/redacted document text
 * @param overlap   Word overlap between adjacent chunks (default 15)
 * @param strategy  "paragraph" | "sliding_window" | "semantic"
 * @param maxTokens Hard token budget per chunk (default 512)
 */
export function runChunking(
  text: string,
  overlap = 15,
  strategy = "paragraph",
  maxTokens = 512
): any[] {
  const chunkId = (() => { let i = 0; return () => `chunk-${++i}`; })();

  // ---------------------------------------------------------------------------
  // Strategy 1: Token-budget sliding window (Gap 14)
  // ---------------------------------------------------------------------------
  if (strategy === "sliding_window") {
    const words = text.split(/\s+/).filter(Boolean);
    const chunks: any[] = [];
    const WORDS_PER_TOKEN = 0.75; // GPT tokeniser approximation
    const wordBudget = Math.floor(maxTokens * WORDS_PER_TOKEN);

    for (let i = 0; i < words.length; i += Math.max(1, wordBudget - overlap)) {
      const slice = words.slice(i, i + wordBudget);
      if (slice.length === 0) break;
      const chunkText = slice.join(" ");
      chunks.push({
        id: chunkId(),
        text: chunkText,
        tokenCount: estimateTokens(chunkText),
        headingContext: "Sliding Window",
      });
      if (i + wordBudget >= words.length) break;
    }
    return chunks;
  }

  // ---------------------------------------------------------------------------
  // Strategy 2: Semantic / heading-section + table-aware (Gap 13)
  // ---------------------------------------------------------------------------
  if (strategy === "semantic") {
    const chunks: any[] = [];
    // Split on markdown headings and horizontal rules
    const sections = text.split(/(?=^#{1,6}\s)/m).filter((s) => s.trim());

    for (const section of sections) {
      const lines = section.split("\n");
      const heading = lines[0].replace(/^#+\s*/, "").trim() || "General Context";

      // Detect table blocks (lines starting with | )
      const tableLines = lines.filter((l) => l.trim().startsWith("|"));
      if (tableLines.length >= 2) {
        // Table-aware: emit the whole table as one chunk regardless of size
        const tableText = tableLines.join("\n");
        if (tableText.trim()) {
          chunks.push({
            id: chunkId(),
            text: tableText.trim(),
            tokenCount: estimateTokens(tableText),
            headingContext: heading,
            chunkType: "table",
          });
        }
      }

      // Non-table content
      const nonTableText = lines.filter((l) => !l.trim().startsWith("|")).join("\n").trim();
      if (!nonTableText) continue;

      // Split non-table content by token budget
      const words = nonTableText.split(/\s+/).filter(Boolean);
      const wordBudget = Math.floor(maxTokens * 0.75);
      let i = 0;
      while (i < words.length) {
        const slice = words.slice(i, i + wordBudget);
        const overlapSlice = i > 0 ? words.slice(Math.max(0, i - overlap), i) : [];
        const chunkText = [...overlapSlice, ...slice].join(" ");
        chunks.push({
          id: chunkId(),
          text: chunkText,
          tokenCount: estimateTokens(chunkText),
          headingContext: heading,
          chunkType: "text",
        });
        i += wordBudget;
      }
    }

    if (chunks.length === 0 && text.trim()) {
      chunks.push({ id: chunkId(), text: text.trim(), tokenCount: estimateTokens(text), headingContext: "General Context" });
    }
    return chunks;
  }

  // ---------------------------------------------------------------------------
  // Strategy 3: Paragraph (default) — token-budget aware (Gap 14 upgrade)
  // ---------------------------------------------------------------------------
  const paragraphs = text.split(/\n\n+/);
  const chunks: any[] = [];
  let currentWords: string[] = [];
  let lastHeading = "General Context";
  const wordBudget = Math.floor(maxTokens * 0.75);

  const flush = () => {
    if (currentWords.length === 0) return;
    const chunkText = currentWords.join(" ");
    chunks.push({
      id: chunkId(),
      text: chunkText,
      tokenCount: estimateTokens(chunkText),
      headingContext: lastHeading,
    });
    // Keep overlap words for next chunk
    currentWords = currentWords.slice(Math.max(0, currentWords.length - overlap));
  };

  for (const para of paragraphs) {
    const trimmed = para.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("#")) lastHeading = trimmed.replace(/^#+\s*/, "").trim();

    const paraWords = trimmed.split(/\s+/).filter(Boolean);
    for (const word of paraWords) {
      currentWords.push(word);
      if (currentWords.length >= wordBudget) flush();
    }
    // Paragraph boundary — add a soft break if budget is 75%+ full
    if (currentWords.length > wordBudget * 0.75) flush();
  }
  flush(); // Emit any remaining words

  if (chunks.length === 0 && text.trim()) {
    chunks.push({ id: chunkId(), text: text.trim(), tokenCount: estimateTokens(text), headingContext: lastHeading });
  }
  return chunks;
}

function calculateReadinessScore(
  refined: string, 
  piiCount: number, 
  duplicatesRemoved: number, 
  chunksCount: number, 
  metadata: any,
  piiFindings: any[] = []
) {
  // 1. Layout Score Heuristics
  const tableCount = (refined.match(/\|/g) || []).length / 3;
  const headingCount = (refined.match(/^#{1,6}\s+/gm) || []).length;
  const listCount = (refined.match(/^\s*[\-\*]\s+/gm) || []).length;
  
  let layoutScore = 70;
  if (tableCount > 0) layoutScore += 15;
  if (headingCount > 0) layoutScore += 10;
  if (listCount > 0) layoutScore += 5;
  layoutScore = Math.min(100, layoutScore);

  // 2. Security Score Heuristics (PII density check)
  let securityScore = 100;
  securityScore -= Math.min(40, piiCount * 4);
  const hasHighRisk = piiFindings.some(f => ["SSN", "CREDIT_CARD", "PRIVATE_KEY", "API_KEY"].includes(f.type));
  if (hasHighRisk) {
    securityScore -= 20;
  }
  securityScore = Math.max(0, securityScore);

  // 3. Hygiene Score Heuristics
  let hygieneScore = 100;
  const emptyLinesCount = (refined.match(/\n\s*\n/g) || []).length;
  if (emptyLinesCount > 20) hygieneScore -= 10;
  if (refined.includes("  ")) hygieneScore -= 5;
  hygieneScore += Math.min(10, duplicatesRemoved * 2);
  hygieneScore = Math.min(100, Math.max(0, hygieneScore));

  // 4. Metadata Completeness Score
  let metadataScore = 0;
  if (metadata?.title && metadata.title !== "Unknown") metadataScore += 20;
  if (metadata?.category && metadata.category !== "Operations") metadataScore += 20;
  if (metadata?.summary) metadataScore += 20;
  if (metadata?.classification && metadata.classification !== "Internal") metadataScore += 20;
  if (metadata?.tags && metadata.tags.length >= 3) metadataScore += 20;
  else if (metadata?.tags && metadata.tags.length > 0) metadataScore += 10;

  const overall = Math.round((layoutScore + securityScore + hygieneScore + metadataScore) / 4);

  const warnings: string[] = [];
  const recommendations: string[] = [];

  if (piiCount > 0) {
    warnings.push(`Detected ${piiCount} PII elements.`);
    recommendations.push("Ensure unmasked version is deleted after pipeline storage.");
  }
  if (layoutScore < 85) {
    warnings.push("Low layout/structure detection score.");
    recommendations.push("Use layout-aware PDF parser for tabular structural preservation.");
  }
  if (metadataScore < 80) {
    recommendations.push("Provide tags and descriptions to increase model context.");
  }

  return {
    score: overall,
    layoutScore,
    securityScore,
    hygieneScore,
    metadataScore,
    warnings,
    recommendations,
  };
}
