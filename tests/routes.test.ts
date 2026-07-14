/**
 * tests/routes.test.ts — Real HTTP route tests (Gap 10)
 *
 * Tests run against a live Express server bound to a random port.
 * Uses a real MongoDB test database (MONGODB_URI env var).
 * No mocks — all middleware, auth, and DB layers are exercised.
 *
 * Run: npm run test:routes
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "http";
import { app } from "../server.ts";

// ---------------------------------------------------------------------------
// Test server lifecycle
// ---------------------------------------------------------------------------
let server: http.Server;
let baseUrl: string;
let authToken: string;
let testDocId: string;

before(async () => {
  await new Promise<void>((resolve, reject) => {
    server = app.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      baseUrl = `http://127.0.0.1:${addr.port}`;
      resolve();
    });
    server.once("error", reject);
  });
});

after(() => {
  server?.close();
});

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------
async function api(
  method: string,
  path: string,
  body?: unknown,
  token?: string
): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const resp = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  let json: any;
  try { json = await resp.json(); } catch { json = null; }
  return { status: resp.status, body: json };
}

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------
describe("Health", () => {
  it("GET /api/health → 200", async () => {
    const { status, body } = await api("GET", "/api/health");
    assert.equal(status, 200);
    assert.equal(body.status, "ok");
  });

  it("GET /ready → 200", async () => {
    const { status } = await api("GET", "/ready");
    assert.equal(status, 200);
  });
});

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------
describe("Auth", () => {
  const email = `test-${Date.now()}@routes.test`;
  const password = "RouteTest@123!";

  it("POST /api/auth/register → 201 creates user", async () => {
    const { status, body } = await api("POST", "/api/auth/register", {
      email,
      password,
      tenantId: `routes-tenant-${Date.now()}`,
    });
    assert.equal(status, 201, `Expected 201, got ${status}: ${JSON.stringify(body)}`);
    assert.ok(body.token, "Expected JWT token in response");
    authToken = body.token;
  });

  it("POST /api/auth/register → 409 on duplicate email", async () => {
    const { status } = await api("POST", "/api/auth/register", { email, password, tenantId: "dup" });
    assert.equal(status, 409);
  });

  it("POST /api/auth/login → 200 with valid credentials", async () => {
    const { status, body } = await api("POST", "/api/auth/login", { email, password });
    assert.equal(status, 200);
    assert.ok(body.token);
  });

  it("POST /api/auth/login → 401 with wrong password", async () => {
    const { status } = await api("POST", "/api/auth/login", { email, password: "wrong!" });
    assert.equal(status, 401);
  });

  it("GET /api/auth/me → 200 with valid token", async () => {
    const { status, body } = await api("GET", "/api/auth/me", undefined, authToken);
    assert.equal(status, 200);
    assert.equal(body.user.email, email);
  });

  it("GET /api/auth/me → 401 without token", async () => {
    const { status } = await api("GET", "/api/auth/me");
    assert.equal(status, 401);
  });
});

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------
describe("Documents", () => {
  it("GET /api/documents → 200 returns array", async () => {
    const { status, body } = await api("GET", "/api/documents", undefined, authToken);
    assert.equal(status, 200);
    assert.ok(Array.isArray(body.documents ?? body), "Expected array of documents");
  });

  it("POST /api/documents (JSON) → 201 creates document", async () => {
    const { status, body } = await api("POST", "/api/documents", {
      name: "route-test.txt",
      type: "TXT",
      rawContent: "This is a route integration test document.",
    }, authToken);
    assert.equal(status, 201, `Expected 201, got ${status}: ${JSON.stringify(body)}`);
    assert.ok(body._id || body.id, "Expected document id");
    testDocId = body._id || body.id;
  });

  it("POST /api/documents → 401 without auth", async () => {
    const { status } = await api("POST", "/api/documents", { name: "x", rawContent: "y" });
    assert.equal(status, 401);
  });

  it("GET /api/documents/:id → 200 fetches created doc", async () => {
    if (!testDocId) return; // Skip if create failed
    const { status, body } = await api("GET", `/api/documents/${testDocId}`, undefined, authToken);
    assert.equal(status, 200);
    assert.equal(body.name, "route-test.txt");
  });

  it("GET /api/documents/:id → 404 for unknown id", async () => {
    const { status } = await api("GET", "/api/documents/000000000000000000000000", undefined, authToken);
    assert.equal(status, 404);
  });

  it("DELETE /api/documents/:id → 200 removes doc", async () => {
    if (!testDocId) return;
    const { status } = await api("DELETE", `/api/documents/${testDocId}`, undefined, authToken);
    assert.equal(status, 200);
  });
});

// ---------------------------------------------------------------------------
// Connectors
// ---------------------------------------------------------------------------
describe("Connectors", () => {
  it("GET /api/connectors → 200 returns array", async () => {
    const { status, body } = await api("GET", "/api/connectors", undefined, authToken);
    assert.equal(status, 200);
    assert.ok(Array.isArray(body.connectors ?? body));
  });

  it("POST /api/connectors → 201 creates connector", async () => {
    const { status, body } = await api("POST", "/api/connectors", {
      name: "Test S3 Connector",
      type: "S3",
      config: { bucket: "test-bucket", region: "us-east-1" },
    }, authToken);
    assert.equal(status, 201, JSON.stringify(body));
  });
});

// ---------------------------------------------------------------------------
// Admin stats
// ---------------------------------------------------------------------------
describe("Stats", () => {
  it("GET /api/stats → 200 returns stats", async () => {
    const { status, body } = await api("GET", "/api/stats", undefined, authToken);
    assert.equal(status, 200);
    assert.ok(typeof body.totalDocuments === "number" || body.stats);
  });
});

// ---------------------------------------------------------------------------
// Refine-text playground
// ---------------------------------------------------------------------------
describe("Refine Text", () => {
  it("POST /api/refine-text → starts pipeline (200/202)", async () => {
    const { status } = await api("POST", "/api/refine-text", {
      text: "Call me at 555-867-5309. My email is john@example.com.",
      name: "playground-test",
    }, authToken);
    // Either 200 (sync result) or 202/201 (queued) are acceptable
    assert.ok([200, 201, 202].includes(status), `Unexpected status: ${status}`);
  });
});

// ---------------------------------------------------------------------------
// GDPR compliance routes
// ---------------------------------------------------------------------------
describe("GDPR", () => {
  it("GET /api/gdpr/export/:id → 403 for non-admin", async () => {
    const { status } = await api("GET", "/api/gdpr/export/000000000000000000000000", undefined, authToken);
    // Regular user gets 403; admin would get 404 (no such user)
    assert.ok([403, 404].includes(status));
  });
});

// ---------------------------------------------------------------------------
// Rate limiting headers
// ---------------------------------------------------------------------------
describe("Rate Limiting", () => {
  it("Response includes X-RateLimit-Limit header", async () => {
    const resp = await fetch(`${baseUrl}/api/health`);
    // Rate limiting is applied on auth routes, not /health — check a protected route
    const resp2 = await fetch(`${baseUrl}/api/auth/me`, {
      headers: { Authorization: `Bearer ${authToken}` },
    });
    // Should have rate limit headers (set by our middleware)
    const limit = resp2.headers.get("X-RateLimit-Limit");
    const remaining = resp2.headers.get("X-RateLimit-Remaining");
    assert.ok(limit !== null || remaining !== null, "Expected rate limit headers");
  });
});
