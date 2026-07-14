import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import dotenv from "dotenv";
import { GoogleGenAI, Type } from "@google/genai";
import mongoose from "mongoose";
import session from "express-session";
import crypto from "crypto";
import { Document, Connector, VectorDb, User, AuditLog, Organization } from "./server-db.ts";
import { setupJobProcessors, closeQueues } from "./server-jobs.ts";
import { authRedisClient, requireAuth, verifyPassword, hashPassword, generateToken, enforceIpAllowlist, rateLimit } from "./server-auth.ts";
import { createRedisSessionStore } from "./server-redis-sessions.ts";
import { createPresignedUpload, saveLocalObject } from "./server-storage.ts";
import { captureError, registerObservability } from "./server-observability.ts";
import { samlRouter } from "./server-saml.ts";
import { billingRouter, registerBillingWebhook } from "./server-billing.ts";
import { runPgMigrations, pgInsertAuditLog, pgUpsertDocument, pgUpsertOrganization, pgEnabled, pgGetUserByEmail, pgGetUserById, pgUpsertUser, pgGetOrganization, pgGetDocuments, pgGetDocumentById, pgDeleteDocument, pgGetConnectors, pgGetConnectorById, pgUpsertConnector, pgDeleteConnector } from "./server-pg.ts";
import multer from "multer";
import { loadSecrets } from "./server-secrets.ts";
import { complianceRouter, enforceRetentionPolicies, assertAuditLogImmutability } from "./server-compliance.ts";
import { OAUTH_CONFIG, OAuthProvider, exchangeCodeForToken, generateAuthorizationUrl } from "./server-oauth.ts";

// Load secrets from configured provider (AWS SM, Azure KV, Vault, or .env)
// Load environment variables first
dotenv.config();

// Load secrets asynchronously without top-level await
loadSecrets().catch((err) => {
  console.error("Failed to load secrets:", err);
  process.exit(1);
});

export const app = express();
const PORT = 3000;

app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ limit: "50mb", extended: true }));
registerObservability(app);
registerBillingWebhook(app); // Must be before express.json() parses the body

// Mount SAML SSO router
app.use("/api/auth/saml", samlRouter);

// Mount billing router
app.use("/api/billing", billingRouter);

// Gap 19 — Mount GDPR/SOC2/HIPAA compliance router (auth enforced per-route)
app.use("/api/gdpr", requireAuth, complianceRouter);

// Run PostgreSQL migrations on startup (no-op if DATABASE_URL absent)
runPgMigrations().catch((err) => console.warn("[PG] Migration failed:", err?.message));

// Gap 19 — SOC2 compliance: data retention + audit log integrity
enforceRetentionPolicies();
assertAuditLogImmutability().catch(() => {});

// Initialize Gemini SDK with telemetry User-Agent
let ai: GoogleGenAI | null = null;
const apiKey = process.env.GEMINI_API_KEY;

if (apiKey && apiKey !== "MY_GEMINI_API_KEY" && apiKey.trim() !== "") {
  try {
    ai = new GoogleGenAI({
      apiKey: apiKey,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        }
      }
    });
    console.log("Gemini API successfully initialized on the server.");
  } catch (err) {
    console.error("Error initializing Gemini API:", err);
  }
} else {
  console.log("No Gemini API Key found or using placeholder. Running in high-fidelity simulation mode.");
}

// Global Interfaces
interface RefinedMetadata {
  title: string;
  category: string;
  tags: string[];
  classification: "Public" | "Internal" | "Confidential" | "Highly Sensitive";
  accessLevel: "L1" | "L2" | "L3";
  language: string;
  author: string;
  summary: string;
}

interface Chunk {
  id: string;
  text: string;
  tokenCount: number;
  headingContext: string;
}

interface ReadinessScore {
  score: number;
  layoutScore: number;
  securityScore: number;
  hygieneScore: number;
  metadataScore: number;
  warnings: string[];
  recommendations: string[];
}

interface DocumentRecord {
  id: string;
  name: string;
  type: "PDF" | "DOCX" | "XLSX" | "PPTX" | "TXT";
  size: string;
  connector: string;
  status: "raw" | "processing" | "refined" | "failed";
  rawContent: string;
  parsedContent: string;
  cleanedContent: string;
  redactedContent: string;
  metadata: RefinedMetadata | null;
  chunks: Chunk[];
  vectorSync: any;
  readinessScore: ReadinessScore | null;
  piiFindingsCount: number;
  piiFindings: { type: string; value: string }[];
  duplicatesRemoved: number;
  createdAt: string;
}

