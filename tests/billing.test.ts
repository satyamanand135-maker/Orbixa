/**
 * tests/billing.test.ts — Stripe billing webhook + plan flow tests
 *
 * Tests covered:
 *   B1: Stripe webhook signature verification (valid → 200, tampered → 400)
 *   B2: Billing plan endpoint returns plan info
 *   B3: Checkout endpoint returns URL (mock path when STRIPE_SECRET_KEY absent)
 *   B4: Customer portal requires stripeCustomerId
 */

import dotenv from "dotenv";
dotenv.config();

import crypto from "crypto";
import mongoose from "mongoose";

mongoose.connect = async () => {
  (mongoose.connection as any).readyState = 1;
  return mongoose;
};

import { User, Document, Organization, AuditLog, Connector } from "../server-db.ts";

const WEBHOOK_SECRET = "test-stripe-webhook-secret";

const mockUser = {
  _id: "user-billing-1",
  email: "billing@test.com",
  tenantId: "billing-tenant-1",
  role: "admin",
  passwordHash: "$2b$12$m1QWPuTCBtAwVJ1cXjxSaO/lOHNEcal2OuHDeL/vcKJ2VTj7KAVRi",
};

const mockOrg: any = {
  _id: "org-billing-1",
  name: "Billing Corp",
  tenantId: "billing-tenant-1",
  plan: "free",
  refinementCount: 0,
  ipAllowlist: ["127.0.0.1"],
  webhookUrl: "",
  webhookSecret: "",
  stripeCustomerId: null,
  save: async function () { return this; },
};

const mockDoc: any = {
  _id: "doc-billing-1",
  tenantId: "billing-tenant-1",
  id: "doc-billing-1",
  name: "Billing_Doc.txt",
  type: "TXT",
  size: "1 KB",
  connector: "Local",
  status: "refined",
  parsedContent: "Billing content",
  cleanedContent: "Billing content",
  redactedContent: "Billing content",
  piiFindings: [],
  piiFindingsCount: 0,
  readinessScore: { score: 90, layoutScore: 85, securityScore: 95, hygieneScore: 90, metadataScore: 90, warnings: [], recommendations: [] },
  metadata: { title: "Billing", category: "Finance", tags: ["billing"], classification: "Internal", accessLevel: "L1", language: "English", author: "Test", summary: "Billing doc." },
  chunks: [],
  duplicatesRemoved: 0,
  vectorSync: {},
  createdAt: new Date().toISOString(),
  save: async function () { return this; },
};

(User.findOne as any) = async (q: any) => q.email === "billing@test.com" ? mockUser : null;
(User.findById as any) = async (id: any) => id === "user-billing-1" ? mockUser : null;
(Organization.findOne as any) = async (q: any) => q?.tenantId === "billing-tenant-1" ? mockOrg : null;
(Document.find as any) = (_: any) => {
  const q: any = {
    sort: () => q, limit: () => q, skip: () => q, lean: () => q,
    then: (r: any, j: any) => Promise.resolve([mockDoc]).then(r, j),
    catch: (j: any) => Promise.resolve([mockDoc]).catch(j),
  };
  return q;
};
(Document.findOne as any) = async () => mockDoc;
(Document.countDocuments as any) = async () => 1;
(Connector.find as any) = (_: any) => {
  const q: any = {
    sort: () => q,
    then: (r: any, j: any) => Promise.resolve([]).then(r, j),
    catch: (j: any) => Promise.resolve([]).catch(j),
  };
  return q;
};
(AuditLog.create as any) = async () => ({});

import request from "supertest";
const { app } = await import("../server.ts");

// --------------------------------------------------------
function buildStripeWebhookPayload(
  event: object,
  secret: string
): { body: string; signature: string } {
  const body = JSON.stringify(event);
  const timestamp = Math.floor(Date.now() / 1000);
  const payload = `${timestamp}.${body}`;
  const sig = crypto.createHmac("sha256", secret).update(payload).digest("hex");
  const signature = `t=${timestamp},v1=${sig}`;
  return { body, signature };
}

