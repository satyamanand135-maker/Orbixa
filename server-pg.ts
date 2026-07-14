/**
 * server-pg.ts — PostgreSQL connection pool with tenant Row-Level Security
 *
 * Every query is executed within a transaction that first sets:
 *   SET LOCAL app.tenant_id = '<tenantId>';
 * This enables PostgreSQL RLS policies to enforce tenant isolation at
 * the database level — no application-level WHERE clause can be forgotten.
 *
 * Usage:
 *   import { pgQuery, pgTransaction } from "./server-pg.ts";
 *
 *   // Single query with automatic tenant context
 *   const rows = await pgQuery("SELECT * FROM documents WHERE status = $1", ["refined"], "tenant-123");
 *
 *   // Transaction
 *   await pgTransaction("tenant-123", async (client) => {
 *     await client.query("INSERT INTO documents ...", [...]);
 *     await client.query("INSERT INTO audit_logs ...", [...]);
 *   });
 *
 * Falls back to no-op if DATABASE_URL is not set (MongoDB path continues to work).
 */

import { logStructured } from "./server-observability.ts";

// ---------------------------------------------------------------------------
// Dynamic pg import (avoids hard dependency when DATABASE_URL is absent)
// ---------------------------------------------------------------------------
type PgPool = any;
type PgClient = any;

let _pool: PgPool | null = null;
const DATABASE_URL = process.env.DATABASE_URL;

export const pgEnabled = !!DATABASE_URL;

async function getPool(): Promise<PgPool | null> {
  if (!DATABASE_URL) return null;
  if (_pool) return _pool;

  try {
    const { Pool } = await import("pg" as any);
    _pool = new Pool({
      connectionString: DATABASE_URL,
      max: 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
      ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: true } : false,
    });

    _pool.on("error", (err: any) => {
      logStructured("error", "PostgreSQL pool error", { error: err.message });
    });

    // Verify connectivity
    const testClient = await _pool.connect();
    await testClient.query("SELECT 1");
    testClient.release();
    logStructured("info", "PostgreSQL pool connected", { url: DATABASE_URL.replace(/:\/\/[^@]+@/, "://<redacted>@") });

    return _pool;
  } catch (err: any) {
    logStructured("error", "PostgreSQL pool initialization failed", { error: err.message });
    _pool = null;
    return null;
  }
}

// ---------------------------------------------------------------------------
// Core query helper with automatic RLS tenant context
// ---------------------------------------------------------------------------

/**
 * Execute a parameterized query within the tenant RLS context.
 * @param sql   The SQL query string with $1, $2, ... placeholders
 * @param params Query parameters
 * @param tenantId  Tenant ID to set in app.tenant_id (enables RLS)
 */