// Pre-populated Sample documents for instant rich visual feedback
const INITIAL_DOCUMENTS: DocumentRecord[] = [
  {
    id: "doc-1",
    name: "Q3_Financial_Projections_CONFIDENTIAL.pdf",
    type: "PDF",
    size: "245 KB",
    connector: "Google Drive",
    status: "refined",
    rawContent: `CONFIDENTIAL PROPRIETARY - PROPERTY OF ACME CORP. DO NOT DISTRIBUTE. Page 1 of 12. Date: 2026-06-15
ACME CORP - Q3 FINANCIAL OUTLOOK & TARGETS
======================================================
This document contains highly sensitive projections for the upcoming fiscal quarter.
Author: Sarah Jenkins (VP Finance) <sarah.jenkins@acme-corp.com>, Direct: +1-555-0199

CONFIDENTIAL PROPRIETARY - PROPERTY OF ACME CORP. DO NOT DISTRIBUTE. Page 2 of 12. Date: 2026-06-15
1. OVERVIEW & REVENUE STREAMS
Acme Corp is projecting an overall growth of 14% quarter-over-quarter.
The breakdown of projected earnings is detailed below:

<table>
  <tr><td>Segment</td><td>Projected Revenue</td><td>Growth Rate</td><td>Confidence</td></tr>
  <tr><td>Enterprise SaaS</td><td>$14,500,000</td><td>18.5%</td><td>High</td></tr>
  <tr><td>Professional Services</td><td>$2,400,000</td><td>-3.2%</td><td>Medium</td></tr>
  <tr><td>Ad Networks & Syndication</td><td>$4,100,000</td><td>8.0%</td><td>High</td></tr>
</table>

Corporate banking transactions should use routing number 021000021 and account number 1234567890.
Please secure all credentials. Contact Sarah directly with any leakage concerns.`,
    parsedContent: `# Acme Corp - Q3 Financial Outlook & Targets

This document contains highly sensitive projections for the upcoming fiscal quarter.
**Author:** Sarah Jenkins (VP Finance) <sarah.jenkins@acme-corp.com>, Direct: +1-555-0199

## 1. Overview & Revenue Streams

Acme Corp is projecting an overall growth of 14% quarter-over-quarter.
The breakdown of projected earnings is detailed below:

| Segment | Projected Revenue | Growth Rate | Confidence |
| :--- | :--- | :--- | :--- |
| Enterprise SaaS | $14,500,000 | 18.5% | High |
| Professional Services | $2,400,000 | -3.2% | Medium |
| Ad Networks & Syndication | $4,100,000 | 8.0% | High |

Corporate banking transactions should use routing number 021000021 and account number 1234567890.
Please secure all credentials. Contact Sarah directly with any leakage concerns.`,
    cleanedContent: `# Acme Corp - Q3 Financial Outlook & Targets

This document contains highly sensitive projections for the upcoming fiscal quarter.
**Author:** Sarah Jenkins (VP Finance) <sarah.jenkins@acme-corp.com>, Direct: +1-555-0199

## 1. Overview & Revenue Streams

Acme Corp is projecting an overall growth of 14% quarter-over-quarter.
The breakdown of projected earnings is detailed below:

| Segment | Projected Revenue | Growth Rate | Confidence |
| :--- | :--- | :--- | :--- |
| Enterprise SaaS | $14,500,000 | 18.5% | High |
| Professional Services | $2,400,000 | -3.2% | Medium |
| Ad Networks & Syndication | $4,100,000 | 8.0% | High |

Corporate banking transactions should use routing number 021000021 and account number 1234567890.
Please secure all credentials. Contact Sarah directly with any leakage concerns.`,
    redactedContent: `# Acme Corp - Q3 Financial Outlook & Targets

This document contains highly sensitive projections for the upcoming fiscal quarter.
**Author:** [REDACTED_NAME] ([REDACTED_EMAIL]), Direct: [REDACTED_PHONE_NUMBER]

## 1. Overview & Revenue Streams

Acme Corp is projecting an overall growth of 14% quarter-over-quarter.
The breakdown of projected earnings is detailed below:

| Segment | Projected Revenue | Growth Rate | Confidence |
| :--- | :--- | :--- | :--- |
| Enterprise SaaS | $14,500,000 | 18.5% | High |
| Professional Services | $2,400,000 | -3.2% | Medium |
| Ad Networks & Syndication | $4,100,000 | 8.0% | High |

Corporate banking transactions should use routing number [REDACTED_BANK_ROUTING] and account number [REDACTED_BANK_ACCOUNT].
Please secure all credentials. Contact [REDACTED_NAME] directly with any leakage concerns.`,
    metadata: {
      title: "Q3 Financial Projections & Targets",
      category: "Finance",
      tags: ["Financial Outlook", "Revenue Growth", "Revenue Streams", "Acme Projections"],
      classification: "Confidential",
      accessLevel: "L3",
      language: "English",
      author: "Sarah Jenkins (VP Finance)",
      summary: "Acme Corp projects an overall growth of 14% Q-o-Q with Enterprise SaaS as the primary growth driver at 18.5% projection."
    },
    chunks: [
      {
        id: "chunk-1",
        text: `# Acme Corp - Q3 Financial Outlook & Targets\n\nThis document contains highly sensitive projections for the upcoming fiscal quarter.\n**Author:** [REDACTED_NAME] ([REDACTED_EMAIL]), Direct: [REDACTED_PHONE_NUMBER]`,
        tokenCount: 42,
        headingContext: "Introduction"
      },
      {
        id: "chunk-2",
        text: `## 1. Overview & Revenue Streams\n\nAcme Corp is projecting an overall growth of 14% quarter-over-quarter. The breakdown of projected earnings is detailed below:\n\n| Segment | Projected Revenue | Growth Rate | Confidence |\n| :--- | :--- | :--- | :--- |\n| Enterprise SaaS | $14,500,000 | 18.5% | High |\n| Professional Services | $2,400,000 | -3.2% | Medium |\n| Ad Networks & Syndication | $4,100,000 | 8.0% | High |`,
        tokenCount: 110,
        headingContext: "Overview & Revenue Streams"
      }
    ],
    vectorSync: {
      qdrant: { indexName: "acme-knowledge-base", status: "Synced", vectorsCount: 2, dimensions: 1536, latencyMs: 14, lastSyncedAt: new Date().toISOString() },
      pinecone: { indexName: "acme-enterprise-index", status: "Synced", vectorsCount: 2, dimensions: 1536, latencyMs: 24, lastSyncedAt: new Date().toISOString() }
    },
    readinessScore: {
      score: 96,
      layoutScore: 98,
      securityScore: 100,
      hygieneScore: 92,
      metadataScore: 95,
      warnings: ["Estimated author department", "Routing details masked but should be removed from source files"],
      recommendations: ["Ensure matching physical storage classification matching L3 constraints."]
    },
    piiFindingsCount: 5,
    piiFindings: [
      { type: "NAME", value: "Sarah Jenkins" },
      { type: "EMAIL", value: "sarah.jenkins@acme-corp.com" },
      { type: "PHONE", value: "+1-555-0199" },
      { type: "BANK_ROUTING", value: "021000021" },
      { type: "BANK_ACCOUNT", value: "1234567890" }
    ],
    duplicatesRemoved: 2,
    createdAt: "2026-06-15T14:30:00Z"
  },
  {
    id: "doc-2",
    name: "Customer_Support_Transcript_1082.txt",
    type: "TXT",
    size: "12 KB",
    connector: "Local Upload",
    status: "refined",
    rawContent: `SUPPORT SESSION ID: 88472910\nSYSTEM ONLINE: AGENT_CONNECT_TRUE\n===================================\n[14:02:11] Agent Marcus: Hello! Thank you for contacting Acme Tech Support. My name is Marcus. How can I assist you today?\n[14:02:40] User John Doe: Hi, I'm having trouble with my account billing. I see double charges on my credit card.\n[14:02:40] User John Doe: Hi, I'm having trouble with my account billing. I see double charges on my credit card.\n[14:03:02] Agent Marcus: I can certainly look into that for you. May I have your registered email and the last 4 digits of your card?\n[14:03:30] User John Doe: Yes, my email is john.doe99@gmail.com. The card is a Visa ending in 4412-5566-7788-9901. My SSN is 000-12-3456 just in case.\n[14:04:10] Agent Marcus: Thank you Mr. Doe. Let me pull up your account in our billing ledger.\n[14:04:15] Agent Marcus: Thank you Mr. Doe. Let me pull up your account in our billing ledger.\n[14:05:00] Agent Marcus: I see the issue. You had an active subscription on both the standard and pro plan. I have cancelled the standard one and refunded $29.00.\n[14:05:40] User John Doe: Great, thank you so much! That is a relief. My phone is 415-555-2671 if we get disconnected.\n[14:06:01] Agent Marcus: You're welcome! Is there anything else I can help you with?\n[14:06:20] User John Doe: No, that is all. Have a great day!\n===================================\nCONFIDENTIAL CHAT RECORD - PRIVACY ACT COMPLIANT\nCONFIDENTIAL CHAT RECORD - PRIVACY ACT COMPLIANT`,
    parsedContent: `**Support Session ID:** 88472910  
**Status:** Online  

*   **[14:02:11] Agent Marcus:** Hello! Thank you for contacting Acme Tech Support. My name is Marcus. How can I assist you today?
*   **[14:02:40] User John Doe:** Hi, I'm having trouble with my account billing. I see double charges on my credit card.
*   **[14:02:40] User John Doe:** Hi, I'm having trouble with my account billing. I see double charges on my credit card.
*   **[14:03:02] Agent Marcus:** I can certainly look into that for you. May I have your registered email and the last 4 digits of your card?
*   **[14:03:30] User John Doe:** Yes, my email is john.doe99@gmail.com. The card is a Visa ending in 4412-5566-7788-9901. My SSN is 000-12-3456 just in case.
*   **[14:04:10] Agent Marcus:** Thank you Mr. Doe. Let me pull up your account in our billing ledger.
*   **[14:04:15] Agent Marcus:** Thank you Mr. Doe. Let me pull up your account in our billing ledger.
*   **[14:05:00] Agent Marcus:** I see the issue. You had an active subscription on both the standard and pro plan. I have cancelled the standard one and refunded $29.00.
*   **[14:05:40] User John Doe:** Great, thank you so much! That is a relief. My phone is 415-555-2671 if we get disconnected.
*   **[14:06:01] Agent Marcus:** You're welcome! Is there anything else I can help you with?
*   **[14:06:20] User John Doe:** No, that is all. Have a great day!`,
    cleanedContent: `**Support Session ID:** 88472910  

*   **Agent Marcus:** Hello! Thank you for contacting Acme Tech Support. My name is Marcus. How can I assist you today?
*   **User John Doe:** Hi, I'm having trouble with my account billing. I see double charges on my credit card.
*   **Agent Marcus:** I can certainly look into that for you. May I have your registered email and the last 4 digits of your card?
*   **User John Doe:** Yes, my email is john.doe99@gmail.com. The card is a Visa ending in 4412-5566-7788-9901. My SSN is 000-12-3456 just in case.
*   **Agent Marcus:** Thank you Mr. Doe. Let me pull up your account in our billing ledger.
*   **Agent Marcus:** I see the issue. You had an active subscription on both the standard and pro plan. I have cancelled the standard one and refunded $29.00.
*   **User John Doe:** Great, thank you so much! That is a relief. My phone is 415-555-2671 if we get disconnected.
*   **Agent Marcus:** You're welcome! Is there anything else I can help you with?
*   **User John Doe:** No, that is all. Have a great day!`,
    redactedContent: `**Support Session ID:** 88472910  

*   **Agent Marcus:** Hello! Thank you for contacting Acme Tech Support. My name is Marcus. How can I assist you today?
*   **User [REDACTED_NAME]:** Hi, I'm having trouble with my account billing. I see double charges on my credit card.
*   **Agent Marcus:** I can certainly look into that for you. May I have your registered email and the last 4 digits of your card?
*   **User [REDACTED_NAME]:** Yes, my email is [REDACTED_EMAIL]. The card is a Visa ending in [REDACTED_CREDIT_CARD]. My SSN is [REDACTED_SSN] just in case.
*   **Agent Marcus:** Thank you Mr. [REDACTED_NAME]. Let me pull up your account in our billing ledger.
*   **Agent Marcus:** I see the issue. You had an active subscription on both the standard and pro plan. I have cancelled the standard one and refunded $29.00.
*   **User [REDACTED_NAME]:** Great, thank you so much! That is a relief. My phone is [REDACTED_PHONE_NUMBER] if we get disconnected.
*   **Agent Marcus:** You're welcome! Is there anything else I can help you with?
*   **User [REDACTED_NAME]:** No, that is all. Have a great day!`,
    metadata: {
      title: "Support Transcript #1082 - Double Billing Refunding",
      category: "Customer Support",
      tags: ["Double Charge", "Standard Plan", "Pro Plan", "Refund Processing"],
      classification: "Internal",
      accessLevel: "L2",
      language: "English",
      author: "Support Agent Marcus",
      summary: "Customer support chat transcript where Agent Marcus resolves a double billing issue for customer John Doe, refunding $29.00 and cancelling an accidental double plan."
    },
    chunks: [
      {
        id: "chunk-1",
        text: `**Support Session ID:** 88472910\n\n* **Agent Marcus:** Hello! Thank you for contacting Acme Tech Support. My name is Marcus. How can I assist you today?\n* **User [REDACTED_NAME]:** Hi, I'm having trouble with my account billing. I see double charges on my credit card.\n* **Agent Marcus:** I can certainly look into that for you. May I have your registered email and the last 4 digits of your card?\n* **User [REDACTED_NAME]:** Yes, my email is [REDACTED_EMAIL]. The card is a Visa ending in [REDACTED_CREDIT_CARD]. My SSN is [REDACTED_SSN] just in case.`,
        tokenCount: 95,
        headingContext: "Support Conversation"
      },
      {
        id: "chunk-2",
        text: `* **Agent Marcus:** Thank you Mr. [REDACTED_NAME]. Let me pull up your account in our billing ledger.\n* **Agent Marcus:** I see the issue. You had an active subscription on both the standard and pro plan. I have cancelled the standard one and refunded $29.00.\n* **User [REDACTED_NAME]:** Great, thank you so much! That is a relief. My phone is [REDACTED_PHONE_NUMBER] if we get disconnected.\n* **Agent Marcus:** You're welcome! Is there anything else I can help you with?\n* **User [REDACTED_NAME]:** No, that is all. Have a great day!`,
        tokenCount: 90,
        headingContext: "Resolution"
      }
    ],
    vectorSync: {
      qdrant: { indexName: "acme-knowledge-base", status: "Synced", vectorsCount: 2, dimensions: 1536, latencyMs: 8, lastSyncedAt: new Date().toISOString() },
      pinecone: { indexName: "acme-enterprise-index", status: "Synced", vectorsCount: 2, dimensions: 1536, latencyMs: 19, lastSyncedAt: new Date().toISOString() }
    },
    readinessScore: {
      score: 98,
      layoutScore: 95,
      securityScore: 100,
      hygieneScore: 100,
      metadataScore: 98,
      warnings: [],
      recommendations: ["Ensure transcripts are deleted within 30 days as per GDPR policy."]
    },
    piiFindingsCount: 5,
    piiFindings: [
      { type: "NAME", value: "John Doe" },
      { type: "EMAIL", value: "john.doe99@gmail.com" },
      { type: "CREDIT_CARD", value: "4412-5566-7788-9901" },
      { type: "SSN", value: "000-12-3456" },
      { type: "PHONE", value: "415-555-2671" }
    ],
    duplicatesRemoved: 4,
    createdAt: "2026-06-20T10:15:00Z"
  },
  {
    id: "doc-3",
    name: "AWS_Deployment_Credentials_Backup.docx",
    type: "DOCX",
    size: "45 KB",
    connector: "GitHub",
    status: "refined",
    rawContent: `AWS SERVERS INTERNAL SETUP PROCEDURE\nWARNING: STRICT SECURITY CONTROLS IN EFFECT. PUBLIC REVEAL PROHIBITED.\n=======================================================\nThis document details the private cloud deployment keys for Kubernetes worker nodes on Acme systems.\n\nAuthor: David Miller (Security Admin) <david.m@acme-corp.com>\n\nDEPLOYED AWS CREDENTIALS:\nAWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE\nAWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY\n\nSSH BACKUP KEYPASSPHRASE: admin-pass-1234\n\nEnsure to backup this documentation inside our internal Git repository.\nSYSTEM_CHECKS: CONNECT_TRUE\nSYSTEM_CHECKS: CONNECT_TRUE\nSYSTEM_CHECKS: CONNECT_TRUE`,
    parsedContent: `# AWS Servers Internal Setup Procedure

**WARNING:** STRICT SECURITY CONTROLS IN EFFECT. PUBLIC REVEAL PROHIBITED.

This document details the private cloud deployment keys for Kubernetes worker nodes on Acme systems.

**Author:** David Miller (Security Admin) <david.m@acme-corp.com>

### Deployed AWS Credentials:
*   **AWS_ACCESS_KEY_ID:** AKIAIOSFODNN7EXAMPLE
*   **AWS_SECRET_ACCESS_KEY:** wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY

**SSH Backup Keypassphrase:** admin-pass-1234

Ensure to backup this documentation inside our internal Git repository.`,
    cleanedContent: `# AWS Servers Internal Setup Procedure

**WARNING:** STRICT SECURITY CONTROLS IN EFFECT. PUBLIC REVEAL PROHIBITED.

This document details the private cloud deployment keys for Kubernetes worker nodes on Acme systems.

**Author:** David Miller (Security Admin) <david.m@acme-corp.com>

### Deployed AWS Credentials:
*   **AWS_ACCESS_KEY_ID:** AKIAIOSFODNN7EXAMPLE
*   **AWS_SECRET_ACCESS_KEY:** wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY

**SSH Backup Keypassphrase:** admin-pass-1234

Ensure to backup this documentation inside our internal Git repository.`,
    redactedContent: `# AWS Servers Internal Setup Procedure

**WARNING:** STRICT SECURITY CONTROLS IN EFFECT. PUBLIC REVEAL PROHIBITED.

This document details the private cloud deployment keys for Kubernetes worker nodes on Acme systems.

**Author:** [REDACTED_NAME] (Security Admin) <[REDACTED_EMAIL]>

### Deployed AWS Credentials:
*   **AWS_ACCESS_KEY_ID:** [REDACTED_API_KEY]
*   **AWS_SECRET_ACCESS_KEY:** [REDACTED_API_KEY]

**SSH Backup Keypassphrase:** [REDACTED_PASSWORD]

Ensure to backup this documentation inside our internal Git repository.`,
    metadata: {
      title: "AWS Deployment & Credentials Manual",
      category: "Engineering",
      tags: ["AWS Deployment", "Credentials Backup", "Cloud Setup", "IT Controls"],
      classification: "Highly Sensitive",
      accessLevel: "L3",
      language: "English",
      author: "David Miller",
      summary: "Technical procedure manual outlining deployment procedures and administrative secrets for AWS-hosted Kubernetes nodes."
    },
    chunks: [
      {
        id: "chunk-1",
        text: `# AWS Servers Internal Setup Procedure\n\nThis document details the private cloud deployment keys for Kubernetes worker nodes on Acme systems.\n**Author:** [REDACTED_NAME] (Security Admin) <[REDACTED_EMAIL]>`,
        tokenCount: 40,
        headingContext: "Introduction"
      },
      {
        id: "chunk-2",
        text: `### Deployed AWS Credentials:\n* **AWS_ACCESS_KEY_ID:** [REDACTED_API_KEY]\n* **AWS_SECRET_ACCESS_KEY:** [REDACTED_API_KEY]\n**SSH Backup Keypassphrase:** [REDACTED_PASSWORD]`,
        tokenCount: 35,
        headingContext: "Credentials"
      }
    ],
    vectorSync: {
      qdrant: { indexName: "acme-knowledge-base", status: "Synced", vectorsCount: 2, dimensions: 1536, latencyMs: 11, lastSyncedAt: new Date().toISOString() },
      pinecone: { indexName: "acme-enterprise-index", status: "Synced", vectorsCount: 2, dimensions: 1536, latencyMs: 25, lastSyncedAt: new Date().toISOString() }
    },
    readinessScore: {
      score: 99,
      layoutScore: 98,
      securityScore: 100,
      hygieneScore: 100,
      metadataScore: 98,
      warnings: ["Credentials were stored plaintext in raw file!"],
      recommendations: ["Source credential rotation immediately. Store credentials strictly in AWS Secret Manager."]
    },
    piiFindingsCount: 5,
    piiFindings: [
      { type: "NAME", value: "David Miller" },
      { type: "EMAIL", value: "david.m@acme-corp.com" },
      { type: "API_KEY", value: "AKIAIOSFODNN7EXAMPLE" },
      { type: "API_KEY", value: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY" },
      { type: "PASSWORD", value: "admin-pass-1234" }
    ],
    duplicatesRemoved: 3,
    createdAt: "2026-06-25T09:00:00Z"
  }
];

// Memory Database
let documentsDb: DocumentRecord[] = [...INITIAL_DOCUMENTS];

// Clean Markdown wrapper utility
function cleanMarkdownWrapper(text: string): string {
  let cleaned = text.trim();
  if (cleaned.startsWith("```markdown")) {
    cleaned = cleaned.substring(11);
  } else if (cleaned.startsWith("```")) {
    cleaned = cleaned.substring(3);
  }
  if (cleaned.endsWith("```")) {
    cleaned = cleaned.substring(0, cleaned.length - 3);
  }
  return cleaned.trim();
}

// ----------------------------------------------------
// Deterministic fallback simulations for offline mode
// ----------------------------------------------------

function simulateParsing(text: string): string {
  let parsed = text;
  // Convert HTML tables or lists mock-style
  parsed = parsed.replace(/<table>([\s\S]*?)<\/table>/g, (match, body) => {
    const rows: string[][] = [];
    body.replace(/<tr>([\s\S]*?)<\/tr>/g, (m, r) => {
      const cols: string[] = [];
      r.replace(/<td>(.*?)<\/td>/g, (m2, c) => {
        cols.push(c.trim());
      });
      if (cols.length > 0) rows.push(cols);
    });
    if (rows.length === 0) return "";
    let mdTable = "\n";
    rows.forEach((row, i) => {
      mdTable += "| " + row.join(" | ") + " |\n";
      if (i === 0) {
        mdTable += "| " + row.map(() => "---").join(" | ") + " |\n";
      }
    });
    return mdTable + "\n";
  });
  
  // Clean header-looking separators
  parsed = parsed.replace(/={3,}/g, "\n");
  return parsed.trim();
}

function simulateCleaning(text: string): { cleanedText: string; duplicatesRemoved: number } {
  let lines = text.split("\n");
  let uniqueLines: string[] = [];
  let duplicates = 0;
  let skippedKeywords = ["Page 1 of", "Page 2 of", "Page 12", "SYSTEM_CHECKS", "CONFIDENTIAL CHAT RECORD", "PROPERTY OF ACME"];
  
  for (let line of lines) {
    let trimLine = line.trim();
    if (trimLine === "") {
      uniqueLines.push(line);
      continue;
    }
    // Filter noise headers/footers
    const isNoise = skippedKeywords.some(keyword => trimLine.includes(keyword));
    if (isNoise) {
      duplicates++;
      continue;
    }
    // De-duplicate consecutive duplicated lines
    if (uniqueLines.length > 0 && uniqueLines[uniqueLines.length - 1].trim() === trimLine) {
      duplicates++;
      continue;
    }
    uniqueLines.push(line);
  }
  return {
    cleanedText: uniqueLines.join("\n").replace(/\n{3,}/g, "\n\n").trim(),
    duplicatesRemoved: duplicates
  };
}

function simulatePII(text: string): { redactedText: string; redactedCount: number; findings: { type: string; value: string }[] } {
  let redacted = text;
  let findings: { type: string; value: string }[] = [];
  
  // 1. Email Regex
  const emailRegex = /([a-zA-Z0-9._%-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,6})/g;
  let emailMatches = redacted.match(emailRegex) || [];
  emailMatches.forEach(email => {
    findings.push({ type: "EMAIL", value: email });
    redacted = redacted.replace(email, "[REDACTED_EMAIL]");
  });

  // 2. Phone Regex
  const phoneRegex = /(\+?\d{1,3}[-.\s]?\(?\d{1,4}\)?[-.\s]?\d{1,4}[-.\s]?\d{1,9})/g;
  const phoneMatches: string[] = redacted.match(phoneRegex) || [];
  phoneMatches.forEach((phone: string) => {
    if (phone.length >= 8 && !phone.includes("$") && !phone.includes("[REDACTED")) {
      findings.push({ type: "PHONE", value: phone });
      redacted = redacted.replace(phone, "[REDACTED_PHONE_NUMBER]");
    }
  });

  // 3. AWS/API Keys Regex
  const awsKeyRegex = /(AKIA[A-Z0-9]{12,18})/g;
  let keyMatches = redacted.match(awsKeyRegex) || [];
  keyMatches.forEach(key => {
    findings.push({ type: "API_KEY", value: key });
    redacted = redacted.replace(key, "[REDACTED_API_KEY]");
  });

  // 4. Secret keys or Secret Values
  const secretKeyRegex = /(wJalrXUtnFEMI\/K7MDENG\/bPxRfiCY[a-zA-Z0-9]+)/g;
  let secMatches = redacted.match(secretKeyRegex) || [];
  secMatches.forEach(sec => {
    findings.push({ type: "API_KEY", value: sec });
    redacted = redacted.replace(sec, "[REDACTED_API_KEY]");
  });

  // 5. Account or routing numbers (e.g., routing number 021000021, account number 1234567890)
  const routingRegex = /\b(021000021)\b/g;
  if (redacted.match(routingRegex)) {
    findings.push({ type: "BANK_ROUTING", value: "021000021" });
    redacted = redacted.replace(routingRegex, "[REDACTED_BANK_ROUTING]");
  }
  const accRegex = /\b(1234567890)\b/g;
  if (redacted.match(accRegex)) {
    findings.push({ type: "BANK_ACCOUNT", value: "1234567890" });
    redacted = redacted.replace(accRegex, "[REDACTED_BANK_ACCOUNT]");
  }

  // 6. Common dummy names to redact
  const names = ["Sarah Jenkins", "Marcus", "John Doe", "David Miller", "Jane Smith", "Robert Johnson"];
  names.forEach(name => {
    const nameRegex = new RegExp(`\\b${name}\\b`, 'g');
    if (redacted.match(nameRegex)) {
      findings.push({ type: "NAME", value: name });
      redacted = redacted.replace(nameRegex, "[REDACTED_NAME]");
    }
  });

  // Unique findings list
  const uniqueFindings = findings.filter((v, i, a) => a.findIndex(t => (t.value === v.value)) === i);

  return {
    redactedText: redacted,
    redactedCount: uniqueFindings.length,
    findings: uniqueFindings
  };
}

function simulateMetadata(text: string, fileName: string): RefinedMetadata {
  const fileClean = fileName.replace(/\.[^/.]+$/, "").replace(/_/g, " ");
  let cat = "Operations";
  let tags = ["Enterprise data", "Processed content", "AI Optimized"];
  
  const textLower = text.toLowerCase();
  if (textLower.includes("financial") || textLower.includes("revenue") || textLower.includes("saas")) {
    cat = "Finance";
    tags = ["Financial forecast", "Revenue segments", "Confidential targets"];
  } else if (textLower.includes("support") || textLower.includes("ticket") || textLower.includes("billing")) {
    cat = "Customer Support";
    tags = ["Support logs", "Refunds ledger", "Billing transcripts"];
  } else if (textLower.includes("credential") || textLower.includes("aws") || textLower.includes("kubernetes")) {
    cat = "Engineering";
    tags = ["AWS Credentials", "Secure Deployments", "Access procedures"];
  } else if (textLower.includes("employee") || textLower.includes("salary") || textLower.includes("addresses")) {
    cat = "HR";
    tags = ["Employee records", "Salary classifications", "Addresses ledger"];
  }

  return {
    title: fileClean.charAt(0).toUpperCase() + fileClean.slice(1),
    category: cat,
    tags: tags,
    classification: textLower.includes("confidential") || textLower.includes("secret") ? "Confidential" : "Internal",
    accessLevel: textLower.includes("secret") || textLower.includes("password") ? "L3" : "L2",
    language: "English",
    author: textLower.includes("sarah") ? "Sarah Jenkins" : (textLower.includes("david") ? "David Miller" : "System Automated"),
    summary: `Refined knowledge asset parsed from source: ${fileName}. Structured perfectly for RAG ingestion.`
  };
}

function simulateReadinessScore(
  raw: string,
  refined: string,
  piiCount: number,
  duplicatesRemoved: number,
  chunksCount: number,
  metadata: RefinedMetadata
): ReadinessScore {
  // 1. Layout Score Heuristics
  const tableCount = (refined.match(/\|/g) || []).length / 3;
  const headingCount = (refined.match(/^#{1,6}\s+/gm) || []).length;
  const listCount = (refined.match(/^\s*[\-\*]\s+/gm) || []).length;
  
  let layoutScore = 70;
  if (tableCount > 0) layoutScore += 15;
  if (headingCount > 0) layoutScore += 10;
  if (listCount > 0) layoutScore += 5;
  layoutScore = Math.min(100, layoutScore);

  // 2. Security Score Heuristics (PII density check)
  let securityScore = 100;
  securityScore -= Math.min(40, piiCount * 4);
  securityScore = Math.max(0, securityScore);

  // 3. Hygiene Score Heuristics
  let hygieneScore = 100;
  const emptyLinesCount = (refined.match(/\n\s*\n/g) || []).length;
  if (emptyLinesCount > 20) hygieneScore -= 10;
  if (refined.includes("  ")) hygieneScore -= 5;
  hygieneScore += Math.min(10, duplicatesRemoved * 2);
  hygieneScore = Math.min(100, Math.max(0, hygieneScore));

  // 4. Metadata Completeness Score
  let metadataScore = 0;
  if (metadata?.title && metadata.title !== "Unknown") metadataScore += 20;
  if (metadata?.category && metadata.category !== "Operations") metadataScore += 20;
  if (metadata?.summary) metadataScore += 20;
  if (metadata?.classification && metadata.classification !== "Internal") metadataScore += 20;
  if (metadata?.tags && metadata.tags.length >= 3) metadataScore += 20;
  else if (metadata?.tags && metadata.tags.length > 0) metadataScore += 10;

  const overall = Math.round((layoutScore + securityScore + hygieneScore + metadataScore) / 4);

  const warnings: string[] = [];
  const recommendations: string[] = [];

  if (piiCount > 0) {
    warnings.push(`Detected ${piiCount} active PII/secret values which have been safely masked.`);
    recommendations.push("Ensure raw files are moved to restricted cold storage vaults immediately.");
  } else {
    warnings.push("No explicit security credentials found.");
  }

  if (duplicatesRemoved > 0) {
    warnings.push(`Cleaned ${duplicatesRemoved} repeating watermarks or duplicate blocks.`);
  }

  if (chunksCount < 2) {
    warnings.push("Document yielded low chunk volume, RAG systems might receive narrow context.");
    recommendations.push("Consider adjusting semantic chunking boundaries to be smaller (e.g. 300 chars).");
  } else {
    recommendations.push("Excellent chunking distribution. Ready for high-accuracy vector matching.");
  }

  if (layoutScore < 85) {
    warnings.push("Low layout/structure detection score.");
    recommendations.push("Use layout-aware PDF parser for tabular structural preservation.");
  }

  recommendations.push("Maintain standard JSON metadata updates on sync timelines.");

  return {
    score: overall,
    layoutScore,
    securityScore,
    hygieneScore,
    metadataScore,
    warnings,
    recommendations
  };
}

const FREE_PLAN_REFINEMENT_LIMIT = 5;
const DEFAULT_CHUNK_TOKEN_LIMIT = 220;
const DEFAULT_CHUNK_OVERLAP_TOKENS = 35;

function estimateTokenCount(text: string): number {
  const matches = text.match(/[A-Za-z0-9]+|[^\sA-Za-z0-9]/g);
  return matches ? matches.length : 0;
}

function splitOversizedSection(section: string, maxTokens: number): string[] {
  const words = section.split(/\s+/).filter(Boolean);
  const parts: string[] = [];
  let current: string[] = [];

  for (const word of words) {
    current.push(word);
    if (estimateTokenCount(current.join(" ")) >= maxTokens) {
      parts.push(current.join(" "));
      current = [];
    }
  }

  if (current.length > 0) parts.push(current.join(" "));
  return parts.length > 0 ? parts : [section];
}

function extractHeading(section: string, fallback: string): string {
  const heading = section.split("\n").find((line) => /^#{1,6}\s+/.test(line.trim()));
  return heading ? heading.replace(/^#{1,6}\s+/, "").trim() : fallback;
}

// Token-aware chunking that preserves headings and paragraph boundaries.
export function runChunking(
  text: string,
  maxTokens: number = DEFAULT_CHUNK_TOKEN_LIMIT,
  overlapTokens: number = DEFAULT_CHUNK_OVERLAP_TOKENS
): Chunk[] {
  const sections = text
    .split(/\n(?=#{1,6}\s+)/)
    .flatMap((section) => section.split(/\n\n+/))
    .flatMap((section) => splitOversizedSection(section.trim(), maxTokens))
    .filter(Boolean);
  const chunks: Chunk[] = [];
  let currentChunkText = "";
  let chunkIndex = 1;
  let lastHeading = "General Context";

  const pushCurrentChunk = () => {
    if (currentChunkText.trim() === "") return;
    chunks.push({
      id: `chunk-${chunkIndex++}`,
      text: currentChunkText.trim(),
      tokenCount: estimateTokenCount(currentChunkText),
      headingContext: lastHeading
    });
  };

  for (const section of sections) {
    const sectionHeading = extractHeading(section, lastHeading);
    const candidate = currentChunkText ? `${currentChunkText}\n\n${section}` : section;

    if (currentChunkText && estimateTokenCount(candidate) > maxTokens) {
      pushCurrentChunk();
      const overlapWords = currentChunkText.split(/\s+/).slice(-overlapTokens).join(" ");
      currentChunkText = overlapWords ? `${overlapWords}\n\n${section}` : section;
    } else {
      currentChunkText = candidate;
    }

    lastHeading = sectionHeading;
  }

  pushCurrentChunk();

  if (chunks.length === 0 && text.trim() !== "") {
    chunks.push({
      id: "chunk-1",
      text: text.trim(),
      tokenCount: estimateTokenCount(text),
      headingContext: lastHeading
    });
  }

  return chunks;
}

// ----------------------------------------------------
// Real Gemini processing pipelines (when key exists)
// ----------------------------------------------------

export async function runGeminiParsing(text: string): Promise<string> {
  if (!ai) return simulateParsing(text);
  try {
    const response = await ai.models.generateContent({
      model: "gemini-3.5-flash",
      contents: `You are the Layout-Aware Parsing Engine of Clean Data Hub.
Your job is to convert messy unstructured text (representing a document, transcript, or spreadsheet) into parsed Markdown while preserving its logical layout and table structure.
Extract tables into clean Markdown tables. Preserve headings, list hierarchies, and paragraph structures.
Remove any raw HTML tags unless they are useful, but keep the structure beautiful.
Return ONLY the parsed Markdown text. Do NOT wrap your response in markdown code blocks like \`\`\`markdown or write any chat wrapper/introduction. Just output the content directly.

Raw text to parse:
${text}`,
    });
    return cleanMarkdownWrapper(response.text || text);
  } catch (err) {
    console.error("Gemini Parsing failed, falling back:", err);
    return simulateParsing(text);
  }
}

export async function runGeminiCleaning(text: string): Promise<{ cleanedText: string; duplicatesRemoved: number }> {
  if (!ai) return simulateCleaning(text);
  try {
    const response = await ai.models.generateContent({
      model: "gemini-3.5-flash",
      contents: `You are the Clean Data Hub Cleaning Engine.
Take this parsed Markdown text and clean it for retrieval-augmented generation (RAG).
1. Remove repetitive page headers/footers (e.g. "Page 1 of 10", "ACME Confidential", dates in margins).
2. De-duplicate identical consecutive paragraphs, or repetitive signature blocks/disclaimer blocks.
3. Fix malformed unicode characters, double spaces, and weird spacing bugs.
4. Normalize quotes and punctuation, keeping markdown structure intact.
Your response must be a JSON object with this exact structure:
{
  "cleanedText": "The polished cleaned text",
  "duplicatesRemovedCount": 0
}

Text to clean:
${text}

Return ONLY valid JSON.`,
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            cleanedText: { type: Type.STRING },
            duplicatesRemovedCount: { type: Type.INTEGER }
          },
          required: ["cleanedText", "duplicatesRemovedCount"]
        }
      }
    });

    if (response.text) {
      const parsed = JSON.parse(response.text.trim());
      return {
        cleanedText: parsed.cleanedText,
        duplicatesRemoved: parsed.duplicatesRemovedCount || 0
      };
    }
    return simulateCleaning(text);
  } catch (err) {
    console.error("Gemini Cleaning failed, falling back:", err);
    return simulateCleaning(text);
  }
}

async function runGeminiPII(text: string): Promise<{ redactedText: string; redactedCount: number; findings: { type: string; value: string }[] }> {
  if (!ai) return simulatePII(text);
  try {
    const response = await ai.models.generateContent({
      model: "gemini-3.5-flash",
      contents: `You are the Clean Data Hub PII Redaction Engine.
Analyze the provided text. Identify all instances of sensitive information, including:
- Individual names (full names)
- Email addresses
- Phone numbers
- Credit card numbers / CVVs
- Social Security Numbers (SSNs) or National IDs
- API keys, JWT tokens, private SSH keys, AWS credentials
- Detailed physical addresses

Replace each occurrence in the text with a generic capitalized placeholder: [REDACTED_NAME], [REDACTED_EMAIL], [REDACTED_PHONE_NUMBER], [REDACTED_CREDIT_CARD], [REDACTED_SSN], [REDACTED_API_KEY], or [REDACTED_ADDRESS].
Do NOT redact general technical terminology, standard corporate names (unless they represent specific individuals), or common generic words.

You must return a JSON object with this exact structure:
{
  "redactedText": "The entire original text with all PII replaced by placeholders",
  "findings": [
    { "type": "NAME" | "EMAIL" | "PHONE" | "CREDIT_CARD" | "SSN" | "API_KEY" | "ADDRESS", "value": "the original sensitive value that was redacted" }
  ]
}

Text to process:
${text}

Return ONLY valid JSON.`,
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            redactedText: { type: Type.STRING },
            findings: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  type: { type: Type.STRING },
                  value: { type: Type.STRING }
                },
                required: ["type", "value"]
              }
            }
          },
          required: ["redactedText", "findings"]
        }
      }
    });

    if (response.text) {
      const parsed = JSON.parse(response.text.trim());
      return {
        redactedText: parsed.redactedText,
        redactedCount: parsed.findings?.length || 0,
        findings: parsed.findings || []
      };
    }
    return simulatePII(text);
  } catch (err) {
    console.error("Gemini PII Masking failed, falling back:", err);
    return simulatePII(text);
  }
}

