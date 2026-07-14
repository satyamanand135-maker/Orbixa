/**
 * server-connectors-extended.ts — Confluence, SharePoint, GitHub, Dropbox connectors
 * Extends server-connectors.ts with the 4 missing enterprise connectors.
 */

import crypto from "crypto";
import { syncConnector as _existingSync, ConnectorSyncResult } from "./server-connectors.ts";

// ---------------------------------------------------------------------------
// Helper: ingest text into pipeline (shared)
// ---------------------------------------------------------------------------
async function ingestText(
  tenantId: string, name: string, content: string, connectorName: string
): Promise<string> {
  const { Document } = await import("./server-db.ts");
  const { ingestionQueue } = await import("./server-jobs.ts");
  const docId = `doc-${crypto.randomUUID()}`;
  const doc = new (Document as any)({
    id: docId, tenantId, name,
    type: "TXT",
    size: `${(Buffer.byteLength(content, "utf8") / 1024).toFixed(1)} KB`,
    connector: connectorName, status: "raw", rawContent: content,
  });
  await doc.save();
  await ingestionQueue.add(
    { documentId: docId, traceId: `trace-conn-${crypto.randomUUID()}` },
    { attempts: 3, backoff: { type: "exponential", delay: 5000 } }
  );
  return docId;
}

// ---------------------------------------------------------------------------
// Confluence Connector (Cloud REST API)
// ---------------------------------------------------------------------------
export async function syncConfluenceConnector(connector: any): Promise<ConnectorSyncResult> {
  const result: ConnectorSyncResult = { filesIngested: 0, filesSkipped: 0, errors: [] };
  const baseUrl: string = connector.config?.baseUrl; // e.g. https://yourorg.atlassian.net/wiki
  const email: string = connector.config?.email || process.env.CONFLUENCE_EMAIL;
  const apiToken: string = connector.config?.apiToken || process.env.CONFLUENCE_API_TOKEN;
  const spaceKey: string = connector.config?.spaceKey || "";

  if (!baseUrl || !email || !apiToken) {
    result.errors.push("Confluence: missing baseUrl, email, or apiToken");
    return result;
  }

  const auth = Buffer.from(`${email}:${apiToken}`).toString("base64");
  const headers = { Authorization: `Basic ${auth}`, Accept: "application/json" };

  try {
    const since = connector.syncState?.lastSyncedAt
      ? new Date(connector.syncState.lastSyncedAt).toISOString()
      : "1970-01-01T00:00:00.000Z";

    const spaceFilter = spaceKey ? `&spaceKey=${spaceKey}` : "";
    const searchUrl = `${baseUrl}/rest/api/content?type=page&expand=body.storage,version&limit=50&orderby=history.lastUpdated desc${spaceFilter}`;
    const listResp = await fetch(searchUrl, { headers });

    if (!listResp.ok) {
      result.errors.push(`Confluence list failed: ${listResp.status} ${await listResp.text().then(t => t.slice(0, 200))}`);
      return result;
    }

    const data = await listResp.json() as any;

    for (const page of data.results || []) {
      const lastUpdated = page.version?.when;
      if (lastUpdated && new Date(lastUpdated) <= new Date(since)) {
        result.filesSkipped++;
        continue;
      }

      // Strip HTML tags from body.storage.value
      const raw: string = page.body?.storage?.value || "";
      const text = raw.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      if (!text) { result.filesSkipped++; continue; }

      const name = `confluence-${page.title?.replace(/[^a-z0-9]/gi, "-")}-${page.id}.txt`;
      await ingestText(connector.tenantId, name, `${page.title}\n\n${text}`, `Confluence: ${connector.name}`);
      result.filesIngested++;
    }

    connector.syncState = { ...connector.syncState, lastStatus: result.errors.length === 0 ? "success" : "partial", lastSyncedAt: new Date().toISOString() };
    await connector.save();
  } catch (err: any) {
    result.errors.push(`Confluence sync failed: ${err.message}`);
  }
  return result;
}

