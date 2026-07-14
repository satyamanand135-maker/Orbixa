/**
 * CRITICAL GAPS - Implementation Templates
 * Copy/paste snippets for Phase 1 urgent fixes
 */

// ============================================================================
// 1. BCRYPT PASSWORD HASHING (Fix static salt vulnerability)
// ============================================================================

// Install first:
// npm install bcrypt

// server-auth.ts - REPLACE THIS:
/*
export function hashPassword(password: string): string {
  return crypto
    .pbkdf2Sync(password, "salt-change-in-production", 100000, 64, "sha512")
    .toString("hex");
}

export function verifyPassword(password: string, hash: string): boolean {
  return hashPassword(password) === hash;
}
*/

// WITH THIS:
import bcrypt from 'bcrypt';

export async function hashPassword(password: string): Promise<string> {
  // Salt rounds: 12 = ~0.3s, production strength
  return bcrypt.hash(password, 12);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

// Usage:
// const hashed = await hashPassword(userPassword);
// const isValid = await verifyPassword(inputPassword, storedHash);

// ============================================================================
// 2. WIRE SERVER.TS TO MONGODB (Replace in-memory array)
// ============================================================================

// At TOP of server.ts, add:
import mongoose from "mongoose";
import { Document, Connector, VectorDb } from "./server-db.ts";
import { setupJobProcessors } from "./server-jobs.ts";
import { requireAuth, rateLimit } from "./server-auth.ts";

// Then in startServer():
async function startServer() {
  // Connect to MongoDB
  const mongoUri = process.env.MONGODB_URI || "mongodb://localhost:27017/dhub";
  try {
    await mongoose.connect(mongoUri);
    console.log("✓ Connected to MongoDB");
  } catch (error) {
    console.error("✗ MongoDB connection failed:", error);
    process.exit(1);
  }

  // Setup job processors
  setupJobProcessors();
  console.log("✓ Job processors initialized");

  // Seed initial data if empty
  const count = await Document.countDocuments();
  if (count === 0) {
    await Document.insertMany(INITIAL_DOCUMENTS.map(d => ({
      ...d,
      tenantId: process.env.DEFAULT_TENANT_ID || "default-tenant"
    })));
    console.log("✓ Initial documents seeded");
  }

  // ... rest of server setup
}

// ============================================================================
// 3. ADD AUTH & TENANTID FILTERING TO ALL ROUTES
// ============================================================================

// BEFORE (current):
app.get("/api/documents", (req, res) => {
  res.json(documentsDb);
});

// AFTER (with auth + tenantId):
app.get("/api/documents", requireAuth, async (req, res) => {
  const docs = await Document.find({ tenantId: req.user.tenantId });
  res.json(docs);
});

// Example with rate limiting:
app.post("/api/documents", 
  requireAuth, 
  rateLimit(100, 60000), // 100 req/min per user
  async (req, res) => {
    const { name, type, rawContent, size, connector } = req.body;
    
    const newDoc = new Document({
      tenantId: req.user.tenantId,
      name,
      type,
      rawContent,
      size: size || `${Math.round(rawContent.length / 1024)} KB`,
      connector: connector || "Local Upload",
      status: "raw"
    });
    
    await newDoc.save();
    
    // Queue for processing
    await addRefineJob(newDoc._id.toString());
    
    res.status(201).json(newDoc);
});

// ============================================================================
// 4. HEALTH CHECK ENDPOINTS (Required for container orchestration)
// ============================================================================

app.get("/health", async (req, res) => {
  const health = {
    status: "ok",
    timestamp: new Date(),
    checks: {}
  };

  // Check MongoDB
  try {
    await mongoose.connection.db.admin().ping();
    health.checks.database = "ok";
  } catch (e) {
    health.checks.database = "error";
    health.status = "degraded";
  }

  // Check Redis
  try {
    // Assuming redisClient imported
    await redisClient.ping();
    health.checks.redis = "ok";
  } catch (e) {
    health.checks.redis = "error";
    health.status = "degraded";
  }

  // Check job queue
  try {
    const counts = await documentRefineQueue.counts();
    health.checks.queue = "ok";
    health.queueDepth = counts.waiting;
  } catch (e) {
    health.checks.queue = "error";
  }

  res.status(health.status === "ok" ? 200 : 503).json(health);
});

app.get("/ready", async (req, res) => {
  const isReady = mongoose.connection.readyState === 1;
  res.status(isReady ? 200 : 503).json({ ready: isReady });
});

// ============================================================================
// 5. ENCRYPT OAUTH CREDENTIALS ON SAVE (Application-layer encryption)
// ============================================================================

// In server-db.ts, add to ConnectorSchema:
ConnectorSchema.pre("save", function(next) {
  if (this.credentials?.oauthToken && !this.credentials.oauthToken.startsWith("enc:")) {
    try {
      this.credentials.oauthToken = encryptCredential(this.credentials.oauthToken);
    } catch (e) {
      console.error("Failed to encrypt OAuth token:", e);
    }
  }
  
  if (this.credentials?.refreshToken && !this.credentials.refreshToken.startsWith("enc:")) {
    try {
      this.credentials.refreshToken = encryptCredential(this.credentials.refreshToken);
    } catch (e) {
      console.error("Failed to encrypt refresh token:", e);
    }
  }
  
  next();
});

// Decrypt on retrieve:
ConnectorSchema.methods.getDecryptedCredentials = function() {
  return {
    oauthToken: decryptCredential(this.credentials.oauthToken),
    refreshToken: decryptCredential(this.credentials.refreshToken),
    clientId: this.credentials.clientId
  };
};

// ============================================================================
// 6. MULTI-TENANCY QUERY MIDDLEWARE (Auto-inject tenantId)
// ============================================================================

// middleware/tenantFilter.ts
export function tenantFilter(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: "Not authenticated" });
  }

  // Attach tenant to request
  req.tenantId = req.user.tenantId;

  // Store original query
  const originalFind = Document.find.bind(Document);
  const originalFindOne = Document.findOne.bind(Document);
  const originalFindById = Document.findById.bind(Document);
  const originalUpdateOne = Document.updateOne.bind(Document);
  const originalDeleteOne = Document.deleteOne.bind(Document);

  // Wrapper that injects tenantId
  Document.find = function(filter = {}) {
    return originalFind({ ...filter, tenantId: req.tenantId });
  };

  Document.findOne = function(filter = {}) {
    return originalFindOne({ ...filter, tenantId: req.tenantId });
  };

  Document.findById = function(id) {
    return originalFindOne({ _id: id, tenantId: req.tenantId });
  };

  next();
}