export async function pgQuery<T = any>(
  sql: string,
  params: any[] = [],
  tenantId?: string
): Promise<T[]> {
  const pool = await getPool();
  if (!pool) return [];

  const client: PgClient = await pool.connect();
  try {
    if (tenantId) {
      // Set RLS context — LOCAL scope so it's reset after the transaction
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    }

    const result = await client.query(sql, params);

    if (tenantId) await client.query("COMMIT");

    return result.rows as T[];
  } catch (err: any) {
    if (tenantId) {
      try { await client.query("ROLLBACK"); } catch {}
    }
    logStructured("error", "PostgreSQL query failed", { sql: sql.slice(0, 100), error: err.message });
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Execute multiple queries in a single ACID transaction with tenant RLS context.
 * The callback receives a pg Client with the tenant context already set.
 */
export async function pgTransaction<T = void>(
  tenantId: string,
  fn: (client: PgClient) => Promise<T>
): Promise<T | null> {
  const pool = await getPool();
  if (!pool) return null;

  const client: PgClient = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err: any) {
    try { await client.query("ROLLBACK"); } catch {}
    logStructured("error", "PostgreSQL transaction failed", { tenantId, error: err.message });
    throw err;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Schema migrations runner
// ---------------------------------------------------------------------------

export async function runPgMigrations(): Promise<void> {
  const pool = await getPool();
  if (!pool) {
    logStructured("info", "PostgreSQL not configured — skipping migrations");
    return;
  }

  const client: PgClient = await pool.connect();
  try {
    // Create migrations tracking table
    await client.query(`
      CREATE TABLE IF NOT EXISTS _pg_migrations (
        id SERIAL PRIMARY KEY,
        filename TEXT UNIQUE NOT NULL,
        applied_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Read and apply migration files
    const { readdir, readFile } = await import("fs/promises");
    const { join } = await import("path");
    const migrationsDir = join(process.cwd(), "migrations", "pg");

    let files: string[] = [];
    try {
      files = (await readdir(migrationsDir)).filter((f) => f.endsWith(".sql")).sort();
    } catch {
      logStructured("warn", "No PostgreSQL migrations directory found", { path: migrationsDir });
      return;
    }

    for (const file of files) {
      const { rows } = await client.query(
        "SELECT id FROM _pg_migrations WHERE filename = $1",
        [file]
      );
      if (rows.length > 0) continue; // Already applied

      const sql = await readFile(join(migrationsDir, file), "utf8");
      logStructured("info", `Applying migration: ${file}`);
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO _pg_migrations (filename) VALUES ($1)", [file]);
        await client.query("COMMIT");
        logStructured("info", `Migration applied: ${file}`);
      } catch (err: any) {
        await client.query("ROLLBACK");
        logStructured("error", `Migration failed: ${file}`, { error: err.message });
        throw err;
      }
    }
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------
export async function closePgPool(): Promise<void> {
  if (_pool) {
    await _pool.end();
    _pool = null;
    logStructured("info", "PostgreSQL pool closed");
  }
}

// ---------------------------------------------------------------------------
// Gap 5 — Dual-write helpers
// Every MongoDB write also calls these to keep PostgreSQL as the query-primary.
// All operations are fire-and-forget: PG failure never blocks the Mongo path.
// ---------------------------------------------------------------------------

/** Upsert a document record into PostgreSQL (metadata only — no raw content). */
export async function pgUpsertDocument(doc: {
  mongoId: string; tenantId: string; name: string; type: string;
  status: string; sizeBytes?: number; connector?: string;
  readinessScore?: any; piiFindingsCount?: number; chunksCount?: number; vectorSynced?: boolean;
}): Promise<void> {
  const pool = await getPool();
  if (!pool) return;
  try {
    await pgQuery(
      `INSERT INTO documents
         (mongo_id, tenant_id, name, type, status, size_bytes, connector,
          readiness_score, pii_findings_count, chunks_count, vector_synced)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (mongo_id) DO UPDATE SET
         status = EXCLUDED.status,
         readiness_score = EXCLUDED.readiness_score,
         pii_findings_count = EXCLUDED.pii_findings_count,
         chunks_count = EXCLUDED.chunks_count,
         vector_synced = EXCLUDED.vector_synced,
         updated_at = NOW()`,
      [
        doc.mongoId, doc.tenantId, doc.name, doc.type, doc.status,
        doc.sizeBytes ?? 0, doc.connector ?? null,
        doc.readinessScore ? JSON.stringify(doc.readinessScore) : null,
        doc.piiFindingsCount ?? 0, doc.chunksCount ?? 0, doc.vectorSynced ?? false,
      ],
      doc.tenantId
    );
  } catch (err: any) {
    logStructured("warn", "[PG] pgUpsertDocument failed (non-fatal)", { mongoId: doc.mongoId, error: err.message });
  }
}

/** Upsert an organization record into PostgreSQL. */
export async function pgUpsertOrganization(org: {
  tenantId: string;
  name: string;
  plan?: string;
  storageUsedBytes?: number;
  storageQuotaBytes?: number;
  refinementCount?: number;
  stripeCustomerId?: string;
  subscriptionStatus?: string;
  retentionDays?: number;
  ipAllowlist?: string[];
  locale?: string;
}): Promise<void> {
  const pool = await getPool();
  if (!pool) return;
  try {
    await pgQuery(
      `INSERT INTO organizations (
        tenant_id, name, plan, storage_used_bytes, storage_quota_bytes,
        refinement_count, stripe_customer_id, subscription_status,
        retention_days, ip_allowlist, locale
      )
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (tenant_id) DO UPDATE SET
         name = EXCLUDED.name,
         plan = EXCLUDED.plan,
         storage_used_bytes = EXCLUDED.storage_used_bytes,
         storage_quota_bytes = EXCLUDED.storage_quota_bytes,
         refinement_count = EXCLUDED.refinement_count,
         stripe_customer_id = COALESCE(EXCLUDED.stripe_customer_id, organizations.stripe_customer_id),
         subscription_status = EXCLUDED.subscription_status,
         retention_days = EXCLUDED.retention_days,
         ip_allowlist = EXCLUDED.ip_allowlist,
         locale = EXCLUDED.locale,
         updated_at = NOW()`,
      [
        org.tenantId, org.name, org.plan ?? "free",
        org.storageUsedBytes ?? 0, org.storageQuotaBytes ?? 104857600,
        org.refinementCount ?? 0, org.stripeCustomerId ?? null, org.subscriptionStatus ?? "inactive",
        org.retentionDays ?? 0, org.ipAllowlist ?? [], org.locale ?? "en"
      ],
      org.tenantId
    );
  } catch (err: any) {
    logStructured("warn", "[PG] pgUpsertOrganization failed (non-fatal)", { tenantId: org.tenantId, error: err.message });
  }
}

/** Get organization from PostgreSQL. */
export async function pgGetOrganization(tenantId: string): Promise<any> {
  try {
    const rows = await pgQuery("SELECT * FROM organizations WHERE tenant_id = $1 LIMIT 1", [tenantId], tenantId);
    return rows[0] || null;
  } catch (err: any) {
    logStructured("error", "[PG] pgGetOrganization failed", { tenantId, error: err.message });
    return null;
  }
}

/** Upsert a user record into PostgreSQL. */
export async function pgUpsertUser(user: {
  email: string;
  passwordHash: string;
  tenantId: string;
  role: string;
  mongoId: string;
}): Promise<void> {
  const pool = await getPool();
  if (!pool) return;
  try {
    await pgQuery(
      `INSERT INTO users (mongo_id, tenant_id, email, password_hash, role)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (mongo_id) DO UPDATE SET
         email = EXCLUDED.email,
         password_hash = EXCLUDED.password_hash,
         role = EXCLUDED.role,
         updated_at = NOW()`,
      [user.mongoId, user.tenantId, user.email, user.passwordHash, user.role],
      user.tenantId
    );
  } catch (err: any) {
    logStructured("warn", "[PG] pgUpsertUser failed (non-fatal)", { email: user.email, error: err.message });
  }
}

/** Get user by email from PostgreSQL. */
export async function pgGetUserByEmail(email: string): Promise<any> {
  try {
    const pool = await getPool();
    if (!pool) return null;
    const res = await pool.query("SELECT * FROM users WHERE email = $1 LIMIT 1", [email]);
    return res.rows[0] || null;
  } catch (err: any) {
    logStructured("error", "[PG] pgGetUserByEmail failed", { email, error: err.message });
    return null;
  }
}

/** Get user by ID from PostgreSQL. */
export async function pgGetUserById(id: string, tenantId: string): Promise<any> {
  try {
    const rows = await pgQuery("SELECT * FROM users WHERE id = $1 OR mongo_id = $1 LIMIT 1", [id], tenantId);
    return rows[0] || null;
  } catch (err: any) {
    logStructured("error", "[PG] pgGetUserById failed", { id, error: err.message });
    return null;
  }
}

/** Get list of documents from PostgreSQL. */
export async function pgGetDocuments(tenantId: string): Promise<any[]> {
  try {
    return await pgQuery("SELECT * FROM documents ORDER BY created_at DESC", [], tenantId);
  } catch (err: any) {
    logStructured("error", "[PG] pgGetDocuments failed", { tenantId, error: err.message });
    return [];
  }
}

/** Get single document from PostgreSQL. */
export async function pgGetDocumentById(id: string, tenantId: string): Promise<any> {
  try {
    const rows = await pgQuery("SELECT * FROM documents WHERE id = $1 OR mongo_id = $1 LIMIT 1", [id], tenantId);
    return rows[0] || null;
  } catch (err: any) {
    logStructured("error", "[PG] pgGetDocumentById failed", { id, error: err.message });
    return null;
  }
}

/** Delete a document from PostgreSQL. */
export async function pgDeleteDocument(id: string, tenantId: string): Promise<void> {
  try {
    await pgQuery("DELETE FROM documents WHERE id = $1 OR mongo_id = $1", [id], tenantId);
  } catch (err: any) {
    logStructured("error", "[PG] pgDeleteDocument failed", { id, error: err.message });
  }
}

/** Get list of connectors from PostgreSQL. */
export async function pgGetConnectors(tenantId: string): Promise<any[]> {
  try {
    return await pgQuery("SELECT * FROM connectors ORDER BY updated_at DESC", [], tenantId);
  } catch (err: any) {
    logStructured("error", "[PG] pgGetConnectors failed", { tenantId, error: err.message });
    return [];
  }
}

/** Get single connector from PostgreSQL. */
export async function pgGetConnectorById(id: string, tenantId: string): Promise<any> {
  try {
    const rows = await pgQuery("SELECT * FROM connectors WHERE id = $1 OR mongo_id = $1 LIMIT 1", [id], tenantId);
    return rows[0] || null;
  } catch (err: any) {
    logStructured("error", "[PG] pgGetConnectorById failed", { id, error: err.message });
    return null;
  }
}

/** Upsert a connector into PostgreSQL. */
export async function pgUpsertConnector(conn: {
  mongoId: string;
  tenantId: string;
  name: string;
  type: string;
  status: string;
  frequency?: string;
  filesCount?: number;
}): Promise<void> {
  const pool = await getPool();
  if (!pool) return;
  try {
    await pgQuery(
      `INSERT INTO connectors (mongo_id, tenant_id, name, type, status, frequency, files_count)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (mongo_id) DO UPDATE SET
         name = EXCLUDED.name,
         status = EXCLUDED.status,
         frequency = EXCLUDED.frequency,
         files_count = EXCLUDED.files_count,
         updated_at = NOW()`,
      [
        conn.mongoId, conn.tenantId, conn.name, conn.type, conn.status,
        conn.frequency ?? "manual", conn.filesCount ?? 0
      ],
      conn.tenantId
    );
  } catch (err: any) {
    logStructured("warn", "[PG] pgUpsertConnector failed (non-fatal)", { mongoId: conn.mongoId, error: err.message });
  }
}

/** Delete a connector from PostgreSQL. */
export async function pgDeleteConnector(id: string, tenantId: string): Promise<void> {
  try {
    await pgQuery("DELETE FROM connectors WHERE id = $1 OR mongo_id = $1", [id], tenantId);
  } catch (err: any) {
    logStructured("error", "[PG] pgDeleteConnector failed", { id, error: err.message });
  }
}

/** Append an immutable audit log entry to PostgreSQL. */
export async function pgInsertAuditLog(entry: {
  tenantId: string; userId?: string; action: string;
  resource: string; resourceId?: string; changes?: any;
  ipAddress?: string; userAgent?: string;
}): Promise<void> {
  const pool = await getPool();
  if (!pool) return;
  try {
    await pgQuery(
      `INSERT INTO audit_logs (tenant_id, user_id, action, resource, resource_id, changes, ip_address, user_agent)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        entry.tenantId, entry.userId ?? null, entry.action,
        entry.resource, entry.resourceId ?? null,
        entry.changes ? JSON.stringify(entry.changes) : null,
        entry.ipAddress ?? null, entry.userAgent ?? null,
      ],
      entry.tenantId
    );
  } catch (err: any) {
    logStructured("warn", "[PG] pgInsertAuditLog failed (non-fatal)", { tenantId: entry.tenantId, error: err.message });
  }
}
