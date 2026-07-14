/**
 * server-connectors.ts — Real data connector sync implementations
 *
 * Supported connectors:
 *   - Google Drive (Drive API v3 via OAuth2 token stored in connector.config)
 *   - AWS S3 (ListObjectsV2 + GetObject via AWS SDK)
 *   - Slack (Conversations + Messages export via Bot token)
 *   - Notion (Blocks API → Markdown)
 *
 * Each connector:
 *   1. Lists new/changed files since connector.syncState.lastSyncedAt
 *   2. Downloads content as text
 *   3. Creates a Document record and enqueues it into the refinement pipeline
 *
 * Scheduling:
 *   Connectors with frequency !== "manual" are triggered by server-jobs.ts
 *   setupConnectorScheduler() which runs the appropriate cron via Bull.
 *
 * Graceful degradation:
 *   If the required env vars / OAuth tokens are missing, sync logs a warning
 *   and marks the connector status as "error" without crashing the server.
 */

import crypto from "crypto";

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------
export interface ConnectorSyncResult {
  filesIngested: number;
  filesSkipped: number;
  errors: string[];
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------
function bytesToSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function getConnectorCredentials(connector: any): any {
  if (typeof connector.getDecryptedCredentials === "function") {
    return connector.getDecryptedCredentials();
  }
  return connector.credentials || {};
}

async function ingestTextContent(
  tenantId: string,
  name: string,
  content: string,
  connectorName: string,
  docType: "TXT" | "PDF" | "DOCX" | "XLSX" | "PPTX" = "TXT"
): Promise<string> {
  const { Document } = await import("./server-db.ts");
  const { ingestionQueue } = await import("./server-jobs.ts");

  const docId = `doc-${crypto.randomUUID()}`;
  const doc = new Document({
    id: docId,
    tenantId,
    name,
    type: docType,
    size: bytesToSize(Buffer.byteLength(content, "utf8")),
    connector: connectorName,
    status: "raw",
    rawContent: content,
  });
  await doc.save();

  await ingestionQueue.add(
    { documentId: docId, traceId: `trace-connector-${crypto.randomUUID()}` },
    { attempts: 3, backoff: { type: "exponential", delay: 5000 } }
  );

  return docId;
}

// ---------------------------------------------------------------------------
// Google Drive Connector
// ---------------------------------------------------------------------------
export async function syncGoogleDriveConnector(connector: any): Promise<ConnectorSyncResult> {
  const result: ConnectorSyncResult = { filesIngested: 0, filesSkipped: 0, errors: [] };

  const credentials = getConnectorCredentials(connector);
  const accessToken: string = connector.config?.accessToken || credentials.oauthToken;
  if (!accessToken) {
    result.errors.push("Google Drive access token not configured");
    return result;
  }

  try {
    const since = connector.syncState?.lastSyncedAt
      ? new Date(connector.syncState.lastSyncedAt).toISOString()
      : new Date(0).toISOString();

    // List files modified after last sync
    const listUrl = `https://www.googleapis.com/drive/v3/files?q=modifiedTime>'${since}' and mimeType!='application/vnd.google-apps.folder'&fields=files(id,name,mimeType,size,modifiedTime)&pageSize=50`;
    const listResp = await fetch(listUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!listResp.ok) {
      const err = await listResp.text();
      result.errors.push(`Drive list failed: ${listResp.status} ${err.slice(0, 200)}`);
      return result;
    }

    const { files = [] } = await listResp.json() as any;

    for (const file of files) {
      try {
        // Export Google Docs as plain text; download binary files as-is
        let exportUrl: string;
        if (file.mimeType === "application/vnd.google-apps.document") {
          exportUrl = `https://www.googleapis.com/drive/v3/files/${file.id}/export?mimeType=text/plain`;
        } else if (file.mimeType.startsWith("text/") || file.mimeType === "application/json") {
          exportUrl = `https://www.googleapis.com/drive/v3/files/${file.id}?alt=media`;
        } else {
          result.filesSkipped++;
          continue; // Binary non-text — skip
        }

        const contentResp = await fetch(exportUrl, {
          headers: { Authorization: `Bearer ${accessToken}` },
        });

        if (!contentResp.ok) {
          result.errors.push(`Drive download failed for ${file.name}: ${contentResp.status}`);
          continue;
        }

        const content = await contentResp.text();
        await ingestTextContent(connector.tenantId, file.name, content, `Google Drive: ${connector.name}`);
        result.filesIngested++;
      } catch (fileErr: any) {
        result.errors.push(`Error processing ${file.name}: ${fileErr.message}`);
      }
    }

    // Update sync state
    connector.syncState = {
      ...connector.syncState,
      lastStatus: result.errors.length === 0 ? "success" : "partial",
      lastSyncedAt: new Date().toISOString(),
      filesIngested: (connector.syncState?.filesIngested || 0) + result.filesIngested,
    };
    await connector.save();
  } catch (err: any) {
    result.errors.push(`Google Drive sync failed: ${err.message}`);
  }

  return result;
}

// ---------------------------------------------------------------------------
// AWS S3 Connector
// ---------------------------------------------------------------------------
export async function syncS3Connector(connector: any): Promise<ConnectorSyncResult> {
  const result: ConnectorSyncResult = { filesIngested: 0, filesSkipped: 0, errors: [] };

  const { bucket, prefix = "", region } = connector.config || {};
  const accessKeyId = connector.config?.accessKeyId || process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = connector.config?.secretAccessKey || process.env.AWS_SECRET_ACCESS_KEY;

  if (!bucket || !accessKeyId || !secretAccessKey) {
    result.errors.push("S3 connector missing bucket, accessKeyId, or secretAccessKey");
    return result;
  }

  try {
    // Dynamic import so the server starts without @aws-sdk installed
    const { S3Client, ListObjectsV2Command, GetObjectCommand } = await import("@aws-sdk/client-s3" as any);

    const s3 = new S3Client({
      region: region || process.env.AWS_REGION || "us-east-1",
      credentials: { accessKeyId, secretAccessKey },
    });

    const since = connector.syncState?.lastSyncedAt ? new Date(connector.syncState.lastSyncedAt) : new Date(0);

    const listCmd = new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, MaxKeys: 100 });
    const listResp = await s3.send(listCmd);