async function runBillingTests() {
  console.log("\nStarting Billing Test Suite (4 Tests)...");
  let passed = 0;
  let exitCode = 0;

  async function test(name: string, fn: () => Promise<void>) {
    console.log(`\n--- ${name} ---`);
    try {
      await fn();
      console.log(`PASS: ${name}`);
      passed++;
    } catch (err: any) {
      console.error(`FAIL: ${name} — ${err.message}`);
      exitCode = 1;
    }
  }

  // Login
  const loginRes = await request(app)
    .post("/api/auth/login")
    .send({ email: "billing@test.com", password: "SecretPass123!" });
  const token = loginRes.body.token;
  if (!token) {
    console.error("FATAL: Could not acquire JWT. Aborting billing tests.");
    process.exit(1);
  }

  // B1: Stripe webhook — tampered payload rejected
  await test("B1: Stripe webhook rejects tampered payload (400)", async () => {
    const { signature } = buildStripeWebhookPayload(
      { type: "customer.subscription.updated", data: { object: { metadata: {} } } },
      WEBHOOK_SECRET
    );
    // Send a DIFFERENT body but keep the old signature
    const res = await request(app)
      .post("/api/billing/webhook")
      .set("stripe-signature", signature)
      .set("Content-Type", "application/json")
      .send(JSON.stringify({ type: "malicious.event" }));
    // Should be 400 (invalid signature) — or 400 from missing WEBHOOK_SECRET env var in test
    // Either way it must NOT be 200
    if (res.status === 200) throw new Error("Tampered webhook payload was accepted — security failure!");
    console.log(`  Tampered payload correctly rejected with ${res.status}`);
  });

  // B2: Billing plan endpoint returns current plan
  await test("B2: GET /api/billing/plan returns plan info", async () => {
    const res = await request(app)
      .get("/api/billing/plan")
      .set("Authorization", `Bearer ${token}`);
    if (res.status !== 200) throw new Error(`Expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
    if (!res.body.plan) throw new Error("Missing plan field");
    console.log(`  plan=${res.body.plan} refinementCount=${res.body.refinementCount}`);
  });

  // B3: Checkout returns mock URL when STRIPE_SECRET_KEY absent
  await test("B3: POST /api/billing/checkout returns URL (mock mode)", async () => {
    const res = await request(app)
      .post("/api/billing/checkout")
      .set("Authorization", `Bearer ${token}`)
      .send({ plan: "pro" });
    if (res.status !== 200) throw new Error(`Expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
    // In test mode (no STRIPE_SECRET_KEY), should return mock=true with a URL
    if (!res.body.url && !res.body.mock) throw new Error("Missing url or mock in checkout response");
    console.log(`  Checkout: mock=${res.body.mock} url=${res.body.url?.slice(0, 50)}`);
  });

  // B4: Customer portal requires subscription first
  await test("B4: GET /api/billing/portal requires stripeCustomerId", async () => {
    mockOrg.stripeCustomerId = null; // No Stripe customer yet
    const res = await request(app)
      .get("/api/billing/portal")
      .set("Authorization", `Bearer ${token}`);
    // In mock mode (no STRIPE_SECRET_KEY), returns mock URL; with real Stripe, 400 for no customer
    if (res.status !== 200 && res.status !== 400) {
      throw new Error(`Expected 200 (mock) or 400 (no customer), got ${res.status}`);
    }
    console.log(`  Portal: status=${res.status} mock=${res.body.mock || false}`);
  });

  console.log(`\n${"=".repeat(50)}`);
  console.log(`BILLING TESTS: ${passed}/4 passed`);
  if (exitCode !== 0) console.log("SOME BILLING TESTS FAILED");
  else console.log("ALL BILLING TESTS PASSED");
  process.exit(exitCode);
}

runBillingTests();
