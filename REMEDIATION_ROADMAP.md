# DHub Industry Standards Gap Analysis - Remediation Roadmap

**Total Gaps: 68** | Critical: 17 | High: 36 | Medium: 14 | Low: 1

---

## 🔴 PHASE 1: CRITICAL GAPS (This Week)

### ✅ Already Fixed
- [x] Sessions in-memory Map → server-redis-sessions.ts (15 min)
- [x] PII detection weak → Enhanced patterns + Indian names (1 week work compressed)
- [x] tenantId in schema → Added to Document/Connector/VectorDb (2 hrs)

### ⏳ Immediate Actions Required (Before Production)

#### 1. Wire server.ts to All Modules (CRITICAL) - 3-4 hours
**Status:** 🟡 Modules created, NOT integrated yet  
**What's Missing:** server.ts still uses in-memory array

**Action Items:**
```typescript
// In server.ts, add at TOP:
import mongoose from 'mongoose';
import { Document, Connector, VectorDb } from './server-db.ts';
import { setupJobProcessors } from './server-jobs.ts';
import { requireAuth, requireSession } from './server-auth.ts';

// In startServer():
await mongoose.connect(process.env.MONGODB_URI);
setupJobProcessors();

// Replace all GET /api/documents endpoints:
// OLD: res.json(documentsDb);
// NEW: const docs = await Document.find({ tenantId: req.user.tenantId });
```

**Effort:** 3-4 hours  
**Blockers:** None

---

#### 2. Enforce Authentication on All Routes (CRITICAL) - 2 hours
**Status:** 🟡 Middleware exists but not applied

**Action Items:**
```typescript
// Apply to ALL protected routes:
app.get("/api/documents", requireAuth, async (req, res) => {
  const docs = await Document.find({ tenantId: req.user.tenantId });
  res.json(docs);
});

// Apply rate limiting:
app.post("/api/documents", 
  requireAuth, 
  rateLimit(100, 60000), 
  async (req, res) => { ... }
);
```

**Effort:** 2 hours  
**Blockers:** None

---

#### 3. Fix Password Hashing (CRITICAL) - 2 hours
**Status:** 🔴 Using static salt in server-auth.ts

**Replace:**
```typescript
// CURRENT (WRONG):
export function hashPassword(password: string): string {
  return crypto
    .pbkdf2Sync(password, "salt-change-in-production", 100000, 64, "sha512")
    .toString("hex");
}

// CORRECT:
import bcrypt from 'bcrypt';

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 12);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}
```

**Effort:** 2 hours (install bcrypt, update auth handlers)  
**Blockers:** None

---

#### 4. Encrypt OAuth Tokens at Application Layer (CRITICAL) - 1 day
**Status:** 🟡 Encryption exists but not enforced

**Action Items:**
```typescript
// In Connector.save():
connector.credentials = {
  oauthToken: encryptCredential(req.body.token),
  clientId: req.body.clientId,
  refreshToken: encryptCredential(req.body.refreshToken)
};

// Add to Mongoose pre-save hook:
ConnectorSchema.pre('save', function(next) {
  if (this.credentials.oauthToken && !this.credentials.oauthToken.startsWith('enc:')) {
    this.credentials.oauthToken = encryptCredential(this.credentials.oauthToken);
  }
  next();
});
```

**Effort:** 1 day (audit all credential fields, add hooks)  
**Blockers:** None

---

#### 5. No Real Data Persistence (CRITICAL) - 3 hours
**Status:** 🔴 All docs lost on restart

**Action Items:**
```typescript
// Replace:
let documentsDb: DocumentRecord[] = [...INITIAL_DOCUMENTS];

// With:
// Get from MongoDB on startup
async function getDocuments(tenantId: string) {
  return await Document.find({ tenantId });
}

// Seed initial data if empty:
async function seedInitialData() {
  const count = await Document.countDocuments();
  if (count === 0) {
    await Document.insertMany(INITIAL_DOCUMENTS.map(d => ({
      ...d,
      tenantId: 'default-tenant'
    })));
  }
}
```