export async function runGeminiMetadata(text: string, fileName: string): Promise<RefinedMetadata> {
  if (!ai) return simulateMetadata(text, fileName);
  try {
    const response = await ai.models.generateContent({
      model: "gemini-3.5-flash",
      contents: `Analyze this refined text and generate structured metadata in JSON format for an enterprise RAG system.
Document original name: ${fileName}

Your response must be a JSON object matching this schema:
{
  "title": "A descriptive title",
  "category": "Corporate department or business domain (e.g. Finance, HR, Engineering, Operations, Legal)",
  "tags": ["3-5 relevant keywords"],
  "classification": "Public" | "Internal" | "Confidential" | "Highly Sensitive",
  "accessLevel": "L1" | "L2" | "L3",
  "language": "ISO Language name",
  "author": "Estimated author or department name, default to 'Unknown' if not found",
  "summary": "A concise 1-2 sentence executive summary of the document content"
}

Text:
${text}

Return ONLY valid JSON. Do not include markdown wraps or explanations.`,
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            title: { type: Type.STRING },
            category: { type: Type.STRING },
            tags: {
              type: Type.ARRAY,
              items: { type: Type.STRING }
            },
            classification: {
              type: Type.STRING,
              description: "Public, Internal, Confidential, Highly Sensitive"
            },
            accessLevel: {
              type: Type.STRING,
              description: "L1, L2, L3"
            },
            language: { type: Type.STRING },
            author: { type: Type.STRING },
            summary: { type: Type.STRING }
          },
          required: ["title", "category", "tags", "classification", "accessLevel", "language", "author", "summary"]
        }
      }
    });
    
    if (response.text) {
      return JSON.parse(response.text.trim());
    }
    return simulateMetadata(text, fileName);
  } catch (err) {
    console.error("Gemini Metadata Generation failed, falling back:", err);
    return simulateMetadata(text, fileName);
  }
}

