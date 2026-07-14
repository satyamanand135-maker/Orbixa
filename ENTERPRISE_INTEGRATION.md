# Enterprise Tech Stack Integration Guide

## Overview

This guide documents the complete enterprise tech stack implementation for DHub. The application now includes all the required production-grade components for document processing, data persistence, job queuing, PII detection, authentication, and containerized deployment.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     Frontend (React)                            │
│            (Notification Context + Toast UI)                    │
└─────────────┬───────────────────────────────────────────────────┘
              │
┌─────────────▼───────────────────────────────────────────────────┐
│                 Express Backend (server.ts)                     │
├─────────────────────────────────────────────────────────────────┤
│ ┌──────────────────┐  ┌────────────────┐  ┌──────────────────┐ │
│ │  API Routes      │  │  Auth Middleware  Authentication      │ │
│ │  (CRUD)          │  │  (server-auth.ts) (JWT/Session)      │ │
│ │                  │  │                                        │ │
│ └────────┬─────────┘  └────────┬─────────┘  └──────────────────┘ │
│          │                     │                                   │
│ ┌────────▼──────────┐  ┌───────▼──────┐  ┌──────────────────┐   │
│ │ Validation        │  │ OAuth Flow   │  │ Error Handling   │   │
│ │ (server-validation│  │ (server-oauth │  (Custom Errors)  │   │
│ │ .ts)              │  │ .ts)          │                    │   │
│ └────────┬──────────┘  └───────┬──────┘  └──────────────────┘   │
│          │                     │                                   │
└──────────┼─────────────────────┼───────────────────────────────────┘
           │                     │
           ▼                     ▼
    ┌──────────────────────────────────┐
    │     Job Queue (Bull + Redis)     │
    │    (server-queue.ts)             │
    │                                  │
    │  ├─ Refine Queue                 │
    │  ├─ PII Detection Queue          │
    │  ├─ Connector Sync Queue         │
    │  └─ Embedding Queue              │
    └──────────────────────────────────┘
           │
    ┌──────┴────────────────────────────┐
    │                                   │
    ▼                                   ▼
┌─────────────────────┐        ┌─────────────────────┐
│  Real PDF Parser    │        │  Real PII Detection │
│  (server-pdf.ts)    │        │  (server-pii.ts)    │
│                     │        │                     │
│ • Table extraction  │        │ • Pattern matching  │
│ • Section parsing   │        │ • NLP entity ext.   │
│ • Text normalization│        │ • Risk assessment   │
└──────────┬──────────┘        └──────────┬──────────┘
           │                              │
           └──────────────┬───────────────┘
                          │
                          ▼
                ┌──────────────────────┐
                │  MongoDB Database    │
                │  (server-db.ts)      │
                │                      │
                │ • Documents          │
                │ • Connectors         │
                │ • VectorDb configs   │
                └──────────────────────┘
                          │
    ┌─────────────────────┼─────────────────────┐
    │                     │                     │
    ▼                     ▼                     ▼
┌──────────┐        ┌──────────┐         ┌──────────┐
│  Redis   │        │  Qdrant  │         │ Pinecone │
│ (Queue + │        │  Vector  │         │ Vector   │
│  Cache)  │        │   DB     │         │   DB     │
└──────────┘        └──────────┘         └──────────┘
```

## New Modules & Files

### 1. **server-queue.ts** - Async Job Queue System
**Purpose:** Process document refining, PII detection, connector syncing asynchronously
**Dependencies:** bull, redis
**Key Exports:**
- `documentRefineQueue` - Bull queue for document refinement
- `piiDetectionQueue` - Bull queue for PII detection
- `connectorSyncQueue` - Bull queue for connector syncing
- `embeddingQueue` - Bull queue for embedding generation
- `addRefineJob(documentId)` - Add job to refine document
- `addPiiJob(documentId)` - Add job for PII detection
- `addConnectorSyncJob(connectorId)` - Add job to sync connector
- `addEmbeddingJob(documentId, chunkIds)` - Add job to generate embeddings

**Usage in server.ts:**
```typescript
import { addRefineJob, addPiiJob } from './server-queue.ts';