// ---------------------------------------------------------------------------
// SharePoint / Microsoft Graph Connector
// ---------------------------------------------------------------------------
export async function syncSharePointConnector(connector: any): Promise<ConnectorSyncResult> {
  const result: ConnectorSyncResult = { filesIngested: 0, filesSkipped: 0, errors: [] };

  const tenantId: string = connector.config?.tenantId || process.env.SHAREPOINT_TENANT_ID;
  const clientId: string = connector.config?.clientId || process.env.SHAREPOINT_CLIENT_ID;
  const clientSecret: string = connector.config?.clientSecret || process.env.SHAREPOINT_CLIENT_SECRET;
  const siteId: string = connector.config?.siteId;
  const driveId: string = connector.config?.driveId;

  if (!tenantId || !clientId || !clientSecret) {
    result.errors.push("SharePoint: missing tenantId, clientId, or clientSecret");
    return result;
  }

  try {
    // 1. Get access token via client credentials
    const tokenResp = await fetch(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: clientId,
        client_secret: clientSecret,
        scope: "https://graph.microsoft.com/.default",
      }),
    });

    if (!tokenResp.ok) {
      result.errors.push(`SharePoint token fetch failed: ${tokenResp.status}`);
      return result;
    }

    const { access_token } = await tokenResp.json() as any;
    const headers = { Authorization: `Bearer ${access_token}`, Accept: "application/json" };

    // 2. List files from drive
    const since = connector.syncState?.lastSyncedAt || "1970-01-01T00:00:00Z";
    const basePath = siteId && driveId
      ? `https://graph.microsoft.com/v1.0/sites/${siteId}/drives/${driveId}`
      : `https://graph.microsoft.com/v1.0/me/drive`;

    const listResp = await fetch(`${basePath}/root/children?$top=50&$filter=lastModifiedDateTime gt '${since}'`, { headers });
    if (!listResp.ok) {
      result.errors.push(`SharePoint list failed: ${listResp.status}`);
      return result;
    }

    const { value: files = [] } = await listResp.json() as any;

    for (const file of files) {
      if (!file["@microsoft.graph.downloadUrl"] && !file.file) { result.filesSkipped++; continue; }
      const ext = (file.name || "").split(".").pop()?.toLowerCase();
      if (!["txt", "md", "csv", "json", "html"].includes(ext || "")) { result.filesSkipped++; continue; }

      try {
        const dlResp = await fetch(file["@microsoft.graph.downloadUrl"] || `${basePath}/items/${file.id}/content`, { headers });
        if (!dlResp.ok) { result.errors.push(`SharePoint download failed: ${file.name}`); continue; }
        const content = await dlResp.text();
        await ingestText(connector.tenantId, file.name, content, `SharePoint: ${connector.name}`);
        result.filesIngested++;
      } catch (fileErr: any) {
        result.errors.push(`SharePoint file ${file.name}: ${fileErr.message}`);
      }
    }

    connector.syncState = { ...connector.syncState, lastStatus: result.errors.length === 0 ? "success" : "partial", lastSyncedAt: new Date().toISOString() };
    await connector.save();
  } catch (err: any) {
    result.errors.push(`SharePoint sync failed: ${err.message}`);
  }
  return result;
}