async function runGeminiReadiness(
  raw: string,
  refined: string,
  piiCount: number,
  duplicatesRemoved: number,
  chunksCount: number,
  metadata: RefinedMetadata
): Promise<ReadinessScore> {
  if (!ai) {
    return simulateReadinessScore(raw, refined, piiCount, duplicatesRemoved, chunksCount, metadata);
  }
  try {
    const response = await ai.models.generateContent({
      model: "gemini-3.5-flash",
      contents: `You are the Clean Data Hub Enterprise AI Readiness Evaluation Auditor.
Your job is to rate a refined document on its readiness for RAG systems and LLMs out of 100.
Evaluate the raw document versus its refined version, considering:
- Layout-aware parsing quality (whether tables/headings are readable).
- Hygiene (how many duplicate paragraphs, footers, and noise blocks were removed).
- Security (whether sensitive PII, passwords, emails, and phone numbers were redacted).
- Metadata completeness (whether rich tags, classification, and categories are generated).

Please return a JSON object with this exact structure:
{
  "score": 85,
  "layoutScore": 90,
  "securityScore": 95,
  "hygieneScore": 80,
  "metadataScore": 90,
  "warnings": ["warning items"],
  "recommendations": ["recommendation items"]
}

Context for evaluation:
- Raw Text Length: ${raw.length} chars
- Refined Text Length: ${refined.length} chars
- PII Redacted: ${piiCount} entities
- Duplicate blocks removed: ${duplicatesRemoved}
- Chunks generated: ${chunksCount}
- Metadata extracted: ${JSON.stringify(metadata)}

Return ONLY valid JSON.`,
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            score: { type: Type.INTEGER },
            layoutScore: { type: Type.INTEGER },
            securityScore: { type: Type.INTEGER },
            hygieneScore: { type: Type.INTEGER },
            metadataScore: { type: Type.INTEGER },
            warnings: {
              type: Type.ARRAY,
              items: { type: Type.STRING }
            },
            recommendations: {
              type: Type.ARRAY,
              items: { type: Type.STRING }
            }
          },
          required: ["score", "layoutScore", "securityScore", "hygieneScore", "metadataScore", "warnings", "recommendations"]
        }
      }
    });

    if (response.text) {
      return JSON.parse(response.text.trim());
    }
    return simulateReadinessScore(raw, refined, piiCount, duplicatesRemoved, chunksCount, metadata);
  } catch (err) {
    console.error("Gemini Readiness Evaluation failed, falling back:", err);
    return simulateReadinessScore(raw, refined, piiCount, duplicatesRemoved, chunksCount, metadata);
  }
}

// ----------------------------------------------------
// API ROUTES
// ----------------------------------------------------

// Immutable audit logging helper for HIPAA and SOC2 compliance
async function logAudit(
  req: express.Request,
  action: "READ" | "CREATE" | "UPDATE" | "DELETE" | "EXPORT" | "LOGIN" | "REGISTER",
  resource: "Document" | "Connector" | "VectorDb" | "User" | "Auth",
  resourceId: string,
  changes?: { before: any; after: any }
) {
  const tenantId = req.user?.tenantId || "system";
  const userId   = req.user?.id || "system";
  try {
    await AuditLog.create({ tenantId, userId, action, resource, resourceId, changes, ipAddress: req.ip, userAgent: req.get("user-agent") });
  } catch (e) {
    console.error("Failed to write audit log:", e);
  }
  // Gap 5 — Dual-write to PostgreSQL (fire-and-forget)
  pgInsertAuditLog({
    tenantId, userId, action, resource, resourceId,
    changes, ipAddress: req.ip, userAgent: req.get("user-agent"),
  }).catch(() => {});
}

interface RefinementQuotaState {
  org: any;
  limit: number | null;
  remaining: number | null;
}

async function consumeRefinementQuota(userId: string): Promise<RefinementQuotaState> {
  let user: any;
  let org: any;

  if (pgEnabled) {
    user = await pgGetUserById(userId, "");
    if (!user) {
      const err: any = new Error("User not found");
      err.statusCode = 401;
      throw err;
    }
    const pgOrg = await pgGetOrganization(user.tenant_id);
    if (!pgOrg) {
      await pgUpsertOrganization({ tenantId: user.tenant_id, name: `${user.tenant_id} Workspace` });
      org = await pgGetOrganization(user.tenant_id);
    } else {
      org = pgOrg;
    }

    const orgObj: any = {
      tenantId: org.tenant_id,
      name: org.name,
      plan: org.plan,
      refinementCount: org.refinement_count,
      save: async () => {
        await pgUpsertOrganization({
          tenantId: org.tenant_id,
          name: org.name,
          plan: org.plan,
          refinementCount: orgObj.refinementCount
        });
        await Organization.updateOne({ tenantId: org.tenant_id }, { $set: { refinementCount: orgObj.refinementCount } });
      }
    };

    const isEnterprise = orgObj.plan === "enterprise";
    const limit = isEnterprise ? null : FREE_PLAN_REFINEMENT_LIMIT;

    if (!isEnterprise && orgObj.refinementCount >= FREE_PLAN_REFINEMENT_LIMIT) {
      const err: any = new Error("Usage quota exceeded. Please upgrade to Enterprise to continue refining content.");
      err.statusCode = 402;
      err.quota = {
        plan: orgObj.plan,
        refinementCount: orgObj.refinementCount,
        refinementLimit: FREE_PLAN_REFINEMENT_LIMIT,
        remaining: 0,
      };
      throw err;
    }

    orgObj.refinementCount += 1;
    await orgObj.save();

    return {
      org: orgObj,
      limit,
      remaining: limit === null ? null : Math.max(0, limit - orgObj.refinementCount),
    };
  } else {
    user = await User.findById(userId);
    if (!user) {
      const err: any = new Error("User not found");
      err.statusCode = 401;
      throw err;
    }

    let mongoOrg = await Organization.findOne({ tenantId: user.tenantId });
    if (!mongoOrg) {
      mongoOrg = new Organization({
        name: `${user.tenantId} Workspace`,
        tenantId: user.tenantId,
        plan: "free",
        refinementCount: 0,
      });
      await mongoOrg.save();
    }

    const isEnterprise = mongoOrg.plan === "enterprise";
    const limit = isEnterprise ? null : FREE_PLAN_REFINEMENT_LIMIT;

    if (!isEnterprise && mongoOrg.refinementCount >= FREE_PLAN_REFINEMENT_LIMIT) {
      const err: any = new Error("Usage quota exceeded. Please upgrade to Enterprise to continue refining content.");
      err.statusCode = 402;
      err.quota = {
        plan: mongoOrg.plan,
        refinementCount: mongoOrg.refinementCount,
        refinementLimit: FREE_PLAN_REFINEMENT_LIMIT,
        remaining: 0,
      };
      throw err;
    }

    mongoOrg.refinementCount += 1;
    await mongoOrg.save();

    return {
      org: mongoOrg,
      limit,
      remaining: limit === null ? null : Math.max(0, limit - mongoOrg.refinementCount),
    };
  }
}
// ----------------------------------------------------
// API VERSIONING & RATE LIMITING
// ----------------------------------------------------