// In POST /api/documents/:id/refine
await addRefineJob(docId);

// In PII detection
await addPiiJob(docId);
```

### 2. **server-pii.ts** - Real PII Detection
**Purpose:** Detect and redact personally identifiable information using pattern matching and NLP
**Dependencies:** node-nlp (for entity extraction)
**Key Exports:**
- `detectPII(text)` - Returns PIIDetectionResult with redacted text and findings
- `getPIIStatistics(findings)` - Get count of PII by type
- `hasHighRiskPII(findings)` - Check if contains SSN, credit cards, etc.
- `calculatePIIRisk(findings)` - Return "low" | "medium" | "high"

**Detected Types:**
- EMAIL, PHONE, SSN, CREDIT_CARD
- AWS_ACCESS_KEY, GENERIC_API_KEY, JWT_TOKEN
- PASSWORD_PLAIN, DATABASE_URL, PRIVATE_KEY
- GITHUB_TOKEN, NAME (via NLP)

**Usage in server.ts:**
```typescript
import { detectPII, calculatePIIRisk } from './server-pii.ts';

const { redactedText, findings } = await detectPII(text);
const risk = calculatePIIRisk(findings);
```

### 3. **server-pdf.ts** - Real PDF Parsing
**Purpose:** Parse PDF files, extract text, tables, sections, and document statistics
**Dependencies:** pdfparse
**Key Exports:**
- `parsePDFBuffer(buffer)` - Parse PDF from Buffer
- `parsePDFFile(filePath)` - Parse PDF from file path
- `extractSections(text)` - Extract structured sections
- `normalizePDFText(text)` - Clean PDF text artifacts
- `getDocumentStats(text)` - Return word count, reading time, etc.

**Usage in server.ts:**
```typescript
import { parsePDFBuffer, getDocumentStats } from './server-pdf.ts';

// When processing PDF uploads
const pdfData = await parsePDFBuffer(uploadBuffer);
const stats = getDocumentStats(pdfData.text);
```

### 4. **server-auth.ts** - Authentication & Authorization
**Purpose:** JWT tokens, sessions, role-based access control, rate limiting
**Dependencies:** jsonwebtoken, crypto
**Key Exports:**
- `generateToken(user)` - Create JWT token
- `generateRefreshToken(user)` - Create refresh token
- `verifyToken(token)` - Verify JWT
- `verifyRefreshToken(token)` - Verify refresh token
- `createSession(user, req)` - Create server session
- `getSession(sessionId)` - Retrieve session data
- `invalidateSession(sessionId)` - Logout
- Middleware: `requireAuth`, `requireSession`, `requireRole(...)`, `rateLimit(maxReq, windowMs)`

**Usage in server.ts:**
```typescript
import { requireAuth, requireRole, rateLimit, generateToken } from './server-auth.ts';

// Protect routes
app.get('/api/admin/users', requireAuth, requireRole('admin'), (req, res) => {
  // Only admins can access
});

// Rate limit by user
app.post('/api/documents', rateLimit(100, 60000), (req, res) => {
  // 100 requests per minute per user
});

