import mongoose from "mongoose";

// Document Schema - with tenant_id for multi-tenancy support
const DocumentSchema = new mongoose.Schema(
  {
    tenantId: { type: String, required: true, index: true, description: "Organization/workspace ID for multi-tenancy" },
    id: { type: String, required: true, unique: true, index: true },
    name: { type: String, required: true },
    type: { type: String, enum: ["PDF", "DOCX", "XLSX", "PPTX", "TXT"], required: true },
    size: { type: String, required: true },
    connector: { type: String, required: true },
    status: {
      type: String,
      enum: ["raw", "processing", "refined", "failed"],
      default: "raw",
    },
    rawContent: { type: String, required: true },
    parsedContent: { type: String, default: "" },
    cleanedContent: { type: String, default: "" },
    redactedContent: { type: String, default: "" },
    metadata: {
      title: String,
      category: String,
      tags: [String],
      classification: {
        type: String,
        enum: ["Public", "Internal", "Confidential", "Highly Sensitive"],
      },
      accessLevel: { type: String, enum: ["L1", "L2", "L3"] },
      language: String,
      author: String,
      summary: String,
    },
    chunks: [
      {
        id: String,
        text: String,
        tokenCount: Number,
        headingContext: String,
      },
    ],
    vectorSync: {
      qdrant: {
        indexName: String,
        status: String,
        vectorsCount: Number,
        dimensions: Number,
        latencyMs: Number,
        lastSyncedAt: Date,
      },
      pinecone: {
        indexName: String,
        status: String,
        vectorsCount: Number,
        dimensions: Number,
        latencyMs: Number,
        lastSyncedAt: Date,
      },
    },
    readinessScore: {
      score: Number,
      layoutScore: Number,
      securityScore: Number,
      hygieneScore: Number,
      metadataScore: Number,
      warnings: [String],
      recommendations: [String],
    },
    piiFindingsCount: { type: Number, default: 0 },
    piiFindings: [
      {
        type: { type: String },
        value: { type: String },
      },
    ],
    duplicatesRemoved: { type: Number, default: 0 },
    embeddingCost: { type: Number, default: 0 },
    tokenCount: { type: Number, default: 0 },
    createdAt: { type: Date, default: Date.now, index: true },
    updatedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

// Import credential encryption helpers
import { encryptCredential, decryptCredential } from "./server-oauth.ts";

// Connector Schema - with tenant_id for multi-tenancy support
const ConnectorSchema = new mongoose.Schema(
  {
    tenantId: { type: String, required: true, index: true, description: "Organization/workspace ID for multi-tenancy" },
    id: { type: String, required: true, unique: true, index: true },
    name: String,
    type: String,
    status: { type: String, enum: ["connected", "disconnected", "syncing"] },
    lastSynced: Date,
    filesCount: { type: Number, default: 0 },
    frequency: String,
    credentials: {
      oauthToken: String, // encrypted
      clientId: String,
      refreshToken: String, // encrypted
    },
    config: { type: mongoose.Schema.Types.Mixed, default: {} },
    syncState: { type: mongoose.Schema.Types.Mixed, default: {} },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

// Vector DB Schema - with tenant_id for multi-tenancy support
const VectorDbSchema = new mongoose.Schema(
  {
    tenantId: { type: String, required: true, index: true, description: "Organization/workspace ID for multi-tenancy" },
    id: { type: String, required: true, unique: true, index: true },
    name: String,
    status: { type: String, enum: ["active", "inactive", "testing"] },
    indexName: String,
    dimensions: Number,
    latencyMs: Number,
    vectorsCount: { type: Number, default: 0 },
    embeddingModel: String,
    credentials: {
      endpoint: String, // encrypted
      apiKey: String, // encrypted
    },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

// Organization Schema to support team scoping and per-org policies
const OrganizationSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    tenantId: { type: String, required: true, unique: true, index: true },
    plan: { type: String, enum: ["free", "pro", "enterprise"], default: "free" },
    refinementCount: { type: Number, default: 0 },
    ipAllowlist: { type: [String], default: [] },
    retentionDays: { type: Number, default: 0 }, // 0 = disabled (infinite retention)
    webhookUrl: { type: String, default: "" },
    webhookSecret: { type: String, default: "" },
    chunkingOverlap: { type: Number, default: 15 },
    chunkingStrategy: { type: String, enum: ["paragraph", "sliding_window", "semantic"], default: "paragraph" },
    locale: { type: String, default: "en" },
    billingEmail: { type: String, default: "" },
    // Gap 18 — Storage quota enforcement
    storageUsedBytes: { type: Number, default: 0 },
    storageQuotaBytes: { type: Number, default: 104857600 }, // 100 MB free tier
    documentQuota: { type: Number, default: 50 },           // max docs on free plan
    refinementQuota: { type: Number, default: 5 },          // max refinements/month free
    // Billing provider identifiers
    stripeCustomerId: { type: String, default: null },
    stripeSubscriptionId: { type: String, default: null },
    paddleCustomerId: { type: String, default: null },
    paddleSubscriptionId: { type: String, default: null },
    subscriptionStatus: { type: String, default: "inactive" },
  },
  { timestamps: true }
);

// User Schema for Auth and multi-tenancy isolation
const UserSchema = new mongoose.Schema(
  {
    email: { type: String, required: true, unique: true, index: true },
    passwordHash: { type: String, required: true },
    tenantId: { type: String, required: true, index: true },
    role: { type: String, enum: ["admin", "user", "viewer"], default: "user" },
  },
  { timestamps: true }
);

// Immutable Audit Log Schema for HIPAA/SOC2 compliance
const AuditLogSchema = new mongoose.Schema(
  {
    tenantId: { type: String, required: true, index: true },
    userId: { type: String, required: true, index: true },
    action: { type: String, enum: ["READ", "CREATE", "UPDATE", "DELETE", "EXPORT", "LOGIN", "REGISTER"], required: true },
    resource: { type: String, enum: ["Document", "Connector", "VectorDb", "User", "Auth"], required: true },
    resourceId: { type: String },
    changes: {
      before: mongoose.Schema.Types.Mixed,
      after: mongoose.Schema.Types.Mixed,
    },
    ipAddress: String,
    userAgent: String,
    timestamp: { type: Date, default: Date.now, index: true },
  },
  { collection: "audit_logs", immutable: true }
);

// Application-layer Encryption Hooks for Connector Credentials
ConnectorSchema.pre("save", function(next) {
  if (this.credentials) {
    if (this.credentials.oauthToken && !this.credentials.oauthToken.startsWith("enc:")) {
      try {
        this.credentials.oauthToken = "enc:" + encryptCredential(this.credentials.oauthToken);
      } catch (err) {
        return next(err as Error);
      }
    }
    if (this.credentials.refreshToken && !this.credentials.refreshToken.startsWith("enc:")) {
      try {
        this.credentials.refreshToken = "enc:" + encryptCredential(this.credentials.refreshToken);
      } catch (err) {
        return next(err as Error);
      }
    }
  }
  next();
});

ConnectorSchema.methods.getDecryptedCredentials = function() {
  const credentials: any = { clientId: this.credentials?.clientId };
  if (this.credentials?.oauthToken) {
    const rawToken = this.credentials.oauthToken.startsWith("enc:") 
      ? this.credentials.oauthToken.slice(4) 
      : this.credentials.oauthToken;
    credentials.oauthToken = decryptCredential(rawToken);
  }
  if (this.credentials?.refreshToken) {
    const rawToken = this.credentials.refreshToken.startsWith("enc:") 
      ? this.credentials.refreshToken.slice(4) 
      : this.credentials.refreshToken;
    credentials.refreshToken = decryptCredential(rawToken);
  }
  return credentials;
};

// Application-layer Encryption Hooks for VectorDb Credentials
VectorDbSchema.pre("save", function(next) {
  if (this.credentials) {
    if (this.credentials.endpoint && !this.credentials.endpoint.startsWith("enc:")) {
      try {
        this.credentials.endpoint = "enc:" + encryptCredential(this.credentials.endpoint);
      } catch (err) {
        return next(err as Error);
      }
    }
    if (this.credentials.apiKey && !this.credentials.apiKey.startsWith("enc:")) {
      try {
        this.credentials.apiKey = "enc:" + encryptCredential(this.credentials.apiKey);
      } catch (err) {
        return next(err as Error);
      }
    }
  }
  next();
});

VectorDbSchema.methods.getDecryptedCredentials = function() {
  const credentials: any = {};
  if (this.credentials?.endpoint) {
    const rawEndpoint = this.credentials.endpoint.startsWith("enc:") 
      ? this.credentials.endpoint.slice(4) 
      : this.credentials.endpoint;
    credentials.endpoint = decryptCredential(rawEndpoint);
  }
  if (this.credentials?.apiKey) {
    const rawApiKey = this.credentials.apiKey.startsWith("enc:") 
      ? this.credentials.apiKey.slice(4) 
      : this.credentials.apiKey;
    credentials.apiKey = decryptCredential(rawApiKey);
  }
  return credentials;
};

// Webhook logs for dispatcher delivery tracking
const WebhookLogSchema = new mongoose.Schema(
  {
    tenantId: { type: String, required: true, index: true },
    event: { type: String, required: true },
    url: { type: String, required: true },
    payload: mongoose.Schema.Types.Mixed,
    statusCode: Number,
    responseBody: String,
    status: { type: String, enum: ["success", "failed"], required: true },
    attempts: { type: Number, default: 1 },
    timestamp: { type: Date, default: Date.now, index: true },
  },
  { collection: "webhook_logs", immutable: true }
);

// Distributed Tracing Spans for Pipeline Stages (Observability)
const TraceSpanSchema = new mongoose.Schema(
  {
    traceId: { type: String, required: true, index: true },
    spanId: { type: String, required: true, unique: true },
    parentSpanId: { type: String },
    name: { type: String, required: true },
    documentId: { type: String, index: true },
    tenantId: { type: String, index: true },
    startTime: { type: Date, required: true },
    endTime: { type: Date },
    durationMs: { type: Number },
    attributes: { type: mongoose.Schema.Types.Mixed, default: {} },
    status: { type: String, enum: ["OK", "ERROR"], default: "OK" },
    error: { type: String }
  },
  { collection: "trace_spans" }
);

export const Document = mongoose.model("Document", DocumentSchema);
export const Connector = mongoose.model("Connector", ConnectorSchema);
export const VectorDb = mongoose.model("VectorDb", VectorDbSchema);
export const User = mongoose.model("User", UserSchema);
export const AuditLog = mongoose.model("AuditLog", AuditLogSchema);
export const WebhookLog = mongoose.model("WebhookLog", WebhookLogSchema);
export const Organization = mongoose.model("Organization", OrganizationSchema);
export const TraceSpan = mongoose.model("TraceSpan", TraceSpanSchema);
