import pdfParse from "pdf-parse";
import fs from "fs";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import crypto from "crypto";

const execFileAsync = promisify(execFile);

const CELERY_ENABLED = process.env.CELERY_ENABLED === "true";
const CELERY_RESULT_TTL_MS = 120_000; // 2-minute timeout waiting for Celery result

/**
 * Dispatch a task to the Celery worker via Redis and poll for the result.
 * Node.js pushes {taskName, args, jobId} to dhub_pdf_tasks list.
 * Celery writes the result to dhub_pdf_result:<jobId>.
 *
 * Falls back to direct execFile if Redis / Celery are unavailable.
 */
async function dispatchCeleryTask(
  taskName: "parse_document" | "redact_pii" | "extract_metadata",
  args: Record<string, any>
): Promise<any> {
  const jobId = `job-${crypto.randomUUID()}`;
  const resultKey = `dhub_pdf_result:${jobId}`;

  try {
    const { createClient } = await import("redis");
    const redisUrl = process.env.REDIS_URL || `redis://${process.env.REDIS_HOST || "localhost"}:${process.env.REDIS_PORT || 6379}`;
    const client = createClient({ url: redisUrl });
    await client.connect();

    const task = JSON.stringify({ taskName, args: { ...args, job_id: jobId }, jobId });
    await client.lPush("dhub_pdf_tasks", task);

    // Poll for result
    const deadline = Date.now() + CELERY_RESULT_TTL_MS;
    while (Date.now() < deadline) {
      const raw = await client.get(resultKey);
      if (raw) {
        await client.del(resultKey);
        await client.quit();
        return JSON.parse(raw);
      }
      await new Promise((r) => setTimeout(r, 500));
    }

    await client.quit();
    throw new Error(`Celery task ${taskName}/${jobId} timed out after ${CELERY_RESULT_TTL_MS}ms`);
  } catch (err: any) {
    console.warn(`[PDF] Celery dispatch failed (${err.message}), falling back to direct exec`);
    return null; // Caller falls back to execFileAsync
  }
}

export interface PDFParseResult {
  text: string;
  pages: number;
  metadata: any;
  tables: Table[];
  images: number;
}

export interface Table {
  pageNumber: number;
  content: string[][];
  confidence: number;
}

export type SupportedDocumentType = "PDF" | "DOCX" | "XLSX" | "PPTX" | "TXT";

/**
 * Parse any supported document type.
 * - TXT: direct string conversion
 * - PDF: pdf-parse → auto-OCR fallback if empty (Gap 8)
 * - DOCX/XLSX/PPTX: native ocr_worker.py parsers (Gap 9)
 */
export async function parseDocumentBuffer(buffer: Buffer, type: SupportedDocumentType): Promise<PDFParseResult> {
  if (type === "TXT") {
    return { text: buffer.toString("utf-8"), pages: 1, metadata: {}, tables: [], images: 0 };
  }

  if (type === "PDF") {
    const parsed = await parsePDFBuffer(buffer);
    // Gap 8: Auto-trigger OCR for scanned PDFs (empty text after standard parse)
    if (!parsed.text.trim()) {
      console.log("[PDF] Empty text from pdf-parse — attempting Tesseract OCR fallback");
      return parseWithOCRWorker(buffer, "ocr");
    }
    return parsed;
  }

  // Gap 9: DOCX, XLSX, PPTX — use native ocr_worker.py parsers
  const nativeCommand = type.toLowerCase(); // "docx" | "xlsx" | "pptx"
  return parseWithOCRWorker(buffer, nativeCommand);
}

/**
 * Invoke ocr_worker.py for OCR and Office format parsing.
 * Falls back to parseWithSidecar (pdf_parser.py) if ocr_worker.py is unavailable.
 */