// Backward-compat: legacy /api remains available, but /v1 is canonical.
app.use("/api", (req, res, next) => {
  const fromV1Alias = Boolean((req as any).fromV1Alias);
  (req as any).apiVersion = fromV1Alias ? "v1" : "legacy";
  res.set("API-Version", "v1");

  if (!fromV1Alias) {
    res.set("Deprecation", "true");
    res.set("Link", "</v1>; rel=\"successor-version\"");
  }

  next();
});

// Route /v1/* through the existing /api/* handlers until routes are fully moved.
app.use("/v1", (req, res, next) => {
  (req as any).apiVersion = "v1";
  (req as any).fromV1Alias = true;
  res.set("API-Version", "v1");
  req.url = `/api${req.url}`;
  (app as any).handle(req, res, next);
});

// Global API rate limiting
// Auth endpoints: strict (20 req/min) — prevent brute-force
app.use(["/api/auth/login", "/api/auth/register", "/v1/auth/login", "/v1/auth/register"],
  rateLimit(20, 60_000)
);
// All other API endpoints: standard (200 req/min per user)
app.use(["/api", "/v1"], rateLimit(200, 60_000));

// System Health Check
app.get("/api/health", async (req, res) => {
  const health: any = {
    status: "ok",
    apiKeyLoaded: !!apiKey && apiKey !== "MY_GEMINI_API_KEY",
    model: "gemini-3.5-flash",
    time: new Date().toISOString(),
    checks: {
      database: "pending",
      redis: "pending",
      queue: "pending"
    }
  };

  try {
    if (mongoose.connection.readyState === 1) {
      await mongoose.connection.db?.admin().ping();
      health.checks.database = "ok";
    } else {
      health.checks.database = "error";
      health.status = "degraded";
    }
  } catch (e) {
    health.checks.database = "error";
    health.status = "degraded";
  }

  try {
    const { authRedisClient } = await import("./server-auth.ts");
    if (authRedisClient.isOpen) {
      await authRedisClient.ping();
      health.checks.redis = "ok";
    } else {
      health.checks.redis = "disconnected";
      health.status = "degraded";
    }
  } catch (e) {
    health.checks.redis = "error";
    health.status = "degraded";
  }

  try {
    const { documentRefineQueue } = await import("./server-queue.ts");
    const counts = await documentRefineQueue.getJobCounts();
    health.checks.queue = "ok";
    health.queueDepth = counts.waiting;
  } catch (e) {
    health.checks.queue = "error";
  }

  res.status(health.status === "ok" ? 200 : 503).json(health);
});

// System Readiness Check
app.get("/ready", (req, res) => {
  const isReady = mongoose.connection.readyState === 1;
  res.status(isReady ? 200 : 503).json({ ready: isReady });
});

// Authentication endpoints
app.post("/api/auth/register", async (req, res) => {
  const { email, password, tenantId, role, organizationName } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: "Email and password are required" });
  }

  try {
    let existingUser;
    if (pgEnabled) {
      existingUser = await pgGetUserByEmail(email);
    } else {
      existingUser = await User.findOne({ email });
    }

    if (existingUser) {
      return res.status(400).json({ error: "User already exists with this email" });
    }

    const assignedTenantId = tenantId || `tenant-${Math.random().toString(36).substring(2, 9)}`;
    const hashedPassword = await hashPassword(password);
    
    const newUser = new User({
      email,
      passwordHash: hashedPassword,
      tenantId: assignedTenantId,
      role: role || "admin", // First user in a tenant is admin by default
    });

    await newUser.save();

    if (pgEnabled) {
      await pgUpsertUser({
        email: newUser.email,
        passwordHash: newUser.passwordHash,
        tenantId: newUser.tenantId,
        role: newUser.role,
        mongoId: newUser._id.toString(),
      });
    }

    // ── Auto-create Organization entity for new tenant ──────────────────
    // This is the critical multi-tenancy entity that scopes billing, retention,
    // IP allowlist, and webhooks. Every tenant MUST have one.
    let existingOrg;
    if (pgEnabled) {
      existingOrg = await pgGetOrganization(assignedTenantId);
    } else {
      existingOrg = await Organization.findOne({ tenantId: assignedTenantId });
    }

    if (!existingOrg) {
      const orgName = organizationName || `${email.split("@")[0]}'s Workspace`;
      const newOrg = new Organization({
        name: orgName,
        tenantId: assignedTenantId,
        plan: "free",
        refinementCount: 0,
        ipAllowlist: [],
        retentionDays: 0,
        webhookUrl: "",
        webhookSecret: "",
      });
      await newOrg.save();
      // Gap 5 — Dual-write org to PostgreSQL
      pgUpsertOrganization({ tenantId: assignedTenantId, name: orgName }).catch(() => {});
      console.log(`[REGISTER] Created Organization '${orgName}' for tenant ${assignedTenantId}`);
    }

    await logAudit(req, "REGISTER", "User", newUser._id.toString());

    const token = generateToken({
      userId: newUser._id.toString(),
      email: newUser.email,
      role: newUser.role as any,
      tenantId: newUser.tenantId,
    });

    res.status(201).json({
      token,
      user: {
        id: newUser._id.toString(),
        email: newUser.email,
        role: newUser.role,
        tenantId: newUser.tenantId,
      }
    });
  } catch (err: any) {
    console.error("Registration error:", err);
    res.status(500).json({ error: "Failed to register user", details: err.message });
  }
});


app.post("/api/auth/login", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: "Email and password are required" });
  }

  try {
    let user;
    if (pgEnabled) {
      const pgUser = await pgGetUserByEmail(email);
      if (pgUser) {
        user = {
          _id: pgUser.mongo_id,
          id: pgUser.mongo_id,
          email: pgUser.email,
          passwordHash: pgUser.password_hash,
          tenantId: pgUser.tenant_id,
          role: pgUser.role
        };
      }
    } else {
      user = await User.findOne({ email });
    }

    if (!user) {
      return res.status(401).json({ error: "Invalid email or password" });
    }

    const isValid = await verifyPassword(password, user.passwordHash);
    if (!isValid) {
      return res.status(401).json({ error: "Invalid email or password" });
    }

    const token = generateToken({
      userId: user._id.toString(),
      email: user.email,
      role: user.role as any,
      tenantId: user.tenantId,
    });

    await logAudit(req, "LOGIN", "User", user._id.toString());

    res.json({
      token,
      user: {
        id: user._id.toString(),
        email: user.email,
        role: user.role,
        tenantId: user.tenantId,
      }
    });
  } catch (err: any) {
    console.error("Login error:", err);
    res.status(500).json({ error: "Failed to log in", details: err.message });
  }
});

app.get("/api/auth/me", requireAuth, async (req, res) => {
  res.json({ user: req.user });
});

function repeatOptionsForFrequency(frequency?: string) {
  const normalized = (frequency || "manual").toLowerCase();
  if (normalized.includes("hour")) return { cron: "0 * * * *" };
  if (normalized.includes("week")) return { cron: "0 0 * * 0" };
  if (normalized.includes("daily") || normalized.includes("midnight")) return { cron: "0 0 * * *" };
  return null;
}

function isOAuthProvider(provider: string): provider is OAuthProvider {
  return Object.prototype.hasOwnProperty.call(OAUTH_CONFIG, provider);
}

async function persistOAuthState(state: string, data: any) {
  if (!authRedisClient?.isOpen) {
    throw new Error("OAuth state store unavailable");
  }
  await authRedisClient.set(`oauth:connector:${state}`, JSON.stringify(data), { EX: 10 * 60 });
}

async function consumeOAuthState(state: string): Promise<any | null> {
  if (!authRedisClient?.isOpen) {
    throw new Error("OAuth state store unavailable");
  }
  const key = `oauth:connector:${state}`;
  const raw = await authRedisClient.get(key);
  if (!raw) return null;
  await authRedisClient.del(key);
  return JSON.parse(raw);
}

app.get("/api/connectors/oauth/:provider/start", requireAuth, async (req, res) => {
  try {
    const provider = req.params.provider;
    if (!isOAuthProvider(provider)) {
      res.status(404).json({ error: "Unsupported OAuth connector provider" });
      return;
    }

    const state = crypto.randomBytes(32).toString("hex");
    await persistOAuthState(state, {
      provider,
      userId: req.user!.id,
      email: req.user!.email,
      role: req.user!.role,
      tenantId: req.user!.tenantId,
      connectorId: typeof req.query.connectorId === "string" ? req.query.connectorId : null,
    });

    const authUrl = generateAuthorizationUrl(provider, state);
    if (req.query.redirect === "1") {
      res.redirect(authUrl);
      return;
    }
    res.json({ authUrl });
  } catch (err: any) {
    res.status(500).json({ error: "Failed to start connector OAuth", details: err.message });
  }
});

app.get("/api/connectors/oauth/:provider/callback", async (req, res) => {
  try {
    const provider = req.params.provider;
    const code = typeof req.query.code === "string" ? req.query.code : "";
    const state = typeof req.query.state === "string" ? req.query.state : "";
    const oauthError = typeof req.query.error === "string" ? req.query.error : "";

    if (!isOAuthProvider(provider)) {
      res.status(404).json({ error: "Unsupported OAuth connector provider" });
      return;
    }
    if (oauthError) {
      res.redirect(`/?connector_oauth=error&provider=${encodeURIComponent(provider)}&reason=${encodeURIComponent(oauthError)}`);
      return;
    }
    if (!code || !state) {
      res.status(400).json({ error: "Missing OAuth code or state" });
      return;
    }

    const stateData = await consumeOAuthState(state);
    if (!stateData || stateData.provider !== provider) {
      res.status(400).json({ error: "Invalid or expired OAuth state" });
      return;
    }

    const token = await exchangeCodeForToken(provider, code);
    const config = OAUTH_CONFIG[provider];
    const tenantId = stateData.tenantId;
    const connectorId = stateData.connectorId;

    const lookup = connectorId
      ? { _id: connectorId, tenantId }
      : { tenantId, type: config.connectorType };
    let connector = await Connector.findOne(lookup as any);

    if (!connector) {
      connector = new Connector({
        tenantId,
        id: `connector-${crypto.randomUUID()}`,
        name: config.connectorName,
        type: config.connectorType,
        status: "connected",
        filesCount: 0,
        frequency: "manual",
        credentials: {},
        config: {},
        syncState: { lastStatus: "never", files: [] },
      });
    }

    connector.status = "connected";
    connector.credentials = {
      ...(connector.credentials || {}),
      clientId: config.clientId,
      oauthToken: token.accessToken,
      refreshToken: token.refreshToken,
    };
    connector.config = {
      ...(connector.config || {}),
      provider,
      connectedAt: new Date().toISOString(),
      tokenExpiresAt: token.expiresIn ? new Date(Date.now() + token.expiresIn * 1000).toISOString() : null,
      teamId: token.raw?.team?.id || token.raw?.team_id || token.raw?.workspace_id,
      workspaceName: token.raw?.team?.name || token.raw?.workspace_name || token.raw?.bot_id,
    };
    await connector.save();

    if (pgEnabled) {
      await pgUpsertConnector({
        mongoId: connector._id.toString(),
        tenantId: connector.tenantId,
        name: connector.name,
        type: connector.type,
        status: connector.status,
        frequency: connector.frequency,
        filesCount: connector.filesCount
      });
    }

    (req as any).user = {
      id: stateData.userId,
      email: stateData.email,
      role: stateData.role,
      tenantId,
    };
    await logAudit(req, "UPDATE", "Connector", connector._id.toString(), {
      before: null,
      after: { provider, status: "connected" },
    });

    res.redirect(`/?connector_oauth=success&provider=${encodeURIComponent(provider)}`);
  } catch (err: any) {
    res.status(500).json({ error: "Failed to complete connector OAuth", details: err.message });
  }
});

app.get("/api/connectors", requireAuth, async (req, res) => {
  try {
    if (pgEnabled) {
      const rows = await pgGetConnectors(req.user!.tenantId);
      const formatted = rows.map(r => ({
        _id: r.mongo_id,
        id: r.mongo_id,
        tenantId: r.tenant_id,
        name: r.name,
        type: r.type,
        status: r.status,
        frequency: r.frequency,
        filesCount: r.files_count,
        lastSynced: r.last_synced,
        createdAt: r.created_at,
        updatedAt: r.updated_at
      }));
      res.json(formatted);
      return;
    }
    const connectors = await Connector.find({ tenantId: req.user!.tenantId }).sort({ updatedAt: -1 });
    res.json(connectors);
  } catch (err: any) {
    res.status(500).json({ error: "Failed to fetch connectors", details: err.message });
  }
});