**Effort:** 3 hours  
**Blockers:** MongoDB connection required

---

#### 6. Multi-Tenancy Query Middleware (CRITICAL) - 2 days
**Status:** 🟡 Schema has tenantId but queries don't filter

**Action Items:**
Create middleware that auto-injects tenantId:
```typescript
// middleware/tenantFilter.ts
export function tenantFilter(req, res, next) {
  if (req.user) {
    req.tenantId = req.user.tenantId;
    
    // Monkey-patch mongoose Query to auto-filter
    const originalExec = Query.prototype.exec;
    Query.prototype.exec = function() {
      if (this.model.collection.name.match(/(document|connector|vectordb)s?$/i)) {
        this.where({ tenantId: req.tenantId });
      }
      return originalExec.call(this);
    };
  }
  next();
}

app.use(tenantFilter);
```

**Effort:** 2 days  
**Blockers:** Requires testing across all queries

---

#### 7. Audit Logging (CRITICAL) - 1 week
**Status:** 🔴 None exists

**Action Items:**
```typescript
// models/AuditLog.ts
const AuditLogSchema = new Schema({
  tenantId: String,
  userId: String,
  action: String, // READ, CREATE, UPDATE, DELETE
  resource: String, // Document, Connector
  resourceId: String,
  oldValue: Object,
  newValue: Object,
  ipAddress: String,
  timestamp: Date,
});

// middleware/auditLogger.ts
export async function auditLog(action, resource, oldValue, newValue, req) {
  await AuditLog.create({
    tenantId: req.user.tenantId,
    userId: req.user.id,
    action,
    resource,
    oldValue,
    newValue,
    ipAddress: req.ip,
    timestamp: new Date()
  });
}

// Usage in routes:
app.delete('/api/documents/:id', async (req, res) => {
  const doc = await Document.findById(req.params.id);
  await auditLog('DELETE', 'Document', doc, null, req);
  await Document.findByIdAndDelete(req.params.id);
});
```

**Effort:** 1 week  
**Blockers:** None

---

#### 8. No Real Vector DB Calls (CRITICAL) - 2 weeks
**Status:** 🔴 Simulated data only

**Action Items - Qdrant Integration:**
```typescript
// adapters/qdrantAdapter.ts
import { QdrantClient } from "@qdrant/js-client-rest";

const client = new QdrantClient({
  url: process.env.QDRANT_URL || "http://localhost:6333",
  apiKey: process.env.QDRANT_API_KEY,
});

export async function upsertEmbeddings(documentId: string, chunks: any[], embeddings: number[][]) {
  const points = chunks.map((chunk, idx) => ({
    id: `${documentId}-${idx}`,
    vector: embeddings[idx],
    payload: {
      documentId,
      chunkId: chunk.id,
      text: chunk.text,
      headingContext: chunk.headingContext
    }
  }));

  await client.upsert("documents", {
    points: points,
    wait: true
  });
}

export async function queryEmbeddings(query: string, embedding: number[], tenantId: string, limit = 5) {
  return await client.search("documents", {
    vector: embedding,
    limit: limit,
    query_filter: {
      must: [{ key: "tenantId", match: { value: tenantId } }]
    }
  });
}
```

**In server-jobs.ts embeddings processor:**
```typescript
import { upsertEmbeddings } from '../adapters/qdrantAdapter.ts';

embeddingQueue.process(3, async (job) => {
  const { documentId, chunkIds } = job.data;
  const doc = await Document.findById(documentId);
  
  // Get embeddings from OpenAI or local model
  const embeddings = await generateEmbeddings(doc.chunks.map(c => c.text));
  
  // Store in Qdrant
  await upsertEmbeddings(documentId, doc.chunks, embeddings);
  
  doc.vectorSync = { qdrant: { status: "synced", vectorsCount: doc.chunks.length } };
  await doc.save();
});
```