// ---------------------------------------------------------------------------
// GitHub Connector (REST API — repos, wikis, issues)
// ---------------------------------------------------------------------------
export async function syncGitHubConnector(connector: any): Promise<ConnectorSyncResult> {
  const result: ConnectorSyncResult = { filesIngested: 0, filesSkipped: 0, errors: [] };

  const token: string = connector.config?.token || process.env.GITHUB_TOKEN;
  const owner: string = connector.config?.owner;
  const repo: string = connector.config?.repo;
  const branch: string = connector.config?.branch || "main";
  const pathPrefix: string = connector.config?.path || "";

  if (!token || !owner || !repo) {
    result.errors.push("GitHub: missing token, owner, or repo");
    return result;
  }

  const headers = {
    Authorization: `token ${token}`,
    Accept: "application/vnd.github.v3+json",
  };

  try {
    // Get tree of repo at branch
    const treeResp = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/git/trees/${branch}?recursive=1`,
      { headers }
    );
    if (!treeResp.ok) {
      result.errors.push(`GitHub tree fetch failed: ${treeResp.status}`);
      return result;
    }

    const { tree = [] } = await treeResp.json() as any;
    const since = connector.syncState?.lastSyncedAt ? new Date(connector.syncState.lastSyncedAt) : new Date(0);

    // Get recent commits to find changed files
    const commitsResp = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/commits?sha=${branch}&since=${since.toISOString()}&per_page=50`,
      { headers }
    );
    const recentCommits = commitsResp.ok ? await commitsResp.json() as any[] : [];
    const changedPaths = new Set<string>();
    for (const commit of recentCommits) {
      const detailResp = await fetch(`https://api.github.com/repos/${owner}/${repo}/commits/${commit.sha}`, { headers });
      if (detailResp.ok) {
        const detail = await detailResp.json() as any;
        (detail.files || []).forEach((f: any) => changedPaths.add(f.filename));
      }
    }

    const textFiles = tree.filter((item: any) => {
      if (item.type !== "blob") return false;
      const ext = item.path.split(".").pop()?.toLowerCase();
      if (!["md", "txt", "rst", "adoc", "json", "yaml", "yml"].includes(ext || "")) return false;
      if (pathPrefix && !item.path.startsWith(pathPrefix)) return false;
      if (changedPaths.size > 0 && !changedPaths.has(item.path)) return false;
      return true;
    }).slice(0, 100);

    for (const file of textFiles) {
      try {
        const contentResp = await fetch(
          `https://api.github.com/repos/${owner}/${repo}/contents/${file.path}?ref=${branch}`,
          { headers }
        );
        if (!contentResp.ok) { result.errors.push(`GitHub file ${file.path}: ${contentResp.status}`); continue; }
        const fileData = await contentResp.json() as any;
        const content = Buffer.from(fileData.content || "", "base64").toString("utf8");
        if (!content.trim()) { result.filesSkipped++; continue; }
        await ingestText(connector.tenantId, `${repo}/${file.path}`, content, `GitHub: ${connector.name}`);
        result.filesIngested++;
      } catch (fileErr: any) {
        result.errors.push(`GitHub ${file.path}: ${fileErr.message}`);
      }
    }

    connector.syncState = { ...connector.syncState, lastStatus: result.errors.length === 0 ? "success" : "partial", lastSyncedAt: new Date().toISOString() };
    await connector.save();
  } catch (err: any) {
    result.errors.push(`GitHub sync failed: ${err.message}`);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Dropbox Connector
// ---------------------------------------------------------------------------
export async function syncDropboxConnector(connector: any): Promise<ConnectorSyncResult> {
  const result: ConnectorSyncResult = { filesIngested: 0, filesSkipped: 0, errors: [] };

  const accessToken: string = connector.config?.accessToken || process.env.DROPBOX_ACCESS_TOKEN;
  const folderPath: string = connector.config?.folderPath || "";

  if (!accessToken) {
    result.errors.push("Dropbox: missing accessToken");
    return result;
  }

  const headers = {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
  };

  try {
    // List folder
    const listResp = await fetch("https://api.dropboxapi.com/2/files/list_folder", {
      method: "POST",
      headers,
      body: JSON.stringify({ path: folderPath || "", recursive: true, limit: 100 }),
    });

    if (!listResp.ok) {
      result.errors.push(`Dropbox list failed: ${listResp.status} ${await listResp.text().then(t => t.slice(0, 200))}`);
      return result;
    }

    const { entries = [] } = await listResp.json() as any;
    const since = connector.syncState?.lastSyncedAt ? new Date(connector.syncState.lastSyncedAt) : new Date(0);

    for (const entry of entries) {
      if (entry[".tag"] !== "file") continue;
      if (entry.server_modified && new Date(entry.server_modified) <= since) { result.filesSkipped++; continue; }
      const ext = (entry.name || "").split(".").pop()?.toLowerCase();
      if (!["txt", "md", "csv", "json"].includes(ext || "")) { result.filesSkipped++; continue; }

      try {
        const dlResp = await fetch("https://content.dropboxapi.com/2/files/download", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Dropbox-API-Arg": JSON.stringify({ path: entry.path_lower }),
          },
        });
        if (!dlResp.ok) { result.errors.push(`Dropbox download ${entry.name}: ${dlResp.status}`); continue; }
        const content = await dlResp.text();
        await ingestText(connector.tenantId, entry.name, content, `Dropbox: ${connector.name}`);
        result.filesIngested++;
      } catch (fileErr: any) {
        result.errors.push(`Dropbox file ${entry.name}: ${fileErr.message}`);
      }
    }

    connector.syncState = { ...connector.syncState, lastStatus: result.errors.length === 0 ? "success" : "partial", lastSyncedAt: new Date().toISOString() };
    await connector.save();
  } catch (err: any) {
    result.errors.push(`Dropbox sync failed: ${err.message}`);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Extended dispatcher — wraps existing syncConnector adding new types
// ---------------------------------------------------------------------------
export async function syncConnectorExtended(connector: any): Promise<ConnectorSyncResult> {
  const type = (connector.type || "").toLowerCase().replace(/\s+/g, "-");
  switch (type) {
    case "confluence": return syncConfluenceConnector(connector);
    case "sharepoint":
    case "microsoft-sharepoint": return syncSharePointConnector(connector);
    case "github": return syncGitHubConnector(connector);
    case "dropbox": return syncDropboxConnector(connector);
    default: return _existingSync(connector);
  }
}
