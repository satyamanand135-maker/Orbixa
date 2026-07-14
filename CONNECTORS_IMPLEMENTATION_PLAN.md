# Connectors gap remediation — implementation notes

Scope implemented in this PR/iteration:
- Google Drive + GitHub: OAuth 2.0 (start + callback) + token storage in encrypted Connector.credentials
- Google Drive + GitHub: scheduled/manual sync enqueueing + real ingestion of remote files into Document records
- Incremental sync: ETag/modifiedAt checkpointing (provider-specific), skip unchanged, delete removed
- Frontend: replace ConnectorsView mock with API-backed UI calling real endpoints

Non-goals (for later PRs):
- Notion/SharePoint/Confluence/Slack/S3 fully wired. Only UI/API scaffolding stubs.

Key integration points in current codebase:
- Frontend: `src/components/ConnectorsView.tsx`
- Backend: `server.ts` (Express routes)
- OAuth helper: `server-oauth.ts`
- Connector sync background worker: `server-jobs.ts` (`setupConnectorSyncProcessor`)
- Data models: `server-db.ts` (`Connector` / `Document` / `AuditLog`)
- Background jobs: Bull queues in `server-queue.ts` (connectorSyncQueue)

Planned backend endpoints:
- GET  /api/connectors (tenant-scoped)
- GET  /api/connectors/:connectorId/oauth/start (redirect to provider auth)
- GET  /api/connectors/:connectorId/oauth/callback (exchange code -> tokens -> store in Connector)
- POST /api/connectors/:connectorId/config (sync schedule, provider scope)
- POST /api/connectors/:connectorId/sync (manual enqueue connectorSyncQueue)

Incremental sync checkpointing:
- Add DB fields:
  - Connector.syncCheckpoint: { lastSyncAt, providerFileStates[] }
  - or a separate ConnectorFile model (preferred for deletion detection)
- During sync:
  - list files/folders
  - compare provider etag/modified timestamp
  - unchanged -> skip
  - changed -> download and upsert Document
  - removed -> delete Document and ensure vector index deletion

Important: this repo currently lacks provider listing/downloading implementations.