**Effort:** 2 weeks (includes embeddings API integration)  
**Blockers:** Embedding provider credentials (OpenAI, Cohere, etc.)

---

#### 9. Health Check Endpoints (CRITICAL) - 2 hours
**Status:** 🔴 None exist

```typescript
app.get('/health', async (req, res) => {
  const health = {
    status: 'ok',
    timestamp: new Date(),
    checks: {
      database: 'pending',
      redis: 'pending',
      queue: 'pending'
    }
  };

  try {
    await mongoose.connection.db.admin().ping();
    health.checks.database = 'ok';
  } catch (e) {
    health.checks.database = 'error';
    health.status = 'degraded';
  }

  try {
    await redisClient.ping();
    health.checks.redis = 'ok';
  } catch (e) {
    health.checks.redis = 'error';
    health.status = 'degraded';
  }

  try {
    const queueStats = await documentRefineQueue.counts();
    health.checks.queue = 'ok';
  } catch (e) {
    health.checks.queue = 'error';
  }

  res.status(health.status === 'ok' ? 200 : 503).json(health);
});

app.get('/ready', async (req, res) => {
  const isReady = 
    mongoose.connection.readyState === 1 &&
    redisClient.isOpen;
  
  res.status(isReady ? 200 : 503).json({ ready: isReady });
});
```

**Effort:** 2 hours  
**Blockers:** None

---

#### 10. Real PDF Parsing with Layout (CRITICAL) - 2 weeks
**Status:** 🟡 Basic text extraction only

**Action Items - Python Worker:**
```python
# workers/pdf_processor.py
from flask import Flask, request, jsonify
import pymupdf  # PyMuPDF
import camelot
import pytesseract
from PIL import Image

app = Flask(__name__)

@app.route('/parse-pdf', methods=['POST'])
def parse_pdf():
    pdf_path = request.json['path']
    doc = pymupdf.open(pdf_path)
    
    result = {
        'text': '',
        'pages': [],
        'tables': []
    }
    
    for page_num, page in enumerate(doc):
        # Extract text with positioning
        text_blocks = page.get_text("blocks")
        headings = []
        body_text = []
        
        for block in text_blocks:
            if block[-1] == 0:  # Is text block
                text = block[4].strip()
                font_size = page.get_text("dict")['blocks'][0]['lines'][0]['spans'][0]['size']
                
                if font_size > 14:
                    headings.append({'level': 'H1', 'text': text})
                elif font_size > 12:
                    headings.append({'level': 'H2', 'text': text})
                else:
                    body_text.append(text)
        
        result['pages'].append({
            'number': page_num + 1,
            'text': '\n'.join(body_text),
            'headings': headings
        })
    
    # Extract tables with Camelot
    try:
        tables = camelot.read_pdf(pdf_path, pages='all')
        for table in tables:
            result['tables'].append({
                'page': table.page,
                'data': table.df.values.tolist(),
                'confidence': table.accuracy
            })
    except Exception as e:
        print(f"Table extraction failed: {e}")
    
    return jsonify(result)

if __name__ == '__main__':
    app.run(port=5001)
```

**In Node.js, call the worker:**
```typescript
async function parsePDFWithLayout(pdfPath: string) {
  const response = await fetch('http://localhost:5001/parse-pdf', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: pdfPath })
  });
  
  return response.json();
}
```

**Effort:** 2 weeks (includes Python worker setup)  
**Blockers:** Python environment, PyMuPDF, Camelot installations

---

## 🟡 PHASE 2: HIGH-PRIORITY GAPS (2-4 Weeks)