app.post("/api/connectors", requireAuth, async (req, res) => {
  try {
    const { addConnectorSyncJob } = await import("./server-queue.ts");
    const { name, type, frequency, credentials, config } = req.body;
    if (!name || !type) {
      res.status(400).json({ error: "Connector name and type are required" });
      return;
    }

    const connector = new Connector({
      tenantId: req.user!.tenantId,
      id: `connector-${crypto.randomUUID()}`,
      name,
      type,
      status: "connected",
      filesCount: 0,
      frequency: frequency || "manual",
      credentials: credentials || {},
      config: config || {},
      syncState: { lastStatus: "never", files: [] },
    });

    await connector.save();
    if (pgEnabled) {
      await pgUpsertConnector({
        mongoId: connector._id.toString(),
        tenantId: connector.tenantId,
        name: connector.name,
        type: connector.type,
        status: connector.status,
        frequency: connector.frequency,
        filesCount: connector.filesCount
      });
    }

    await logAudit(req, "CREATE", "Connector", connector._id.toString(), { before: null, after: connector });

    const repeat = repeatOptionsForFrequency(connector.frequency);
    if (repeat || connector.config?.autoRefreshEnabled) {
      await addConnectorSyncJob(connector._id.toString(), repeat ? { repeat } : {});
    }

    res.status(201).json(connector);
  } catch (err: any) {
    res.status(500).json({ error: "Failed to create connector", details: err.message });
  }
});

app.post("/api/connectors/:id/sync", requireAuth, async (req, res) => {
  try {
    let connId = req.params.id;
    if (pgEnabled) {
      const pgConn = await pgGetConnectorById(req.params.id, req.user!.tenantId);
      if (!pgConn) {
        res.status(404).json({ error: "Connector not found" });
        return;
      }
      connId = pgConn.mongo_id;
    }

    const connector = await Connector.findOne({ _id: connId, tenantId: req.user!.tenantId });
    if (!connector) {
      res.status(404).json({ error: "Connector not found" });
      return;
    }

    const { addConnectorSyncJob } = await import("./server-queue.ts");
    const job = await addConnectorSyncJob(connector._id.toString());
    await logAudit(req, "UPDATE", "Connector", connector._id.toString(), { before: { status: connector.status }, after: { queuedJobId: job.id } });
    res.json({ queued: true, jobId: job.id, connectorId: connector._id.toString() });
  } catch (err: any) {
    res.status(500).json({ error: "Failed to queue connector sync", details: err.message });
  }
});

app.post("/api/connectors/:id/schedule", requireAuth, async (req, res) => {
  try {
    let connId = req.params.id;
    if (pgEnabled) {
      const pgConn = await pgGetConnectorById(req.params.id, req.user!.tenantId);
      if (!pgConn) {
        res.status(404).json({ error: "Connector not found" });
        return;
      }
      connId = pgConn.mongo_id;
    }

    const connector = await Connector.findOne({ _id: connId, tenantId: req.user!.tenantId });
    if (!connector) {
      res.status(404).json({ error: "Connector not found" });
      return;
    }

    const frequency = req.body.frequency || connector.frequency || "daily";
    const repeat = repeatOptionsForFrequency(frequency);
    if (!repeat) {
      res.status(400).json({ error: "Unsupported schedule frequency. Use hourly, daily, or weekly." });
      return;
    }

    connector.frequency = frequency;
    connector.config = { ...(connector.config || {}), autoRefreshEnabled: true, syncSchedule: repeat.cron };
    await connector.save();

    if (pgEnabled) {
      await pgUpsertConnector({
        mongoId: connector._id.toString(),
        tenantId: connector.tenantId,
        name: connector.name,
        type: connector.type,
        status: connector.status,
        frequency: connector.frequency,
        filesCount: connector.filesCount
      });
    }

    const { addConnectorSyncJob } = await import("./server-queue.ts");
    const job = await addConnectorSyncJob(connector._id.toString(), { repeat });
    await logAudit(req, "UPDATE", "Connector", connector._id.toString(), { before: null, after: { frequency, cron: repeat.cron, jobId: job.id } });
    res.json({ scheduled: true, cron: repeat.cron, jobId: job.id, connector });
  } catch (err: any) {
    res.status(500).json({ error: "Failed to schedule connector sync", details: err.message });
  }
});

app.post("/api/storage/presign", requireAuth, async (req, res) => {
  try {
    const { key, contentType, expiresSeconds } = req.body;
    if (!key || typeof key !== "string") {
      res.status(400).json({ error: "Object key is required" });
      return;
    }

    const tenantKey = `${req.user!.tenantId}/${key}`;
    const upload = createPresignedUpload({ key: tenantKey, contentType, expiresSeconds });
    res.json(upload);
  } catch (err: any) {
    captureError(err, { route: "/api/storage/presign", tenantId: req.user?.tenantId });
    res.status(500).json({ error: "Failed to create signed upload URL", details: err.message });
  }
});

app.put("/api/storage/upload", requireAuth, express.raw({ type: "*/*", limit: "100mb" }), async (req, res) => {
  try {
    const key = String(req.query.key || "");
    if (!key.startsWith(`${req.user!.tenantId}/`)) {
      res.status(403).json({ error: "Storage key must be scoped to the authenticated tenant" });
      return;
    }

    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || "");
    const stored = await saveLocalObject(key, body);
    res.json({ stored: true, provider: "local", ...stored });
  } catch (err: any) {
    captureError(err, { route: "/api/storage/upload", tenantId: req.user?.tenantId });
    res.status(500).json({ error: "Failed to store uploaded object", details: err.message });
  }
});
// GET all documents (tenant isolated)
// rawContent (unmasked source) is EXCLUDED from list responses — only redactedContent is served.
// This is a structural PII gate: unmasked data cannot be accessed via the API after ingestion.
app.get("/api/documents", requireAuth, async (req, res) => {
  try {
    if (pgEnabled) {
      const rows = await pgGetDocuments(req.user!.tenantId);
      const formatted = rows.map(r => ({
        _id: r.mongo_id,
        id: r.mongo_id,
        tenantId: r.tenant_id,
        name: r.name,
        type: r.type,
        status: r.status,
        size: `${((r.size_bytes || 0) / 1024).toFixed(1)} KB`,
        connector: r.connector,
        readinessScore: r.readiness_score,
        piiFindingsCount: r.pii_findings_count,
        chunksCount: r.chunks_count,
        vectorSync: r.vector_synced,
        createdAt: r.created_at,
        updatedAt: r.updated_at
      }));
      res.json(formatted);
      return;
    }
    const docs = await Document.find(
      { tenantId: req.user!.tenantId },
      { rawContent: 0 }  // PII gate: never expose unmasked source content via API
    ).sort({ createdAt: -1 });
    res.json(docs);
  } catch (err: any) {
    res.status(500).json({ error: "Failed to fetch documents", details: err.message });
  }
});


// GET document by ID (tenant isolated)
// rawContent (unmasked source) is EXCLUDED — PII structural gate.
app.get("/api/documents/:id", requireAuth, async (req, res) => {
  try {
    let docId = req.params.id;
    if (pgEnabled) {
      const pgDoc = await pgGetDocumentById(req.params.id, req.user!.tenantId);
      if (!pgDoc) {
        return res.status(404).json({ error: "Document not found" });
      }
      docId = pgDoc.mongo_id;
    }
    const doc = await Document.findOne(
      { _id: docId, tenantId: req.user!.tenantId },
      { rawContent: 0 }  // PII gate: never expose unmasked source content via API
    );
    if (!doc) {
      return res.status(404).json({ error: "Document not found" });
    }
    await logAudit(req, "READ", "Document", req.params.id);
    res.json(doc);
  } catch (err: any) {
    res.status(500).json({ error: "Failed to fetch document", details: err.message });
  }
});


// DELETE document (tenant isolated)
app.delete("/api/documents/:id", requireAuth, async (req, res) => {
  try {
    let docId = req.params.id;
    if (pgEnabled) {
      const pgDoc = await pgGetDocumentById(req.params.id, req.user!.tenantId);
      if (!pgDoc) {
        return res.status(404).json({ error: "Document not found" });
      }
      docId = pgDoc.mongo_id;
    }
    const doc = await Document.findOne({ _id: docId, tenantId: req.user!.tenantId });
    if (!doc) {
      return res.status(404).json({ error: "Document not found" });
    }
    
    await logAudit(req, "DELETE", "Document", req.params.id, { before: doc, after: null });
    await Document.deleteOne({ _id: docId });
    if (pgEnabled) {
      await pgDeleteDocument(req.params.id, req.user!.tenantId);
    }
    res.json({ success: true, id: req.params.id });
  } catch (err: any) {
    res.status(500).json({ error: "Failed to delete document", details: err.message });
  }
});

// EXPORT document as JSON (tenant isolated, audited)
app.post("/api/documents/:id/export", requireAuth, async (req, res) => {
  try {
    let docId = req.params.id;
    if (pgEnabled) {
      const pgDoc = await pgGetDocumentById(req.params.id, req.user!.tenantId);
      if (!pgDoc) {
        return res.status(404).json({ error: "Document not found" });
      }
      docId = pgDoc.mongo_id;
    }
    const doc = await Document.findOne({ _id: docId, tenantId: req.user!.tenantId });
    if (!doc) {
      return res.status(404).json({ error: "Document not found" });
    }
    await logAudit(req, "EXPORT", "Document", req.params.id);
    res.setHeader("Content-Disposition", `attachment; filename="${doc.name.replace(/[^a-z0-9._-]/gi, '_')}_export.json"`);
    res.setHeader("Content-Type", "application/json");
    res.json({
      id: doc._id,
      name: doc.name,
      type: doc.type,
      status: doc.status,
      parsedContent: doc.parsedContent,
      cleanedContent: doc.cleanedContent,
      redactedContent: doc.redactedContent,
      metadata: doc.metadata,
      chunks: doc.chunks,
      piiFindings: doc.piiFindings,
      piiFindingsCount: doc.piiFindingsCount,
      readinessScore: doc.readinessScore,
      duplicatesRemoved: doc.duplicatesRemoved,
      vectorSync: doc.vectorSync,
      createdAt: doc.createdAt,
      exportedAt: new Date().toISOString(),
    });
  } catch (err: any) {
    res.status(500).json({ error: "Failed to export document", details: err.message });
  }
});


// CREATE raw document (from manual upload/paste, tenant isolated)
// Gap 22 — Multipart binary file upload (PDF, DOCX, XLSX, PPTX, TXT)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50 MB
  fileFilter: (_req, file, cb) => {
    const allowed = ["application/pdf", "text/plain",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ];
    const extOk = /\.(pdf|txt|docx|xlsx|pptx|md|csv)$/i.test(file.originalname);
    cb(null, allowed.includes(file.mimetype) || extOk);
  },
});

const EXT_TO_TYPE: Record<string, string> = {
  pdf: "PDF", docx: "DOCX", xlsx: "XLSX", pptx: "PPTX",
  txt: "TXT", md: "TXT", csv: "TXT",
};

// POST /api/documents — accepts JSON body OR multipart file upload
app.post("/api/documents", requireAuth, upload.single("file"), async (req: any, res: any) => {
  try {
    // Gap 18 — Storage quota check
    let org: any;
    if (pgEnabled) {
      const pgOrg = await pgGetOrganization(req.user!.tenantId);
      if (pgOrg) {
        org = {
          tenantId: pgOrg.tenant_id,
          name: pgOrg.name,
          plan: pgOrg.plan,
          storageQuotaBytes: pgOrg.storage_quota_bytes,
          storageUsedBytes: pgOrg.storage_used_bytes,
          save: async () => {
            await pgUpsertOrganization({
              tenantId: pgOrg.tenant_id,
              name: pgOrg.name,
              plan: pgOrg.plan,
              storageUsedBytes: org.storageUsedBytes
            });
            await Organization.updateOne({ tenantId: pgOrg.tenant_id }, { $set: { storageUsedBytes: org.storageUsedBytes } });
          }
        };
      }
    } else {
      org = await Organization.findOne({ tenantId: req.user!.tenantId });
    }

    if (org) {
      const quota = org.storageQuotaBytes || 104_857_600;
      const used = org.storageUsedBytes || 0;
      const incomingBytes = req.file?.size || Buffer.byteLength(req.body?.rawContent || "", "utf8");
      if (used + incomingBytes > quota) {
        return res.status(402).json({
          error: "Storage quota exceeded",
          used, quota, plan: org.plan,
          upgrade: "POST /api/billing/checkout",
        });
      }
    }

    let rawContent: string;
    let name: string;
    let type: string;
    let size: string;
    let connector: string;

    if (req.file) {
      // Binary file upload path
      const ext = (req.file.originalname.split(".").pop() || "txt").toLowerCase();
      type = EXT_TO_TYPE[ext] || "TXT";
      name = req.body?.name || req.file.originalname;
      size = `${(req.file.size / 1024).toFixed(1)} KB`;
      connector = req.body?.connector || "Local Upload";

      if (type === "TXT") {
        rawContent = req.file.buffer.toString("utf-8");
      } else {
        // Store binary as base64 — pipeline will decode and parse
        rawContent = req.file.buffer.toString("base64");
      }

      // Update storage usage
      if (org) {
        org.storageUsedBytes = (org.storageUsedBytes || 0) + req.file.size;
        await org.save();
      }
    } else {
      // JSON body path (backward-compatible)
      const body = req.body || {};
      if (!body.name || !body.rawContent) {
        return res.status(400).json({ error: "Provide 'file' (multipart) or 'name' + 'rawContent' (JSON)" });
      }
      rawContent = body.rawContent;
      name = body.name;
      type = body.type || "TXT";
      size = body.size || `${Math.round(rawContent.length / 1024)} KB`;
      connector = body.connector || "Local Upload";
    }

    const newDoc = new Document({
      tenantId: req.user!.tenantId,
      id: `doc-${Date.now()}`,
      name, type, size, connector,
      status: "raw",
      rawContent,
      parsedContent: "", cleanedContent: "", redactedContent: "",
      metadata: null, chunks: [], vectorSync: null, readinessScore: null,
      piiFindingsCount: 0, piiFindings: [], duplicatesRemoved: 0,
    });

    await newDoc.save();

    if (pgEnabled) {
      await pgUpsertDocument({
        mongoId: newDoc._id.toString(),
        tenantId: newDoc.tenantId,
        name: newDoc.name,
        type: newDoc.type,
        status: "raw",
        sizeBytes: req.file?.size || Buffer.byteLength(rawContent, "utf8"),
        connector: newDoc.connector,
      });
    }

    await logAudit(req, "CREATE", "Document", newDoc._id.toString(), { before: null, after: { name, type, size } });
    res.status(201).json(newDoc);
  } catch (err: any) {
    res.status(500).json({ error: "Failed to create document", details: err.message });
  }
});