async function parseWithOCRWorker(buffer: Buffer, command: string, language = "en"): Promise<PDFParseResult> {
  const ext = command === "ocr" ? "pdf" : command;
  const tempFile = path.join(process.cwd(), `temp_ocr_${crypto.randomBytes(8).toString("hex")}.${ext}`);
  try {
    fs.writeFileSync(tempFile, buffer);
    const pythonPath = process.env.PYTHON_PATH || "python";
    const scriptPath = path.join(process.cwd(), "ocr_worker.py");

    if (!fs.existsSync(scriptPath)) {
      // ocr_worker.py not present — fall through to original sidecar
      return parseWithSidecar(buffer, command);
    }

    const { stdout } = await execFileAsync(pythonPath, [scriptPath, command, tempFile, language], { timeout: 120_000 });
    const result = JSON.parse(stdout);
    if (result.error) throw new Error(result.error);

    return {
      text: result.text || "",
      pages: result.pages || 1,
      metadata: result.metadata || {},
      tables: (result.tables || []).map((t: any) => ({ pageNumber: 1, content: t, confidence: 0.9 })),
      images: result.images || 0,
    };
  } catch (err: any) {
    console.warn(`[OCR Worker] ${command} failed (${err.message}), falling back to pdf_parser`);
    return parseWithSidecar(buffer, command);
  } finally {
    if (fs.existsSync(tempFile)) {
      try { fs.unlinkSync(tempFile); } catch {}
    }
  }
}

async function parseWithSidecar(buffer: Buffer, command: string): Promise<PDFParseResult> {
  const extension = command.replace("parse-", "").replace("ocr", "pdf");
  const tempFile = path.join(process.cwd(), `temp_${crypto.randomBytes(8).toString("hex")}.${extension}`);
  try {
    fs.writeFileSync(tempFile, buffer);

    // Try Celery async path first
    if (CELERY_ENABLED) {
      const celeryResult = await dispatchCeleryTask("parse_document", { file_path: tempFile });
      if (celeryResult?.success) {
        return {
          text: celeryResult.text || "",
          pages: celeryResult.pages || 1,
          metadata: celeryResult.metadata || {},
          tables: (celeryResult.tables || []).map((t: any) => ({ pageNumber: 1, content: t, confidence: 0.9 })),
          images: celeryResult.images || 0,
        };
      }
    }

    // Direct exec fallback
    const pythonPath = process.env.PYTHON_PATH || "python";
    const scriptPath = path.join(process.cwd(), "pdf_parser.py");
    const { stdout } = await execFileAsync(pythonPath, [scriptPath, command, tempFile]);
    const result = JSON.parse(stdout);
    if (result.error) throw new Error(result.error);

    return {
      text: result.text || "",
      pages: result.pages || 1,
      metadata: result.metadata || {},
      tables: (result.tables || []).map((t: any) => ({ pageNumber: 1, content: t, confidence: 0.9 })),
      images: result.images || 0,
    };
  } finally {
    if (fs.existsSync(tempFile)) {
      try { fs.unlinkSync(tempFile); } catch (err) { console.error("Failed to delete temp file:", err); }
    }
  }
}
/**
 * Parse PDF from file buffer using layout-aware Python sidecar
 */
export async function parsePDFBuffer(buffer: Buffer): Promise<PDFParseResult> {
  const tempFile = path.join(process.cwd(), `temp_${crypto.randomBytes(8).toString("hex")}.pdf`);
  try {
    fs.writeFileSync(tempFile, buffer);
    const pythonPath = process.env.PYTHON_PATH || "python";
    const scriptPath = path.join(process.cwd(), "pdf_parser.py");

    const { stdout } = await execFileAsync(pythonPath, [scriptPath, "parse", tempFile]);
    const result = JSON.parse(stdout);

    if (result.error) {
      throw new Error(result.error);
    }

    return {
      text: result.text || "",
      pages: 1, // approximate
      metadata: {},
      tables: (result.tables || []).map((t: any) => ({
        pageNumber: 1,
        content: t,
        confidence: 0.95
      })),
      images: 0
    };
  } catch (error: any) {
    console.warn("Python sidecar layout-aware parsing failed, falling back to pdf-parse:", error.message);
    try {
      const data = await pdfParse(buffer);
      return {
        text: data.text || "",
        pages: data.numpages || 1,
        metadata: data.info || {},
        tables: extractTablesFromText(data.text || ""),
        images: 0,
      };
    } catch (parseError: any) {
      console.error("pdf-parse fallback also failed:", parseError);
      throw new Error(`Failed to parse PDF: ${parseError.message}`);
    }
  } finally {
    if (fs.existsSync(tempFile)) {
      try {
        fs.unlinkSync(tempFile);
      } catch (err) {
        console.error("Failed to delete temp file:", err);
      }
    }
  }
}

/**
 * Parse PDF from file path
 */
