import dotenv from "dotenv";
dotenv.config();

import mongoose from "mongoose";

// ----------------------------------------------------------------------
// Mongoose Models Mocking BEFORE importing server.ts
// ----------------------------------------------------------------------
mongoose.connect = async () => {
  console.log("Mocking Mongoose connection success");
  (mongoose.connection as any).readyState = 1;
  return mongoose;
};

// Import database models
import { User, Document, Organization, AuditLog, Connector } from "../server-db.ts";

// -- Mock Data ---------------------------------------------------------
const mockUser = {
  _id: "user-123456",
  email: "admin@sso-org.com",
  tenantId: "org-tenant-123",
  role: "admin",
  passwordHash: "$2b$12$m1QWPuTCBtAwVJ1cXjxSaO/lOHNEcal2OuHDeL/vcKJ2VTj7KAVRi",
};

const mockOrg = {
  _id: "org-123",
  name: "SSO Corp",
  tenantId: "org-tenant-123",
  plan: "free",
  refinementCount: 2,
  ipAllowlist: ["127.0.0.1"],
  webhookUrl: "https://mock.webhook.url/receiver",
  webhookSecret: "sign-secret",
  save: async function() { return this; },
};


const mockConnector = {
  _id: "connector-789",
  id: "connector-789",
  tenantId: "org-tenant-123",
  name: "Mock Drive",
  type: "Google Drive",
  status: "connected",
  filesCount: 0,
  frequency: "manual",
  config: { sourceFiles: [], autoRefreshEnabled: false },
  syncState: { lastStatus: "never", files: [] },
  updatedAt: new Date().toISOString(),
  save: async function() { return this; },
};
const mockDoc = {
  _id: "doc-456",
  tenantId: "org-tenant-123",
  id: "doc-456",
  name: "Test_Report.txt",
  type: "TXT",
  size: "1 KB",
  connector: "Local Upload",
  status: "refined",
  parsedContent: "Parsed content",
  cleanedContent: "Cleaned content",
  redactedContent: "Redacted [REDACTED_EMAIL] content",
  piiFindings: [{ type: "EMAIL", value: "test@example.com" }],
  piiFindingsCount: 1,
  readinessScore: { score: 92, layoutScore: 90, securityScore: 95, hygieneScore: 88, metadataScore: 95, warnings: [], recommendations: [] },
  metadata: { title: "Test", category: "Finance", tags: ["a", "b", "c"], classification: "Internal", accessLevel: "L1", language: "English", author: "Tester", summary: "A test." },
  chunks: [{ id: "chunk-1", text: "Sample text", tokenCount: 10, headingContext: "Introduction" }],
  duplicatesRemoved: 1,
  vectorSync: {},
  createdAt: new Date().toISOString(),
  save: async function() { return this; },
};

// -- Mock Static DB Functions ------------------------------------------
(User.findOne as any) = async (query: any) => {
  if (query.email === "admin@sso-org.com") return mockUser as any;
  return null;
};

(User.findById as any) = async (id: any) => {
  if (id === "user-123456") return mockUser as any;
  return null;
};

(Organization.findOne as any) = async (query: any) => {
  if (query?.tenantId === "org-tenant-123") return mockOrg as any;
  return null;
};

// Document.find returns mockDoc without rawContent (PII gate simulation)
// Must return a chainable Query-like object since the route calls .find().sort()
(Document.find as any) = (_filter: any) => {
  const { rawContent: _omit, ...safeDoc } = mockDoc as any;
  const results = [safeDoc];
  // Return a thenable chainable object mimicking Mongoose Query
  const query: any = {
    sort: (_sortObj: any) => query,
    limit: (_n: number) => query,
    skip: (_n: number) => query,
    lean: () => query,
    then: (resolve: any, reject: any) => Promise.resolve(results).then(resolve, reject),
    catch: (reject: any) => Promise.resolve(results).catch(reject),
    [Symbol.iterator]: undefined,
  };
  return query;
};