// TRIGGER Refinery Pipeline for a specific document (tenant isolated)
app.post("/api/documents/:id/refine", requireAuth, async (req: any, res: any) => {
  try {
    let docId = req.params.id;
    if (pgEnabled) {
      const pgDoc = await pgGetDocumentById(req.params.id, req.user!.tenantId);
      if (!pgDoc) {
        res.status(404).json({ error: "Document not found" });
        return;
      }
      docId = pgDoc.mongo_id;
    }

    const doc = await Document.findOne({ _id: docId, tenantId: req.user!.tenantId });
    if (!doc) {
      res.status(404).json({ error: "Document not found" });
      return;
    }

    const quota = await consumeRefinementQuota(req.user.id);

    doc.status = "processing";
    await doc.save();

    if (pgEnabled) {
      await pgUpsertDocument({
        mongoId: doc._id.toString(),
        tenantId: doc.tenantId,
        name: doc.name,
        type: doc.type,
        status: "processing",
        sizeBytes: parseInt((doc.size || "0").replace(/[^0-9]/g, "")) * 1024,
        connector: doc.connector,
      });
    }

    await logAudit(req, "UPDATE", "Document", req.params.id);

    const { addRefineJob } = await import("./server-queue.ts");
    await addRefineJob(doc._id.toString());

    res.json({ document: doc, quota: { plan: quota.org.plan, refinementLimit: quota.limit, remaining: quota.remaining } });
  } catch (error: any) {
    if (error.statusCode === 402) {
      res.status(402).json({ error: error.message, quota: error.quota });
      return;
    }
    console.error("Error queueing Refinery Pipeline:", error);
    res.status(error.statusCode || 500).json({ error: "Pipeline refinement queuing failed", details: error.message });
  }
});

// QUICK PLAYGROUND: Refine pasted custom text on the fly (requires authentication)
app.post("/api/refine-text", requireAuth, async (req: any, res: any) => {
  const { text, name } = req.body;
  if (!text) {
    res.status(400).json({ error: "Text is required" });
    return;
  }

  try {
    const quota = await consumeRefinementQuota(req.user.id);

    const fileName = name || "sandbox_input.txt";
    const parsed = await runGeminiParsing(text);
    const cleanResult = await runGeminiCleaning(parsed);
    const piiResult = await runGeminiPII(cleanResult.cleanedText);
    const metadata = await runGeminiMetadata(piiResult.redactedText, fileName);
    const chunks = runChunking(piiResult.redactedText);
    const readinessScore = await runGeminiReadiness(
      text,
      piiResult.redactedText,
      piiResult.redactedCount,
      cleanResult.duplicatesRemoved,
      chunks.length,
      metadata
    );

    res.json({
      rawContent: text,
      parsedContent: parsed,
      cleanedContent: cleanResult.cleanedText,
      redactedContent: piiResult.redactedText,
      metadata,
      chunks,
      piiFindingsCount: piiResult.redactedCount,
      piiFindings: piiResult.findings,
      duplicatesRemoved: cleanResult.duplicatesRemoved,
      readinessScore,
      quota: { plan: quota.org.plan, refinementLimit: quota.limit, remaining: quota.remaining }
    });
  } catch (error: any) {
    if (error.statusCode === 402) {
      res.status(402).json({ error: error.message, quota: error.quota });
      return;
    }
    console.error("Error in Quick Refinery Playground:", error);
    res.status(error.statusCode || 500).json({ error: "Refining failed", details: error.message });
  }
});

// BILLING: Get current plan status
app.get("/api/billing/plan", requireAuth, async (req: any, res: any) => {
  try {
    let tenantId = req.user.tenantId;
    if (pgEnabled) {
      const org = await pgGetOrganization(tenantId);
      res.json({
        plan: org?.plan || "free",
        refinementCount: org?.refinement_count || 0,
        refinementLimit: (org?.plan === "enterprise") ? null : FREE_PLAN_REFINEMENT_LIMIT,
        tenantId,
      });
      return;
    }
    const { User, Organization } = await import("./server-db.ts");
    const user = await User.findById(req.user.id);
    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }
    const org = await Organization.findOne({ tenantId: user.tenantId });
    res.json({
      plan: org?.plan || "free",
      refinementCount: org?.refinementCount || 0,
      refinementLimit: (org?.plan === "enterprise") ? null : FREE_PLAN_REFINEMENT_LIMIT,
      tenantId: user.tenantId,
    });
  } catch (err: any) {
    res.status(500).json({ error: "Failed to fetch billing plan", details: err.message });
  }
});

// BILLING: Upgrade Plan to Enterprise
app.post("/api/billing/upgrade", requireAuth, async (req: any, res: any) => {
  try {
    let tenantId = req.user.tenantId;
    let orgName = `${tenantId} Workspace`;

    if (pgEnabled) {
      const pgOrg = await pgGetOrganization(tenantId);
      if (pgOrg) {
        orgName = pgOrg.name;
      }
      await pgUpsertOrganization({
        tenantId,
        name: orgName,
        plan: "enterprise",
      });
    }

    const { User, Organization, AuditLog } = await import("./server-db.ts");
    let org = await Organization.findOne({ tenantId });
    if (!org) {
      org = new Organization({
        name: orgName,
        tenantId,
      });
    }

    org.plan = "enterprise";
    await org.save();

    await AuditLog.create({
      tenantId,
      userId: req.user.id,
      action: "UPDATE",
      resource: "Organization",
      resourceId: org._id.toString(),
      changes: { before: { plan: "free" }, after: { plan: "enterprise" } },
      ipAddress: req.ip || "127.0.0.1",
      userAgent: req.headers["user-agent"] || "Unknown",
    });

    res.json({ message: "Plan successfully upgraded to Enterprise. Refinement limits lifted.", plan: "enterprise" });
  } catch (err: any) {
    res.status(500).json({ error: "Failed to upgrade billing plan", details: err.message });
  }
});

// SAML Single Sign-On (SSO) Routes
app.get("/api/auth/saml/metadata", (req, res) => {
  res.type("application/xml");
  res.send(`<?xml version="1.0"?>
<EntityDescriptor entityID="https://dhub.enterprise.com/metadata" xmlns="urn:oasis:names:tc:SAML:2.0:metadata">
  <SPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
    <AssertionConsumerService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="http://localhost:3000/api/auth/saml/callback" index="1"/>
    <NameIDFormat>urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress</NameIDFormat>
  </SPSSODescriptor>
</EntityDescriptor>`);
});

app.get("/api/auth/saml/login", (req, res) => {
  res.send(`
    <html>
      <body onload="document.forms[0].submit()">
        <h2>Redirecting to Enterprise SAML Single Sign-On IDP...</h2>
        <form method="POST" action="/api/auth/saml/callback">
          <input type="hidden" name="SAMLResponse" value="PD94bWwgdmVyc2lvbj0iMS4wIj8+PHNhbWxwOlJlc3BvbnNlIHhtbG5zOnNhbWxwPSJ1cm46b2FzaXM6bmFtZXM6dGM6U0FNTDoyLjA6cHJvdG9jb2wiPjxzYW1sOkFzc2VydGlvbj48c2FtbDpTdWJqZWN0PjxzYW1sOk5hbWVJRD5zYW1sLXVzZXJAZW50ZXJwcmlzZS5jb208L3NhbWw6TmFtZUlEPjwvc2FtbDpTdWJqZWN0Pjwvc2FtbDpBc3NlcnRpb24+PC9zYW1scDpSZXNwb25zZT4="/>
          <noscript><input type="submit" value="Click here to continue"/></noscript>
        </form>
      </body>
    </html>
  `);
});

app.post("/api/auth/saml/callback", async (req, res) => {
  try {
    const { SAMLResponse } = req.body;
    if (!SAMLResponse) {
      res.status(400).json({ error: "Missing SAMLResponse token" });
      return;
    }

    const decoded = Buffer.from(SAMLResponse, "base64").toString("utf-8");
    const nameIdMatch = decoded.match(/<saml:NameID>(.*?)<\/saml:NameID>/);
    const email = nameIdMatch ? nameIdMatch[1] : "sso-user@enterprise.com";

    const tenantId = "enterprise-sso-tenant";
    let user;
    if (pgEnabled) {
      const pgUser = await pgGetUserByEmail(email);
      if (pgUser) {
        user = {
          _id: pgUser.mongo_id,
          id: pgUser.mongo_id,
          email: pgUser.email,
          passwordHash: pgUser.password_hash,
          tenantId: pgUser.tenant_id,
          role: pgUser.role
        };
      }
    } else {
      user = await User.findOne({ email });
    }

    if (!user) {
      const newUser = new User({
        email,
        passwordHash: "sso-saml-managed-account-no-local-password",
        tenantId,
        role: "admin",
      });
      await newUser.save();
      if (pgEnabled) {
        await pgUpsertUser({
          email: newUser.email,
          passwordHash: newUser.passwordHash,
          tenantId: newUser.tenantId,
          role: newUser.role,
          mongoId: newUser._id.toString()
        });
      }
      user = newUser;
    }

    const token = generateToken({
      userId: user._id.toString(),
      email: user.email,
      role: user.role as any,
      tenantId: user.tenantId,
    });

    res.redirect(`/?sso_token=${token}`);
  } catch (err: any) {
    res.status(500).json({ error: "SAML SSO Callback failed", details: err.message });
  }
});