export async function parsePDFFile(filePath: string): Promise<PDFParseResult> {
  try {
    const buffer = fs.readFileSync(filePath);
    return await parsePDFBuffer(buffer);
  } catch (error) {
    console.error("PDF file read error:", error);
    throw new Error(`Failed to read PDF file: ${error instanceof Error ? error.message : "Unknown error"}`);
  }
}

/**
 * Extract potential tables from text (heuristic-based)
 * Looks for patterns that suggest tabular data
 */
function extractTablesFromText(text: string): Table[] {
  const tables: Table[] = [];
  const lines = text.split("\n");
  let currentTable: string[][] = [];
  let inTable = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    // Check if line looks like a table row (multiple columns separated by spaces/tabs)
    if (line.includes("\t") || (line.split(/\s{2,}/).length >= 2)) {
      if (!inTable) {
        currentTable = [];
        inTable = true;
      }

      const cells = line.split(/\t|\s{2,}/).filter((cell) => cell.trim());
      if (cells.length > 1) {
        currentTable.push(cells);
      }
    } else if (inTable && line === "") {
      // End of table (empty line)
      if (currentTable.length > 0) {
        tables.push({
          pageNumber: 1, // Approximate
          content: currentTable,
          confidence: 0.5, // Heuristic confidence
        });
      }
      currentTable = [];
      inTable = false;
    }
  }

  // Push last table if exists
  if (currentTable.length > 0) {
    tables.push({
      pageNumber: 1,
      content: currentTable,
      confidence: 0.5,
    });
  }

  return tables;
}

/**
 * Extract structured sections from PDF text
 */
export function extractSections(text: string) {
  const sections: { heading: string; content: string }[] = [];

  // Heuristic: lines in all caps or with underlines are likely headings
  const lines = text.split("\n");
  let currentSection = "";
  let currentHeading = "";

  for (const line of lines) {
    const trimmed = line.trim();

    if (isLikelyHeading(trimmed)) {
      if (currentHeading && currentSection) {
        sections.push({
          heading: currentHeading,
          content: currentSection.trim(),
        });
      }
      currentHeading = trimmed;
      currentSection = "";
    } else if (currentHeading) {
      currentSection += "\n" + trimmed;
    }
  }

  if (currentHeading && currentSection) {
    sections.push({
      heading: currentHeading,
      content: currentSection.trim(),
    });
  }

  return sections;
}

function isLikelyHeading(text: string): boolean {
  if (!text) return false;

  // Criteria for likely heading:
  // 1. All capitals (with some exceptions)
  // 2. Short length (< 50 chars)
  // 3. Ends with underscores or dashes
  // 4. Numbered (1., 2., etc)

  const allCaps = /^[A-Z\s\d\W]*$/.test(text);
  const isShort = text.length < 100;
  const isNumbered = /^\d+\.\s/.test(text);
  const endsWithLine = /[\-_]{3,}/.test(text);

  return (allCaps || isNumbered) && isShort;
}

/**
 * Clean and normalize PDF text
 */
export function normalizePDFText(text: string): string {
  // Remove excessive whitespace
  let normalized = text.replace(/\s+/g, " ");

  // Remove common PDF artifacts
  normalized = normalized.replace(/\x00/g, ""); // Null bytes
  normalized = normalized.replace(/\f/g, "\n"); // Form feeds to newlines

  // Fix common OCR errors (heuristic)
  normalized = normalized.replace(/([0-9])\s([a-z])/g, "$1$2"); // Fix "5 the" -> "5the"

  return normalized.trim();
}

/**
 * Estimate reading time
 */
export function estimateReadingTime(text: string): number {
  const wordsPerMinute = 200;
  const wordCount = text.split(/\s+/).length;
  return Math.ceil(wordCount / wordsPerMinute);
}

/**
 * Get document statistics
 */
export function getDocumentStats(text: string) {
  const lines = text.split("\n").filter((l) => l.trim());
  const words = text.split(/\s+/).filter((w) => w);
  const chars = text.length;
  const paragraphs = text.split(/\n\n+/).filter((p) => p.trim());

  return {
    lineCount: lines.length,
    wordCount: words.length,
    characterCount: chars,
    paragraphCount: paragraphs.length,
    averageWordLength: (chars / words.length).toFixed(2),
    readingTimeMinutes: estimateReadingTime(text),
  };
}
