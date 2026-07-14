# Connectors work log (dHub)

## Status
- OAuth start/callback endpoints: PARTIAL (OAuth helpers exist; provider-specific routes still need full production flows)
- Google Drive/GitHub/S3-style ingestion: PARTIAL (generic connector manifest ingestion is implemented via `config.sourceFiles`)
- Scheduled sync: IMPLEMENTED (Bull repeat jobs through `/api/connectors/:id/schedule`)
- Incremental sync: IMPLEMENTED (checksum, ETag, modifiedAt, and deletion state stored in `Connector.syncState.files`)
- Frontend wiring: NOT implemented (UI is still mock-first; backend routes are available)

## Backend added
- `GET /api/connectors` lists tenant-scoped connectors.
- `POST /api/connectors` creates a tenant-scoped connector and optionally schedules sync.
- `POST /api/connectors/:id/sync` queues an immediate connector sync.
- `POST /api/connectors/:id/schedule` schedules hourly/daily/weekly connector sync.
- Connector sync worker creates/updates/skips/deletes documents based on source fingerprints.

## Related remediation
- Pluggable embedding providers added in `embedding-providers.ts`.
- Document parser now supports PDF/TXT and sidecar hooks for DOCX/XLSX/PPTX/OCR.
- Migration and backup scripts added: `npm run db:migrate`, `npm run db:backup`.

## Remaining
- Wire the React connectors UI to the new backend endpoints.
- Replace manifest-based connector ingestion with provider-specific API clients where needed.
- Add production S3/R2 signed upload and object lifecycle policies.