| Gap | Effort | Owner | Status |
|-----|--------|-------|--------|
| PostgreSQL migration + RLS | 3 weeks | Backend | 📅 |
| Python worker pool (Celery) | 2-3 weeks | DevOps | 📅 |
| Advanced chunking modes | 2 weeks | ML Eng | 📅 |
| Real connectors (Google Drive, Notion, etc.) | 8-12 weeks | Backend | 📅 |
| CI/CD pipeline (GitHub Actions) | 1 week | DevOps | 📅 |
| OpenAPI/Swagger documentation | 1 week | Docs | 📅 |
| Prometheus + Grafana monitoring | 1 week | DevOps | 📅 |
| Sentry error tracking integration | 1 day | DevOps | 📅 |
| Structured JSON logging | 2 days | Backend | 📅 |
| S3/R2 object storage integration | 1 week | Backend | 📅 |
| Database migrations (Flyway) | 1 week | DevOps | 📅 |
| Secrets Manager integration (AWS/Vault) | 3 days | DevOps | 📅 |
| Token-based chunking (tiktoken) | 3 days | ML Eng | 📅 |
| SAML/OIDC SSO support | 2 weeks | Auth | 📅 |
| Billing integration (Stripe) | 3 weeks | Backend | 📅 |

---

## 🟢 PHASE 3: COMPLIANCE & ENTERPRISE (6+ Months)

- [ ] SOC2 certification (6 months)
- [ ] HIPAA BAA & PHI controls (3 months)
- [ ] GDPR compliance (2 months)
- [ ] Graceful shutdown handlers (1 day)
- [ ] Separate worker deployments (2 weeks)
- [ ] Database backups & recovery (1 day)
- [ ] Incremental sync for connectors (1 week)
- [ ] Scheduled connector sync (1 week)
- [ ] Heading/structure detection for PDFs (3 days)
- [ ] OCR for scanned PDFs (1 week)
- [ ] Address detection in PII (3 days)
- [ ] Test coverage enforcement (1 day)
- [ ] Zero-downtime deployments (2 weeks)

---

## 📋 Action Plan for Next 2 Weeks

### Week 1: Critical Foundation
- [ ] Wire server.ts to MongoDB + job processors (3-4 hrs)
- [ ] Enforce auth on all routes (2 hrs)
- [ ] Fix password hashing with bcrypt (2 hrs)
- [ ] Add health/ready endpoints (2 hrs)
- [ ] Test complete document pipeline (4 hrs)

**Total: ~13 hours**

### Week 2: Data & Compliance
- [ ] Implement multi-tenancy query middleware (2 days)
- [ ] Add audit logging (3 days)
- [ ] Encrypt OAuth tokens (1 day)
- [ ] Set up Redis sessions in production code (1 day)
- [ ] Test multi-user scenarios (2 days)

**Total: ~2 weeks**

---

## 🎯 Prioritization Matrix

**Must Have (This Month):**
1. Wire modules to server.ts ✅
2. Auth enforcement ✅
3. Data persistence ✅
4. Multi-tenancy isolation ✅
5. Audit logging ✅

**Should Have (Next Month):**
- Real vector DB calls
- Python workers for PDF/PII
- PostgreSQL migration
- CI/CD pipeline

**Nice to Have (Q3+):**
- Compliance certifications
- Advanced connectors
- Billing system
- SSO/SAML

---

## Success Metrics

- ✅ Zero data loss on restart
- ✅ 100% auth-protected routes
- ✅ Audit trail for all sensitive operations
- ✅ Multi-tenant data isolation verified
- ✅ <2s p99 document processing latency
- ✅ <5% error rate on vector operations
- ✅ 99.9% uptime with health checks
- ✅ Graceful queue draining on shutdown

---

## Next Steps

**Immediate (Today):**
1. Review this roadmap
2. Prioritize Phase 1 items
3. Create Jira/GitHub issues for each gap
4. Assign owners

**This Week:**
1. Start with "Wire server.ts" - largest blocker
2. Test with real MongoDB data
3. Verify multi-tenancy isolation
4. Run load test with concurrent users

**Next Week:**
1. Deploy Phase 1 to staging
2. Conduct security audit
3. Plan Phase 2 architecture
4. Begin Python worker setup