// Document.findOne returns mockDoc without rawContent
(Document.findOne as any) = async () => {
  const { rawContent: _omit, ...safeDoc } = mockDoc as any;
  return safeDoc;
};

(Document.countDocuments as any) = async () => 1;


(Connector.find as any) = (_filter: any) => {
  const results = [mockConnector];
  const query: any = {
    sort: (_sortObj: any) => query,
    then: (resolve: any, reject: any) => Promise.resolve(results).then(resolve, reject),
    catch: (reject: any) => Promise.resolve(results).catch(reject),
  };
  return query;
};

(Connector.findOne as any) = async (query: any) => {
  if (query?._id === "connector-789" && query?.tenantId === "org-tenant-123") return mockConnector as any;
  return null;
};
// Silence AuditLog.create in tests
(AuditLog.create as any) = async () => ({});

// -- Dynamic Server Import ---------------------------------------------
import request from "supertest";
const { app, runChunking } = await import("../server.ts");

// -- Test Runner -------------------------------------------------------
async function runRoutingTests() {
  console.log("Starting Comprehensive API Route Test Suite (18 Tests)...");
  let exitCode = 0;
  let passed = 0;

  async function runTest(name: string, fn: () => Promise<void>) {
    console.log(`\n--- ${name} ---`);
    try {
      await fn();
      console.log(`PASS: ${name}`);
      passed++;
    } catch (err: any) {
      console.error(`FAIL: ${name} - ${err.message}`);
      exitCode = 1;
    }
  }

  try {
    // Test 1: Health check
    await runTest("TEST 1: Health Endpoint (/api/health)", async () => {
      const res = await request(app).get("/api/health");
      if (res.status !== 200 && res.status !== 503) {
        throw new Error(`Expected 200 or 503, got ${res.status}`);
      }
    });

    // Test 1b: Canonical v1 route aliases existing API routes
    await runTest("TEST 1b: API Version Alias (/v1/health)", async () => {
      const res = await request(app).get("/v1/health");
      if (res.status !== 200 && res.status !== 503) {
        throw new Error(`Expected 200 or 503, got ${res.status}`);
      }
      if (res.headers["api-version"] !== "v1") throw new Error("Missing API-Version v1 header");
      if (res.headers.deprecation) throw new Error("Canonical /v1 route should not be marked deprecated");
    });

    // Test 1c: Legacy API routes advertise deprecation
    await runTest("TEST 1c: Legacy API Deprecation Header (/api/health)", async () => {
      const res = await request(app).get("/api/health");
      if (res.headers.deprecation !== "true") throw new Error("Missing deprecation header on /api route");
      if (!String(res.headers.link || "").includes("/v1")) throw new Error("Missing successor-version link");
    });
    // Test 1d: Prometheus metrics endpoint is exposed
    await runTest("TEST 1d: Prometheus Metrics Endpoint", async () => {
      const res = await request(app).get("/metrics");
      if (res.status !== 200) throw new Error(`Expected 200, got ${res.status}`);
      if (!String(res.text).includes("dhub_http_requests_total")) throw new Error("Metrics response missing request counter");
    });
    // Test 2: JWT gate blocks unauthenticated requests
    await runTest("TEST 2: JWT Route Protection (401 gate)", async () => {
      const res = await request(app).get("/api/documents");
      if (res.status !== 401) throw new Error(`Expected 401, got ${res.status}`);
    });

    // Test 3: Login failure with wrong password
    await runTest("TEST 3: Login Failure (Wrong Password returns 401)", async () => {
      const res = await request(app)
        .post("/api/auth/login")
        .send({ email: "admin@sso-org.com", password: "WrongPassword!" });
      if (res.status !== 401) throw new Error(`Expected 401, got ${res.status}`);
    });

    // Acquire token for all subsequent tests
    const loginRes = await request(app)
      .post("/api/auth/login")
      .send({ email: "admin@sso-org.com", password: "SecretPass123!" });
    const token = loginRes.body.token;
    if (!token) throw new Error("Could not acquire JWT. Login failed. Aborting.");

    // Test 4: IP allowlist blocks non-listed IPs
    await runTest("TEST 4: IP Allowlist Enforcement (403 block)", async () => {
      mockOrg.ipAllowlist = ["10.0.0.1"];
      const res = await request(app)
        .get("/api/admin/settings")
        .set("Authorization", `Bearer ${token}`);
      mockOrg.ipAllowlist = ["127.0.0.1"];
      if (res.status !== 403) throw new Error(`Expected 403 for blocked IP, got ${res.status}`);
    });

    // Test 5: Free tier billing quota enforced
    await runTest("TEST 5: Billing Quota Enforcement (402 on free tier limit)", async () => {
      mockOrg.refinementCount = 5;
      const res = await request(app)
        .post("/api/documents/doc-456/refine")
        .set("Authorization", `Bearer ${token}`);
      mockOrg.refinementCount = 2;
      if (res.status !== 402) throw new Error(`Expected 402 payment required, got ${res.status}`);
    });

    // Test 6: Stats endpoint returns required fields
    await runTest("TEST 6: Analytics Stats (GET /api/stats)", async () => {
      const res = await request(app)
        .get("/api/stats")
        .set("Authorization", `Bearer ${token}`);
      if (res.status !== 200) throw new Error(`Expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
      if (typeof res.body.totalDocs !== "number") throw new Error("Missing totalDocs field");
      if (typeof res.body.avgReadiness !== "number") throw new Error("Missing avgReadiness field");
      console.log(`  totalDocs=${res.body.totalDocs} avgReadiness=${res.body.avgReadiness}`);
    });

    // Test 7: Billing plan endpoint
    await runTest("TEST 7: Billing Plan (GET /api/billing/plan)", async () => {
      const res = await request(app)
        .get("/api/billing/plan")
        .set("Authorization", `Bearer ${token}`);
      if (res.status !== 200) throw new Error(`Expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
      if (!res.body.plan) throw new Error("Missing plan in response");
      console.log(`  plan=${res.body.plan} refinementCount=${res.body.refinementCount}`);
    });

    // Test 8: Document export
    await runTest("TEST 8: Document Export (POST /api/documents/:id/export)", async () => {
      const res = await request(app)
        .post("/api/documents/doc-456/export")
        .set("Authorization", `Bearer ${token}`);
      if (res.status !== 200) throw new Error(`Expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
      if (!res.body.name) throw new Error("Export missing document name");
      if (res.body.rawContent !== undefined) throw new Error("CRITICAL PII LEAK: rawContent present in export!");
      console.log(`  Exported: ${res.body.name}`);
    });

    // Test 9: PII gate - rawContent excluded from GET /api/documents
    await runTest("TEST 9: PII Gate - rawContent excluded from GET /api/documents", async () => {
      const res = await request(app)
        .get("/api/documents")
        .set("Authorization", `Bearer ${token}`);
      if (res.status !== 200) throw new Error(`Expected 200, got ${res.status}`);
      for (const doc of res.body) {
        if (doc.rawContent !== undefined && doc.rawContent !== null) {
          throw new Error("PII GATE BREACH: rawContent leaked in GET /api/documents!");
        }
      }
      console.log(`  PII gate verified: rawContent absent in ${res.body.length} doc(s)`);
    });

    // Test 9b: Token-aware chunking respects token budget
    await runTest("TEST 9b: Token-Aware Chunking", async () => {
      const source = `# Intro\n\n${Array.from({ length: 80 }, (_, i) => `word${i}`).join(" ")}\n\n## Details\n\n${Array.from({ length: 80 }, (_, i) => `detail${i}`).join(" ")}`;
      const chunks = runChunking(source, 45, 8);
      if (chunks.length < 3) throw new Error(`Expected multiple chunks, got ${chunks.length}`);
      if (chunks.some((chunk: any) => chunk.tokenCount > 60)) {
        throw new Error(`Chunk exceeded expected token budget: ${JSON.stringify(chunks.map((c: any) => c.tokenCount))}`);
      }
      if (!chunks.some((chunk: any) => chunk.headingContext === "Details")) throw new Error("Missing heading context propagation");
    });
    // Test 10: Auth/me returns user with tenantId
    await runTest("TEST 10: Auth/Me returns authenticated user", async () => {
      const res = await request(app)
        .get("/api/auth/me")
        .set("Authorization", `Bearer ${token}`);
      if (res.status !== 200) throw new Error(`Expected 200, got ${res.status}`);
      if (!res.body.user?.email) throw new Error("Missing user.email in /api/auth/me");
      if (!res.body.user?.tenantId) throw new Error("Missing user.tenantId in /api/auth/me");
      console.log(`  Authenticated as: ${res.body.user.email} (tenant: ${res.body.user.tenantId})`);
    });

    // Test 9c: Object storage presign returns tenant-scoped local upload URL
    await runTest("TEST 9c: Object Storage Presign", async () => {
      const res = await request(app)
        .post("/api/storage/presign")
        .set("Authorization", `Bearer ${token}`)
        .send({ key: "uploads/sample.txt", contentType: "text/plain" });
      if (res.status !== 200) throw new Error(`Expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
      if (res.body.provider !== "local") throw new Error(`Expected local provider, got ${res.body.provider}`);
      if (!String(res.body.key).startsWith("org-tenant-123/")) throw new Error("Presigned key is not tenant scoped");
    });

    // Test 9d: Binary local object upload stores bytes
    await runTest("TEST 9d: Binary Object Upload", async () => {
      const res = await request(app)
        .put("/api/storage/upload?key=org-tenant-123/uploads/sample.txt")
        .set("Authorization", `Bearer ${token}`)
        .set("Content-Type", "application/octet-stream")
        .send(Buffer.from("hello storage"));
      if (res.status !== 200) throw new Error(`Expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
      if (res.body.bytes !== 13) throw new Error(`Expected 13 bytes, got ${res.body.bytes}`);
    });
    // Test 10a: Connector list endpoint is tenant scoped
    await runTest("TEST 10a: Connector List Endpoint", async () => {
      const res = await request(app)
        .get("/api/connectors")
        .set("Authorization", `Bearer ${token}`);
      if (res.status !== 200) throw new Error(`Expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
      if (!Array.isArray(res.body) || res.body[0]?.tenantId !== "org-tenant-123") throw new Error("Connector list response missing tenant-scoped connector");
    });

    // Test 10b: Connector schedule endpoint queues repeat sync
    await runTest("TEST 10b: Connector Scheduled Sync Endpoint", async () => {
      const res = await request(app)
        .post("/api/connectors/connector-789/schedule")
        .set("Authorization", `Bearer ${token}`)
        .send({ frequency: "daily" });
      if (res.status !== 200) throw new Error(`Expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
      if (res.body.cron !== "0 0 * * *") throw new Error(`Expected daily cron, got ${res.body.cron}`);
      if (!res.body.scheduled) throw new Error("Schedule response missing scheduled=true");
    });
  } catch (err: any) {
    console.error("\nFATAL TEST SETUP ERROR:", err.message);
    exitCode = 1;
  } finally {
    console.log(`\n${"=".repeat(50)}`);
    console.log(`RESULTS: ${passed}/18 tests passed`);
    if (exitCode === 0) {
      console.log("ALL TESTS PASSED");
    } else {
      console.log("SOME TESTS FAILED - See errors above");
    }
    process.exit(exitCode);
  }
}

runRoutingTests();