// Generate token on login
const token = generateToken({ userId: user.id, email: user.email, role: 'user' });
```

### 5. **server-db.ts** - MongoDB Schemas
**Purpose:** Mongoose schema definitions for persistent data
**Dependencies:** mongoose
**Key Schemas:**

#### DocumentSchema
```typescript
{
  id: String,
  name: String,
  type: 'PDF' | 'DOCX' | 'XLSX' | 'TXT',
  size: String,
  connector: String,
  status: 'raw' | 'processing' | 'refined' | 'failed',
  rawContent: String,
  parsedContent: String,
  cleanedContent: String,
  redactedContent: String,
  metadata: {
    title, category, tags, classification, accessLevel,
    language, author, summary
  },
  chunks: [{ id, text, tokenCount, headingContext }],
  vectorSync: { qdrant, pinecone },
  readinessScore: { score, layoutScore, securityScore, hygieneScore, metadataScore, warnings, recommendations },
  piiFindings: [{ type, value }],
  duplicatesRemoved: Number,
  createdAt: Date
}
```

#### ConnectorSchema
```typescript
{
  id: String,
  name: String,
  type: 'GoogleDrive' | 'GitHub' | 'S3',
  status: 'connected' | 'disconnected' | 'syncing',
  lastSynced: Date,
  filesCount: Number,
  frequency: String,
  credentials: { encrypted: String },
  config: Object,
  createdAt: Date
}
```

#### VectorDbSchema
```typescript
{
  id: String,
  name: String,
  status: 'active' | 'inactive',
  indexName: String,
  dimensions: Number,
  latencyMs: Number,
  vectorsCount: Number,
  embeddingModel: String,
  credentials: { encrypted: String }
}
```

**Usage in server.ts:**
```typescript
import { Document, Connector, VectorDb } from './server-db.ts';

// Query documents
const docs = await Document.find({ status: 'refined' });

// Create document
await Document.create({ name, type, connector, status: 'raw', ... });

// Update document
await Document.findByIdAndUpdate(id, { status: 'refined', metadata });
```

### 6. **server-validation.ts** - Input Validation & Error Handling
**Purpose:** Standardized error handling and input validation
**Dependencies:** Express
**Key Exports:**

#### Error Classes
- `ValidationError` (400)
- `AuthenticationError` (401)
- `AuthorizationError` (403)
- `NotFoundError` (404)
- `InternalServerError` (500)

#### Validators
- `validateDocumentInput(input)` - Check name, rawContent, type, max size (50MB)
- `validateConnectorInput(input)` - Validate connector config
- `validateVectorDbInput(input)` - Validate vector DB config

#### Middleware
- `errorHandler` - Express error middleware to catch and format errors
- `asyncHandler(fn)` - Wrap async routes to catch Promise rejections

**Usage in server.ts:**
```typescript
import { 
  ValidationError, 
  validateDocumentInput, 
  errorHandler, 
  asyncHandler 
} from './server-validation.ts';

app.post('/api/documents', asyncHandler(async (req, res) => {
  validateDocumentInput(req.body); // Throws ValidationError if invalid
  // Process document
}));

// At end of server.ts
app.use(errorHandler);
```

### 7. **server-oauth.ts** - OAuth Authentication
**Purpose:** OAuth flows for Google Drive and GitHub connectors
**Dependencies:** crypto, fetch API
**Key Exports:**
- `generateAuthorizationUrl(provider, state)` - OAuth auth URL with PKCE
- `exchangeCodeForToken(provider, code)` - Exchange code for access token
- `refreshAccessToken(provider, refreshToken)` - Refresh expired tokens
- `getUserInfo(provider, accessToken)` - Get user profile from provider
- `encryptCredential(credential)` - Encrypt secrets
- `decryptCredential(encrypted)` - Decrypt secrets

**Usage in server.ts:**
```typescript
import { 
  generateAuthorizationUrl, 
  exchangeCodeForToken 
} from './server-oauth.ts';

// Step 1: Redirect to OAuth provider
app.get('/api/auth/:provider/authorize', (req, res) => {
  const url = generateAuthorizationUrl(req.params.provider, req.query.state);
  res.redirect(url);
});