    for (const obj of listResp.Contents || []) {
      if (!obj.Key || !obj.LastModified) continue;
      if (obj.LastModified <= since) { result.filesSkipped++; continue; }

      // Only ingest text-like files
      const ext = obj.Key.split(".").pop()?.toLowerCase();
      if (!["txt", "md", "csv", "json", "xml", "html"].includes(ext || "")) {
        result.filesSkipped++;
        continue;
      }

      try {
        const getCmd = new GetObjectCommand({ Bucket: bucket, Key: obj.Key });
        const getResp = await s3.send(getCmd);
        const chunks: Uint8Array[] = [];
        for await (const chunk of getResp.Body) chunks.push(chunk);
        const content = Buffer.concat(chunks).toString("utf8");

        const name = obj.Key.split("/").pop() || obj.Key;
        await ingestTextContent(connector.tenantId, name, content, `S3: ${connector.name}`);
        result.filesIngested++;
      } catch (fileErr: any) {
        result.errors.push(`S3 object error ${obj.Key}: ${fileErr.message}`);
      }
    }

    connector.syncState = {
      ...connector.syncState,
      lastStatus: result.errors.length === 0 ? "success" : "partial",
      lastSyncedAt: new Date().toISOString(),
    };
    await connector.save();
  } catch (err: any) {
    result.errors.push(`S3 sync failed: ${err.message}`);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Slack Connector
// ---------------------------------------------------------------------------
export async function syncSlackConnector(connector: any): Promise<ConnectorSyncResult> {
  const result: ConnectorSyncResult = { filesIngested: 0, filesSkipped: 0, errors: [] };

  const credentials = getConnectorCredentials(connector);
  const botToken: string = connector.config?.botToken || credentials.oauthToken || process.env.SLACK_BOT_TOKEN;
  if (!botToken) {
    result.errors.push("Slack bot token not configured");
    return result;
  }

  const channels: string[] = connector.config?.channels || [];
  if (channels.length === 0) {
    result.errors.push("No Slack channels configured");
    return result;
  }

  try {
    const oldest = connector.syncState?.lastSyncedAt
      ? String(Math.floor(new Date(connector.syncState.lastSyncedAt).getTime() / 1000))
      : "0";

    for (const channelId of channels) {
      try {
        const histResp = await fetch(
          `https://slack.com/api/conversations.history?channel=${channelId}&oldest=${oldest}&limit=200`,
          { headers: { Authorization: `Bearer ${botToken}` } }
        );
        const data = await histResp.json() as any;

        if (!data.ok) {
          result.errors.push(`Slack API error for channel ${channelId}: ${data.error}`);
          continue;
        }

        const messages: string[] = (data.messages || [])
          .filter((m: any) => m.type === "message" && m.text)
          .map((m: any) => `[${new Date(Number(m.ts) * 1000).toISOString()}] ${m.text}`);

        if (messages.length === 0) { result.filesSkipped++; continue; }

        const content = messages.join("\n");
        const name = `slack-${channelId}-${new Date().toISOString().slice(0, 10)}.txt`;
        await ingestTextContent(connector.tenantId, name, content, `Slack: ${connector.name}`);
        result.filesIngested++;
      } catch (chanErr: any) {
        result.errors.push(`Slack channel ${channelId}: ${chanErr.message}`);
      }
    }

    connector.syncState = {
      ...connector.syncState,
      lastStatus: result.errors.length === 0 ? "success" : "partial",
      lastSyncedAt: new Date().toISOString(),
    };
    await connector.save();
  } catch (err: any) {
    result.errors.push(`Slack sync failed: ${err.message}`);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Notion Connector
// ---------------------------------------------------------------------------
export async function syncNotionConnector(connector: any): Promise<ConnectorSyncResult> {
  const result: ConnectorSyncResult = { filesIngested: 0, filesSkipped: 0, errors: [] };

  const credentials = getConnectorCredentials(connector);
  const apiKey: string = connector.config?.apiKey || credentials.oauthToken || process.env.NOTION_API_KEY;
  const databaseId: string = connector.config?.databaseId;

  if (!apiKey) {
    result.errors.push("Notion API key not configured");
    return result;
  }

  const headers = {
    Authorization: `Bearer ${apiKey}`,
    "Notion-Version": "2022-06-28",
    "Content-Type": "application/json",
  };

  try {
    // If databaseId provided, query the database; otherwise list search
    let pageIds: string[] = [];

    if (databaseId) {
      const filterDate = connector.syncState?.lastSyncedAt || "2000-01-01";
      const dbResp = await fetch(`https://api.notion.com/v1/databases/${databaseId}/query`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          filter: { property: "Last edited time", last_edited_time: { after: filterDate } },
          page_size: 50,
        }),
      });
      const dbData = await dbResp.json() as any;
      pageIds = (dbData.results || []).map((p: any) => p.id);
    } else {
      // Search for recently edited pages
      const searchResp = await fetch("https://api.notion.com/v1/search", {
        method: "POST",
        headers,
        body: JSON.stringify({ filter: { property: "object", value: "page" }, page_size: 50 }),
      });
      const searchData = await searchResp.json() as any;
      pageIds = (searchData.results || []).map((p: any) => p.id);
    }

    for (const pageId of pageIds) {
      try {
        // Fetch page blocks
        const blocksResp = await fetch(`https://api.notion.com/v1/blocks/${pageId}/children?page_size=100`, {
          headers,
        });
        const blocksData = await blocksResp.json() as any;

        // Convert blocks to plain text
        const lines: string[] = [];
        for (const block of blocksData.results || []) {
          const rich = block[block.type]?.rich_text || [];
          const text = rich.map((r: any) => r.plain_text).join("");
          if (text) lines.push(text);
        }

        if (lines.length === 0) { result.filesSkipped++; continue; }

        const content = lines.join("\n");
        const name = `notion-${pageId}-${new Date().toISOString().slice(0, 10)}.txt`;
        await ingestTextContent(connector.tenantId, name, content, `Notion: ${connector.name}`);
        result.filesIngested++;
      } catch (pageErr: any) {
        result.errors.push(`Notion page ${pageId}: ${pageErr.message}`);
      }
    }

    connector.syncState = {
      ...connector.syncState,
      lastStatus: result.errors.length === 0 ? "success" : "partial",
      lastSyncedAt: new Date().toISOString(),
    };
    await connector.save();
  } catch (err: any) {
    result.errors.push(`Notion sync failed: ${err.message}`);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Dispatcher — routes to the correct sync function by type
// ---------------------------------------------------------------------------
export async function syncConnector(connector: any): Promise<ConnectorSyncResult> {
  const type: string = (connector.type || "").toLowerCase().replace(/\s+/g, "-");

  connector.status = "syncing";
  await connector.save().catch(() => {});

  let result: ConnectorSyncResult;

  try {
    switch (type) {
      case "google-drive":
      case "google drive":
        result = await syncGoogleDriveConnector(connector);
        break;
      case "s3":
      case "aws-s3":
        result = await syncS3Connector(connector);
        break;
      case "slack":
        result = await syncSlackConnector(connector);
        break;
      case "notion":
        result = await syncNotionConnector(connector);
        break;
      default:
        result = { filesIngested: 0, filesSkipped: 0, errors: [`Unknown connector type: ${connector.type}`] };
    }
  } catch (err: any) {
    result = { filesIngested: 0, filesSkipped: 0, errors: [err.message] };
  }

  connector.status = result.errors.length > 0 && result.filesIngested === 0 ? "error" : "connected";
  await connector.save().catch(() => {});

  console.log(
    `[Connector] ${connector.name} (${connector.type}) sync: +${result.filesIngested} files, ${result.errors.length} errors`
  );

  return result;
}