// In server.ts:
app.use(tenantFilter);

// ============================================================================
// 7. AUDIT LOGGING (Immutable log for SOC2/HIPAA compliance)
// ============================================================================

// models/AuditLog.ts
const AuditLogSchema = new Schema({
  tenantId: { type: String, required: true, index: true },
  userId: String,
  action: { type: String, enum: ["READ", "CREATE", "UPDATE", "DELETE", "EXPORT"] },
  resource: { type: String, enum: ["Document", "Connector", "VectorDb", "User"] },
  resourceId: String,
  changes: {
    before: mongoose.Schema.Types.Mixed,
    after: mongoose.Schema.Types.Mixed
  },
  ipAddress: String,
  userAgent: String,
  timestamp: { type: Date, default: Date.now, index: true },
  status: { type: String, enum: ["success", "failure"], default: "success" },
  errorMessage: String
}, { 
  collection: "audit_logs",
  immutable: true  // Prevent changes after creation
});

export const AuditLog = mongoose.model("AuditLog", AuditLogSchema);

// Utility function:
export async function logAudit(req, action, resource, resourceId, changes) {
  try {
    await AuditLog.create({
      tenantId: req.user.tenantId,
      userId: req.user.id,
      action,
      resource,
      resourceId,
      changes,
      ipAddress: req.ip,
      userAgent: req.get("user-agent")
    });
  } catch (e) {
    console.error("Failed to log audit event:", e);
  }
}

// Usage in routes:
app.delete("/api/documents/:id", requireAuth, async (req, res) => {
  const doc = await Document.findOne({
    _id: req.params.id,
    tenantId: req.user.tenantId
  });

  if (!doc) return res.status(404).json({ error: "Not found" });

  await logAudit(req, "DELETE", "Document", req.params.id, {
    before: doc,
    after: null
  });

  await Document.findByIdAndDelete(req.params.id);
  res.json({ success: true });
});

// ============================================================================
// 8. REDIS-BACKED SESSION STORAGE (For production scaling)
// ============================================================================

// In server.ts, replace in-memory sessions:

import { createRedisSessionStore } from './server-redis-sessions.ts';
import session from 'express-session';

async function startServer() {
  // ... DB connection ...

  const sessionStore = await createRedisSessionStore();

  app.use(session({
    store: sessionStore,
    secret: process.env.SESSION_SECRET || "change-me-in-production",
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: process.env.NODE_ENV === "production",
      httpOnly: true,
      maxAge: 24 * 60 * 60 * 1000, // 24 hours
      sameSite: "strict"
    }
  }));
}

// ============================================================================
// 9. GRACEFUL SHUTDOWN (Drain jobs before exit)
// ============================================================================

// At end of server.ts:
process.on("SIGTERM", gracefulShutdown);
process.on("SIGINT", gracefulShutdown);

async function gracefulShutdown() {
  console.log("\n[SHUTDOWN] Received shutdown signal");
  
  // Close queues (drains in-flight jobs)
  console.log("[SHUTDOWN] Closing job queues...");
  await closeQueues();
  
  // Close MongoDB
  console.log("[SHUTDOWN] Closing MongoDB...");
  await mongoose.connection.close();
  
  // Close Redis
  console.log("[SHUTDOWN] Closing Redis...");
  await redisClient.quit();
  
  // Shutdown server
  if (server) {
    server.close(() => {
      console.log("[SHUTDOWN] Server closed, exiting");
      process.exit(0);
    });
  }
  
  // Force exit after 10 seconds if not closed
  setTimeout(() => {
    console.error("[SHUTDOWN] Forced exit after timeout");
    process.exit(1);
  }, 10000);
}

// ============================================================================
// 10. ENVIRONMENT VARIABLES REQUIRED FOR PRODUCTION
// ============================================================================

// Add to .env:
/*
# Database
MONGODB_URI=mongodb+srv://user:pass@cluster.mongodb.net/dhub
DEFAULT_TENANT_ID=default-tenant

# Redis
REDIS_HOST=redis.example.com
REDIS_PORT=6379
REDIS_PASSWORD=your-secure-password

# Security
ENCRYPTION_KEY=<32-byte-hex-key>
SESSION_SECRET=<32-char-random-string>
JWT_SECRET=<32-char-random-string>

# OAuth
GOOGLE_OAUTH_CLIENT_ID=...
GOOGLE_OAUTH_CLIENT_SECRET=...
GITHUB_OAUTH_CLIENT_ID=...
GITHUB_OAUTH_CLIENT_SECRET=...

# Gemini API
GEMINI_API_KEY=...

# Optional: Production Features
SENTRY_DSN=...
PROMETHEUS_URL=http://prometheus:9090
STRIPE_API_KEY=...
*/