// Step 2: Handle callback
app.get('/api/auth/:provider/callback', asyncHandler(async (req, res) => {
  const { code } = req.query;
  const tokens = await exchangeCodeForToken(req.params.provider, code);
  const user = await getUserInfo(req.params.provider, tokens.access_token);
  // Store connector with encrypted credentials
}));
```

### 8. **server-advanced.ts** - Advanced Operations
**Purpose:** Batch operations, exports, filtering, sorting, scheduling
**Dependencies:** json2csv
**Key Exports:**
- `batchRefineDocuments(ids, refineFunction)` - Process 3 docs concurrently
- `batchDeleteDocuments(ids, deleteFunction)` - Batch delete with error tracking
- `exportToJSON(docs)` - Full document export
- `exportToCSV(docs)` - CSV export with field selection
- `exportMarkdownReport(docs)` - Readable markdown report
- `filterDocuments(docs, criteria)` - Multi-field filtering with search
- `sortDocuments(docs, sortBy, order)` - Sort by name/createdAt/readinessScore
- `parseFrequencyToMs(frequency)` - Parse "2h", "daily", etc.
- `getNextSyncTime(frequency)` - Calculate next sync time

**Usage in server.ts:**
```typescript
import { 
  batchRefineDocuments, 
  exportToJSON, 
  filterDocuments 
} from './server-advanced.ts';

// Batch refine with concurrency limit
app.post('/api/batch/refine', asyncHandler(async (req, res) => {
  const { documentIds } = req.body;
  const results = await batchRefineDocuments(documentIds, refineDoc);
  res.json(results);
}));

// Export documents
app.get('/api/documents/export/json', (req, res) => {
  const json = exportToJSON(documentsDb);
  res.json(json);
});
```

## Installation & Setup

### 1. Install New Dependencies

```bash
npm install bull redis mongoose jsonwebtoken express-session passport passport-google-oauth20 passport-github2 pdfparse node-nlp dotenv
```

### 2. Configure Environment Variables

Copy `.env.example` to `.env`:
```bash
cp .env.example .env
```

Edit `.env` with your values:
```env
MONGODB_URI=mongodb://localhost:27017/dhub
REDIS_HOST=localhost
REDIS_PORT=6379
JWT_SECRET=<your-32-char-random-key>
GOOGLE_OAUTH_CLIENT_ID=<from-google-console>
GITHUB_OAUTH_CLIENT_ID=<from-github-settings>
GEMINI_API_KEY=<your-api-key>
```

### 3. Start Services

```bash
# Start MongoDB & Redis with Docker Compose
docker-compose up -d mongo redis

# Or start locally
mongod --dbpath /data/db
redis-server --port 6379
```

### 4. Create Job Queue Processors

Add this to `server.ts` after queue initialization:

```typescript
import { 
  documentRefineQueue, 
  piiDetectionQueue, 
  connectorSyncQueue 
} from './server-queue.ts';
import { detectPII } from './server-pii.ts';
import { parsePDFBuffer } from './server-pdf.ts';

// Process refine jobs
documentRefineQueue.process(async (job) => {
  const doc = await Document.findById(job.data.documentId);
  if (!doc) throw new Error('Document not found');
  
  // Run refinery pipeline
  doc.status = 'processing';
  const pdfData = await parsePDFBuffer(Buffer.from(doc.rawContent));
  doc.parsedContent = pdfData.text;
  
  const { redactedText, findings } = await detectPII(doc.parsedContent);
  doc.redactedContent = redactedText;
  doc.piiFindings = findings;
  
  doc.status = 'refined';
  await doc.save();
  return doc;
});

// Process PII jobs
piiDetectionQueue.process(async (job) => {
  const doc = await Document.findById(job.data.documentId);
  const { redactedText, findings } = await detectPII(doc.parsedContent);
  doc.redactedContent = redactedText;
  doc.piiFindings = findings;
  await doc.save();
  return findings;
});
```

### 5. Connect to MongoDB

Add to `startServer()` function:

```typescript
import mongoose from 'mongoose';
import { Document, Connector, VectorDb } from './server-db.ts';