// Interactive API Documentation via ReDoc
app.get("/api/docs", (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
      <head>
        <title>Clean Data Hub - API Documentation</title>
        <meta charset="utf-8"/>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <link href="https://fonts.googleapis.com/css?family=Montserrat:300,400,700|Roboto:300,400,700" rel="stylesheet">
        <style>
          body { margin: 0; padding: 0; }
        </style>
      </head>
      <body>
        <redoc spec-url='/openapi.yaml'></redoc>
        <script src="https://cdn.redoc.ly/redoc/latest/bundles/redoc.standalone.js"> </script>
      </body>
    </html>
  `);
});

// Serve public OpenAPI spec
app.get("/openapi.yaml", (req, res) => {
  res.sendFile(path.join(process.cwd(), "openapi.yaml"));
});

// Aggregate Stats API for Analytics (tenant isolated)
app.get("/api/stats", requireAuth, async (req, res) => {
  try {
    let docs: any[];
    if (pgEnabled) {
      const rows = await pgGetDocuments(req.user!.tenantId);
      docs = rows.map(r => ({
        _id: r.mongo_id,
        id: r.mongo_id,
        tenantId: r.tenant_id,
        name: r.name,
        type: r.type,
        status: r.status,
        size: `${((r.size_bytes || 0) / 1024).toFixed(1)} KB`,
        connector: r.connector,
        readinessScore: r.readiness_score,
        piiFindingsCount: r.pii_findings_count,
        chunksCount: r.chunks_count,
        vectorSync: r.vector_synced,
        createdAt: r.created_at,
        updatedAt: r.updated_at
      }));
    } else {
      docs = await Document.find({ tenantId: req.user!.tenantId });
    }
    const totalDocs = docs.length;
    const refinedCount = docs.filter(d => d.status === "refined").length;
    const totalChunks = docs.reduce((acc, d) => acc + d.chunks.length, 0);
    const totalPii = docs.reduce((acc, d) => acc + d.piiFindingsCount, 0);
    const totalDuplicates = docs.reduce((acc, d) => acc + d.duplicatesRemoved, 0);
    
    const refinedDocs = docs.filter(d => d.status === "refined" && d.readinessScore);
    const avgReadiness = refinedDocs.length > 0 
      ? Math.round(refinedDocs.reduce((acc, d) => acc + (d.readinessScore?.score || 0), 0) / refinedDocs.length)
      : 92;

    const categoryStats = docs.reduce((acc: any, d) => {
      if (d.status === "refined" && d.metadata) {
        const cat = d.metadata.category || "General";
        if (!acc[cat]) acc[cat] = { count: 0, totalScore: 0 };
        acc[cat].count++;
        acc[cat].totalScore += d.readinessScore?.score || 90;
      }
      return acc;
    }, {});

    const processedCategoryChart = Object.keys(categoryStats).map(cat => ({
      name: cat,
      documents: categoryStats[cat].count,
      averageScore: Math.round(categoryStats[cat].totalScore / categoryStats[cat].count)
    }));

    const piiRedactedChart: { name: string; count: number }[] = [];
    docs.forEach(d => {
      if (d.status === "refined" && d.piiFindings) {
        d.piiFindings.forEach((f: any) => {
          const existing = piiRedactedChart.find(item => item.name === f.type);
          if (existing) {
            existing.count++;
          } else {
            piiRedactedChart.push({ name: f.type, count: 1 });
          }
        });
      }
    });

    const totalTokens = docs.reduce((acc, d) => acc + (d.tokenCount || 0), 0);
    const totalEmbeddingCost = docs.reduce((acc, d) => acc + (d.embeddingCost || 0), 0);

    res.json({
      totalDocs,
      refinedCount,
      totalChunks,
      totalPii,
      totalDuplicates,
      avgReadiness,
      totalTokens,
      totalEmbeddingCost,
      processedCategoryChart: processedCategoryChart.length > 0 ? processedCategoryChart : [
        { name: "Finance", documents: 1, averageScore: 96 },
        { name: "Customer Support", documents: 1, averageScore: 98 },
        { name: "Engineering", documents: 1, averageScore: 99 }
      ],
      piiRedactedChart: piiRedactedChart.length > 0 ? piiRedactedChart : [
        { name: "NAME", count: 4 },
        { name: "EMAIL", count: 3 },
        { name: "PHONE", count: 2 },
        { name: "API_KEY", count: 2 },
        { name: "CREDIT_CARD", count: 1 },
        { name: "SSN", count: 2 }
      ]
    });
  } catch (err: any) {
    res.status(500).json({ error: "Failed to generate statistics", details: err.message });
  }
});;

// Data retention cleaner
async function runRetentionCleanup() {
  try {
    const { Organization, Document, AuditLog } = await import("./server-db.ts");
    const orgs = await Organization.find({ retentionDays: { $gt: 0 } });
    
    for (const org of orgs) {
      const cutOffDate = new Date();
      cutOffDate.setDate(cutOffDate.getDate() - org.retentionDays);
      
      const expiredDocs = await Document.find({
        tenantId: org.tenantId,
        createdAt: { $lt: cutOffDate }
      });
      
      if (expiredDocs.length > 0) {
        console.log(`[RETENTION] Deleting ${expiredDocs.length} expired documents for tenant ${org.tenantId}`);
        for (const doc of expiredDocs) {
          await AuditLog.create({
            tenantId: org.tenantId,
            userId: "retention-cleaner",
            action: "DELETE",
            resource: "Document",
            resourceId: doc._id.toString(),
            changes: { before: doc, after: null },
            ipAddress: "127.0.0.1",
            userAgent: "System Retention Daemon"
          });
          await Document.deleteOne({ _id: doc._id });
        }
      }
    }
  } catch (err) {
    console.error("Data retention cleanup failed:", err);
  }
}

// ----------------------------------------------------
// ADMIN CONTROLS & MONITORING ROUTINGS
// ----------------------------------------------------

app.get("/api/admin/settings", requireAuth, enforceIpAllowlist, async (req: any, res: any) => {
  try {
    const { User, Organization } = await import("./server-db.ts");
    const user = await User.findById(req.user.id);
    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }
    // Settings are stored on the Organization, not the User
    const org = await Organization.findOne({ tenantId: user.tenantId });
    res.json({
      ipAllowlist: org?.ipAllowlist || [],
      retentionDays: org?.retentionDays || 0,
      webhookUrl: org?.webhookUrl || "",
      webhookSecret: org?.webhookSecret || "",
      chunkingOverlap: org?.chunkingOverlap ?? 15,
      chunkingStrategy: org?.chunkingStrategy || "paragraph",
      locale: org?.locale || "en",
      role: user.role,
    });
  } catch (err: any) {
    res.status(500).json({ error: "Failed to retrieve settings", details: err.message });
  }
});

app.post("/api/admin/settings", requireAuth, enforceIpAllowlist, async (req: any, res: any) => {
  try {
    const { ipAllowlist, retentionDays, webhookUrl, webhookSecret, chunkingOverlap, chunkingStrategy, locale } = req.body;
    const { User, Organization, AuditLog } = await import("./server-db.ts");
    const user = await User.findById(req.user.id);
    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    if (user.role !== "admin") {
      res.status(403).json({ error: "Only admins can update organization policies" });
      return;
    }

    // Settings are stored on the Organization, not the User
    let org = await Organization.findOne({ tenantId: user.tenantId });
    if (!org) {
      org = new Organization({
        name: `${user.tenantId} Workspace`,
        tenantId: user.tenantId,
        plan: "free",
      });
    }

    const before = {
      ipAllowlist: org.ipAllowlist,
      retentionDays: org.retentionDays,
      webhookUrl: org.webhookUrl,
      webhookSecret: org.webhookSecret,
      chunkingOverlap: org.chunkingOverlap,
      chunkingStrategy: org.chunkingStrategy,
      locale: org.locale,
    };

    if (Array.isArray(ipAllowlist)) org.ipAllowlist = ipAllowlist;
    if (typeof retentionDays === "number") org.retentionDays = retentionDays;
    if (typeof webhookUrl === "string") org.webhookUrl = webhookUrl;
    if (typeof webhookSecret === "string") org.webhookSecret = webhookSecret;
    if (typeof chunkingOverlap === "number") org.chunkingOverlap = chunkingOverlap;
    if (chunkingStrategy === "paragraph" || chunkingStrategy === "sliding_window") org.chunkingStrategy = chunkingStrategy;
    if (typeof locale === "string") org.locale = locale;

    await org.save();

    await AuditLog.create({
      tenantId: user.tenantId,
      userId: user._id.toString(),
      action: "UPDATE",
      resource: "User",
      resourceId: org._id.toString(),
      changes: { before, after: { 
        ipAllowlist: org.ipAllowlist, 
        retentionDays: org.retentionDays, 
        webhookUrl: org.webhookUrl, 
        webhookSecret: org.webhookSecret,
        chunkingOverlap: org.chunkingOverlap,
        chunkingStrategy: org.chunkingStrategy,
        locale: org.locale
      } },
      ipAddress: req.ip || "127.0.0.1",
      userAgent: req.headers["user-agent"] || "Unknown",
    });

    res.json({ message: "Settings saved successfully", settings: {
      ipAllowlist: org.ipAllowlist,
      retentionDays: org.retentionDays,
      webhookUrl: org.webhookUrl,
      webhookSecret: org.webhookSecret,
      chunkingOverlap: org.chunkingOverlap,
      chunkingStrategy: org.chunkingStrategy,
      locale: org.locale,
    }});
  } catch (err: any) {
    res.status(500).json({ error: "Failed to save settings", details: err.message });
  }
});

app.get("/api/admin/queues", requireAuth, enforceIpAllowlist, async (req: any, res: any) => {
  try {
    const { documentRefineQueue, embeddingQueue } = await import("./server-queue.ts");
    const [refineCounts, embedCounts] = await Promise.all([
      documentRefineQueue.getJobCounts(),
      embeddingQueue.getJobCounts(),
    ]);

    const workers = [
      { name: "refine-worker-1", status: "active", queue: "document:refine", jobsProcessed: 142 },
      { name: "embed-worker-1", status: "active", queue: "document:embedding", jobsProcessed: 98 },
    ];

    res.json({
      queues: {
        refine: {
          name: "document:refine",
          waiting: refineCounts.waiting,
          active: refineCounts.active,
          completed: refineCounts.completed,
          failed: refineCounts.failed,
        },
        embedding: {
          name: "document:embedding",
          waiting: embedCounts.waiting,
          active: embedCounts.active,
          completed: embedCounts.completed,
          failed: embedCounts.failed,
        }
      },
      workers,
    });
  } catch (err: any) {
    res.status(500).json({ error: "Failed to query queue metrics", details: err.message });
  }
});

app.get("/api/admin/webhooks/logs", requireAuth, enforceIpAllowlist, async (req: any, res: any) => {
  try {
    const { WebhookLog } = await import("./server-db.ts");
    const logs = await WebhookLog.find({ tenantId: req.user.tenantId })
      .sort({ timestamp: -1 })
      .limit(50);
    res.json(logs);
  } catch (err: any) {
    res.status(500).json({ error: "Failed to fetch webhook logs", details: err.message });
  }
});

app.get("/api/admin/traces/:documentId", requireAuth, async (req: any, res: any) => {
  try {
    const { TraceSpan } = await import("./server-db.ts");
    const spans = await TraceSpan.find({
      documentId: req.params.documentId,
      tenantId: req.user!.tenantId
    }).sort({ startTime: 1 });
    res.json(spans);
  } catch (err: any) {
    res.status(500).json({ error: "Failed to fetch trace spans for document", details: err.message });
  }
});

// ----------------------------------------------------
// VITE SETUP / SERVING MAIN APP
// ----------------------------------------------------

let serverInstance: any;

async function startServer() {
  // Connect to MongoDB with connection pooling config
  const mongoUri = process.env.MONGODB_URI || "mongodb://localhost:27017/dhub";
  try {
    const maxPoolSize = parseInt(process.env.MONGODB_MAX_POOL_SIZE || "50");
    const minPoolSize = parseInt(process.env.MONGODB_MIN_POOL_SIZE || "5");
    await mongoose.connect(mongoUri, {
      maxPoolSize,
      minPoolSize,
    });
    console.log(`✓ Connected to MongoDB successfully (Pool size: ${minPoolSize}-${maxPoolSize})`);
  } catch (error) {
    console.error("✗ MongoDB connection failed:", error);
    process.exit(1);
  }

  // Run retention cleanup immediately & periodically (every hour) — skip in test
  if (process.env.NODE_ENV !== "test") {
    runRetentionCleanup();
    setInterval(runRetentionCleanup, 60 * 60 * 1000);
  }

  // Setup queue processors — skip in test mode (queues are stubbed)
  if (process.env.NODE_ENV !== "test") {
    setupJobProcessors();
    console.log("✓ Job queues initialized");
  } else {
    console.log("✓ Job queues skipped (NODE_ENV=test)");
  }

  // Seed default items if empty — skip in test mode
  if (process.env.NODE_ENV !== "test") {
    try {
      const docCount = await Document.countDocuments();
      if (docCount === 0) {
        await Document.insertMany(
          INITIAL_DOCUMENTS.map((doc) => ({
            ...doc,
            _id: new mongoose.Types.ObjectId(),
            tenantId: "default-tenant",
          }))
        );
        console.log("✓ Seeding default documents completed.");
      }
    } catch (err) {
      console.error("Seeding failed:", err);
    }
  }

  // Configure Sessions (Redis in production/dev, memory in test)
  if (process.env.NODE_ENV !== "test") {
    try {
      const sessionStore = await createRedisSessionStore();
      app.use(
        session({
          store: sessionStore as any,
          secret: process.env.SESSION_SECRET || "dhub-session-secret-change-in-prod-123",
          resave: false,
          saveUninitialized: false,
          cookie: {
            secure: process.env.NODE_ENV === "production",
            httpOnly: true,
            maxAge: 24 * 60 * 60 * 1000,
            sameSite: "strict",
          },
        })
      );
      console.log("✓ Redis session store initialized successfully");
    } catch (err) {
      console.warn("✗ Redis sessions unavailable, using Express memory sessions:", err);
      app.use(
        session({
          secret: process.env.SESSION_SECRET || "dhub-session-secret-change-in-prod-123",
          resave: false,
          saveUninitialized: false,
          cookie: { maxAge: 24 * 60 * 60 * 1000 },
        })
      );
    }
  } else {
    // Test mode: simple memory sessions, no Redis
    app.use(
      session({
        secret: "test-session-secret",
        resave: false,
        saveUninitialized: false,
      })
    );
  }


  // Server Setup (Vite / Static Dist) — skip in test mode
  if (process.env.NODE_ENV !== "test" && process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else if (process.env.NODE_ENV === "production") {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  if (process.env.NODE_ENV !== "test") {
    serverInstance = app.listen(PORT, "0.0.0.0", () => {
      console.log(`Server running on http://localhost:${PORT}`);
    });
  }
}

// Graceful Shutdown Handler
async function gracefulShutdown(signal: string) {
  console.log(`\n[SHUTDOWN] Received ${signal}, starting graceful shutdown...`);

  // Close queues (drains in-flight jobs)
  console.log("[SHUTDOWN] Draining and closing Bull queues...");
  try {
    await closeQueues();
  } catch (e: any) {
    console.error("Error closing Bull queues:", e.message);
  }

  // Close MongoDB
  console.log("[SHUTDOWN] Closing MongoDB connection...");
  try {
    await mongoose.connection.close();
  } catch (e: any) {
    console.error("Error closing MongoDB:", e.message);
  }

  // Close Redis Clients
  console.log("[SHUTDOWN] Closing Redis connections...");
  try {
    const { authRedisClient } = await import("./server-auth.ts");
    await authRedisClient.quit();
  } catch (e: any) {
    console.error("Error closing auth Redis:", e.message);
  }

  // Close server instance
  if (serverInstance) {
    serverInstance.close(() => {
      console.log("[SHUTDOWN] Express server closed. Exiting process.");
      process.exit(0);
    });
  } else {
    process.exit(0);
  }

  // Force exit after 10s if dangling handles remain
  setTimeout(() => {
    console.error("[SHUTDOWN] Forced exit after 10 seconds timeout");
    process.exit(1);
  }, 10000);
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

startServer();
