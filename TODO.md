# TODO: Connectors gaps remediation

## Step 1 — Baseline verification
- [x] Add checklist of current connector-related endpoints (manual sync, OAuth start/callback, job processor)
- [x] Confirm DB connector schema + where credentials/token storage should live

Notes:
- Current connector flows are mocked: `ConnectorsView.tsx` simulates sync.
- Backend has OAuth helpers (`server-oauth.ts`) but not integrated into connector endpoints/UI.
- Connector sync processor is placeholder (`server-jobs.ts`), no file listing/ingestion.
- Incremental sync/change detection is not implemented.


## Step 2 — OAuth (Google + GitHub)
- [ ] Extend `server-oauth.ts` with OAuth state/nonce, PKCE option (scaffold), and provider list
- [ ] Add `GET /api/connectors/:connectorId/oauth/start` to redirect to provider consent
- [ ] Add `GET /api/connectors/:connectorId/oauth/callback` to exchange code + store encrypted tokens

## Step 3 — Connector sync engine
- [ ] Implement real file listing + download for Google Drive (read-only) and GitHub repos (contents)
- [ ] Implement job processor to create/refresh `Document` records
- [ ] Implement manual `POST /api/connectors/:connectorId/sync` endpoint

## Step 4 — Incremental sync
- [ ] Add DB checkpointing for each connector file (etag/hash/modifiedAt)
  - Add providerFileId -> etag/modifiedAt mapping (key/value) on Connector for now
  - Keep implementation extensible for later migration to a ConnectorFileState model
- [ ] Skip unchanged files; update changed files; delete removed files from index


## Step 5 — Scheduled sync + webhook trigger
- [ ] Add scheduler loop to enqueue connector sync jobs per connector config
- [ ] Add webhook intake endpoint (generic HMAC verification) to enqueue sync

## Step 6 — Frontend wiring
- [ ] Replace mock ConnectorsView with API-driven list
- [ ] Add Connect button to start OAuth (Google/GitHub)
- [ ] Add Sync Now button to call manual sync endpoint

## Step 7 — Testing
- [ ] Run tests
- [ ] Smoke test end-to-end: OAuth → connect → sync → refine pipeline