async function startServer() {
  // Connect to MongoDB
  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/dhub');
  console.log('Connected to MongoDB');

  // Rest of server setup...
}
```

### 6. Add Authentication Middleware

```typescript
import { requireAuth, rateLimit } from './server-auth.ts';

// Apply to protected routes
app.get('/api/documents', requireAuth, (req, res) => {
  // Only authenticated users
});

// Apply rate limiting
app.post('/api/documents', rateLimit(100, 60000), (req, res) => {
  // 100 requests/minute per user
});
```

## Docker Deployment

### Build and Run

```bash
# Build image
docker build -t dhub:latest .

# Run with compose
docker-compose up -d

# Check logs
docker-compose logs -f app
```

### Production Deployment

See [DEPLOYMENT.md](./DEPLOYMENT.md) for:
- AWS ECS deployment
- Google Cloud Run
- Kubernetes setup
- Security checklist
- Monitoring & logging

## Integration Checklist

- [ ] Install all new npm dependencies
- [ ] Copy and configure `.env` file
- [ ] Start MongoDB and Redis services
- [ ] Add queue job processors to `server.ts`
- [ ] Connect Express app to MongoDB
- [ ] Add authentication middleware to routes
- [ ] Update API routes to use Database models instead of in-memory array
- [ ] Test notification system with toast alerts
- [ ] Configure OAuth apps (Google & GitHub)
- [ ] Set up monitoring and error tracking
- [ ] Deploy with Docker Compose or cloud provider

## Testing

### Local Testing

```bash
# Start services
docker-compose up -d

# Run server
npm run dev

# Test API endpoints
curl http://localhost:3000/api/documents

# Upload and refine document
curl -X POST http://localhost:3000/api/documents \
  -H "Content-Type: application/json" \
  -d '{"name": "Test", "type": "TXT", "rawContent": "Sample text with john@example.com"}'
```

### Queue Testing

```bash
# Monitor queue jobs
docker exec dhub-redis redis-cli

# View queue stats
redis-cli info stats
```

## Performance Tuning

### Redis Queue Optimization
```typescript
// Increase concurrency for document processing
documentRefineQueue.process(5, async (job) => {
  // Process up to 5 jobs in parallel
});
```

### MongoDB Indexing
```typescript
// Add indexes for frequently queried fields
db.documents.createIndex({ "status": 1 });
db.documents.createIndex({ "connector": 1 });
db.documents.createIndex({ "createdAt": -1 });
db.connectors.createIndex({ "type": 1 });
```

### Connection Pool Configuration
```env
# In .env
MONGODB_POOL_SIZE=10
REDIS_MAX_RETRIES=3
```

## Troubleshooting

### Queue jobs not processing
```bash
# Check Redis connection
redis-cli ping
# Should return: PONG

# Check queue status
docker-compose exec app npm run queue:status
```

### Database connection errors
```bash
# Verify MongoDB is running
mongosh mongodb://localhost:27017

# Check connection string in .env
echo $MONGODB_URI
```

### High memory usage
```bash
# Check Node.js heap
node --max-old-space-size=2048 dist/server.js
```

## Next Steps

1. **Real Vector Database:** Integrate Qdrant or Pinecone for semantic search
2. **Advanced Search:** Implement MongoDB Atlas Search with text indexes
3. **API Documentation:** Generate Swagger/OpenAPI docs
4. **Monitoring:** Set up Prometheus + Grafana for metrics
5. **CI/CD:** Configure GitHub Actions or GitLab CI for automated testing & deployment
6. **Security:** Implement API rate limiting, CORS restrictions, HTTPS
7. **Caching:** Add Redis caching layer for frequently accessed data

## Support

- Check [DEPLOYMENT.md](./DEPLOYMENT.md) for deployment guides
- Review `.env.example` for all available configuration options
- Monitor Docker logs: `docker-compose logs -f app`
- Test endpoints with Postman or curl before production deployment
