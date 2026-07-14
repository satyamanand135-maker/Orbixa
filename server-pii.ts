import { execFile } from "child_process";
import { promisify } from "util";
import path from "path";
import fs from "fs";
import crypto from "crypto";

// Enhanced PII patterns with regex

// Initialize NLP for entity extraction (optional - currently using pattern matching)
// const nlpManager = new NlpManager({ languages: ["en"] });

// Enhanced PII patterns with regex
const PII_PATTERNS = {
  EMAIL: {
    regex: /([a-zA-Z0-9._%-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g,
    type: "EMAIL",
  },
  PHONE: {
    regex: /(\+?\d{1,3}[-.\s]?\(?\d{1,4}\)?[-.\s]?\d{1,4}[-.\s]?\d{1,9})/g,
    type: "PHONE",
  },
  SSN: {
    regex: /(\d{3}-\d{2}-\d{4}|\d{9})/g,
    type: "SSN",
  },
  CREDIT_CARD: {
    regex: /(\d{4}[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{4}|\d{4}[-\s]?\d{6}[-\s]?\d{5})/g,
    type: "CREDIT_CARD",
  },
  AWS_ACCESS_KEY: {
    regex: /(AKIA[0-9A-Z]{16})/g,
    type: "API_KEY",
  },
  GENERIC_API_KEY: {
    regex: /(api[_-]?key|apikey)[\s=:]+([a-zA-Z0-9_\-]{20,})/gi,
    type: "API_KEY",
  },
  JWT_TOKEN: {
    regex: /(eyJ[A-Za-z0-9_\-=.]*){3,}/g,
    type: "JWT",
  },
  PASSWORD_PLAIN: {
    regex: /(password|passwd|pwd)[\s=:]+[^\s]{8,}/gi,
    type: "PASSWORD",
  },
  DATABASE_URL: {
    regex: /(mongodb|postgresql|mysql):\/\/[^\s]+/gi,
    type: "DATABASE_URL",
  },
  PRIVATE_KEY: {
    regex: /(-----BEGIN PRIVATE KEY-----[\s\S]+-----END PRIVATE KEY-----)/g,
    type: "PRIVATE_KEY",
  },
  GITHUB_TOKEN: {
    regex: /(ghp_[a-zA-Z0-9]{36}|ghu_[a-zA-Z0-9]{36})/g,
    type: "GITHUB_TOKEN",
  },
  // Pattern for common person names - improved to catch more variations
  PERSON_NAME: {
    regex: /\b(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr)\.?\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)\b/g,
    type: "NAME",
  },
  // Indian names pattern (common in enterprise)
  INDIAN_NAME: {
    regex: /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\s+(Sharma|Singh|Patel|Gupta|Kumar|Reddy|Verma|Rao|Iyer|Nair|Kapoor|Khanna|Malhotra|Bhat|Desai|Joshi|Pillai|Bera|Das|Roy|Banerji|Mishra|Chaudhary|Agarwal|Pandey|Sinha|Tiwari|Saxena|Pathak|Dutta|Ganguly|Nandi|Sengupta)\b/g,
    type: "NAME",
  },
};

export interface PIIFinding {
  type: string;
  value: string;
  position: number;
  context: string;
}

export interface PIIDetectionResult {
  redactedText: string;
  findings: PIIFinding[];
  findingsCount: number;
}


const execFileAsync = promisify(execFile);


function getLocalePatterns(locale: string): Record<string, { regex: RegExp; type: string }> {
  const patterns: Record<string, { regex: RegExp; type: string }> = {};
  if (locale === "hi") {
    patterns.AADHAAR = {
      regex: /\b\d{4}\s\d{4}\s\d{4}\b/g,
      type: "AADHAAR_NUMBER"
    };
    patterns.PAN = {
      regex: /\b[A-Z]{5}[0-9]{4}[A-Z]{1}\b/g,
      type: "PAN_CARD"
    };
  } else if (locale === "fr") {
    patterns.INSEE = {
      regex: /\b[12]\d{2}(0[1-9]|1[0-2])\d{10}\b/g,
      type: "INSEE_NUMBER"
    };
  } else if (locale === "ar") {
    patterns.ARABIC_NATIONAL_ID = {
      regex: /\b\d{10,14}\b/g,
      type: "NATIONAL_ID"
    };
  }
  return patterns;
}

/**
 * Enhanced PII detection.
 *
 * Dispatch priority (Gap 4 — non-blocking Celery first):
 *   1. Celery worker via Redis queue (when CELERY_ENABLED=true) — non-blocking
 *   2. pii_detector_multilang.py sidecar (Presidio + language NER, Gap 16)
 *   3. pdf_parser.py legacy sidecar (English only)
 *   4. Local regex patterns (fallback when Python unavailable)
 */
export async function detectPII(text: string, locale: string = "en"): Promise<PIIDetectionResult> {
  const lang = locale.split("-")[0].toLowerCase();

  // ------------------------------------------------------------------
  // Gap 4: Celery path — dispatch to Python worker via Redis task queue
  // ------------------------------------------------------------------
  const CELERY_ENABLED = process.env.CELERY_ENABLED === "true";
  if (CELERY_ENABLED) {
    try {
      const { createClient } = await import("redis");
      const redisUrl = process.env.REDIS_URL || `redis://${process.env.REDIS_HOST || "localhost"}:${process.env.REDIS_PORT || 6379}`;
      const client = createClient({ url: redisUrl });
      await client.connect();

      const jobId = `pii-${crypto.randomUUID()}`;
      const resultKey = `dhub_pii_result:${jobId}`;
      const task = JSON.stringify({ taskName: "redact_pii", args: { text, language: lang, job_id: jobId }, jobId });
      await client.lPush("dhub_pii_tasks", task);

      // Poll up to 60 seconds for Celery result
      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline) {
        const raw = await client.get(resultKey);
        if (raw) {
          await client.del(resultKey);
          await client.quit();
          const result = JSON.parse(raw);
          if (result.error) throw new Error(result.error);
          return {
            redactedText: result.redacted || result.redactedText || text,
            findings: (result.findings || []).map((f: any) => ({
              type: f.type, value: f.value, position: f.start || 0,
              context: text.substring(Math.max(0, (f.start || 0) - 20), Math.min(text.length, (f.end || 0) + 20)).trim(),
            })),
            findingsCount: (result.findings || []).length,
          };
        }
        await new Promise((r) => setTimeout(r, 300));
      }
      await client.quit();
      console.warn("[PII] Celery task timed out, falling back to direct exec");
    } catch (celeryErr: any) {
      console.warn("[PII] Celery dispatch failed, falling back to direct exec:", celeryErr.message);
    }
  }

  // ------------------------------------------------------------------
  // Direct exec path (Gap 3 — multilang sidecar, then legacy)
  // ------------------------------------------------------------------
  try {
    const pythonPath = process.env.PYTHON_PATH || "python";
    const multilangScript = path.join(process.cwd(), "pii_detector_multilang.py");
    const legacyScript    = path.join(process.cwd(), "pdf_parser.py");

    let stdout: string;
    if (fs.existsSync(multilangScript)) {
      ({ stdout } = await execFileAsync(pythonPath, [multilangScript, text, lang], { maxBuffer: 10 * 1024 * 1024 }));
      const result = JSON.parse(stdout);
      if (result.error) throw new Error(result.error);
      return {
        redactedText: result.redacted || text,
        findings: (result.findings || []).map((f: any) => ({
          type: f.type, value: f.value, position: f.start || 0,
          context: text.substring(Math.max(0, (f.start || 0) - 20), Math.min(text.length, (f.end || 0) + 20)).trim(),
        })),
        findingsCount: (result.findings || []).length,
      };
    } else if (fs.existsSync(legacyScript)) {
      ({ stdout } = await execFileAsync(pythonPath, [legacyScript, "redact", text, lang]));
      const result = JSON.parse(stdout);
      if (result.error) throw new Error(result.error);
      return {
        redactedText: result.redactedText || "",
        findings: (result.findings || []).map((f: any) => ({
          type: f.type, value: f.value, position: f.start || 0,
          context: text.substring(Math.max(0, (f.start || 0) - 20), Math.min(text.length, (f.end || 0) + 20)).trim(),
        })),
        findingsCount: (result.findings || []).length,
      };
    }
    throw new Error("No Python PII sidecar available");
  } catch (error: any) {
    console.warn("[PII] Python sidecar failed, using local regex patterns:", error.message);
    const findings: PIIFinding[] = [];
    let redactedText = text;

    const localePatterns = getLocalePatterns(locale);
    const allPatterns = { ...PII_PATTERNS, ...localePatterns };

    // Pattern-based detection
    for (const [patternName, pattern] of Object.entries(allPatterns)) {
      const matches = text.matchAll(pattern.regex);

      for (const match of matches) {
        const value = match[0] || match[1] || match[2];
        const position = match.index || 0;
        const context = text.substring(Math.max(0, position - 30), Math.min(text.length, position + value.length + 30));

        findings.push({
          type: pattern.type,
          value,
          position,
          context: context.trim(),
        });

        redactedText = redactedText.replace(
          new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"),
          `[REDACTED_${pattern.type}]`
        );
      }
    }

    return {
      redactedText,
      findings,
      findingsCount: findings.length
    };
  }
}

// Local mock processor starts below
export async function detectPIILocalMock(text: string): Promise<PIIDetectionResult> {
  const findings: PIIFinding[] = [];
  let redactedText = text;
  try {
    // Simple name pattern - capitalized words that are likely names
    const namePattern = /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\b/g;
    const nameMatches = text.matchAll(namePattern);

    const commonNames = new Set([
      "John", "Jane", "Michael", "Sarah", "David", "Emily", "Robert", "Jessica",
      "James", "Jennifer", "William", "Linda", "Richard", "Patricia", "Joseph",
      "Barbara", "Thomas", "Nancy", "Charles", "Lisa", "Christopher", "Betty"
    ]);

    for (const match of nameMatches) {
      const name = match[0];
      const firstName = name.split(" ")[0];

      if (commonNames.has(firstName) && !findings.some(f => f.value === name)) {
        const position = match.index || 0;
        findings.push({
          type: "NAME",
          value: name,
          position,
          context: text.substring(Math.max(0, position - 30), Math.min(text.length, position + name.length + 30)).trim(),
        });

        redactedText = redactedText.replace(
          new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"),
          "[REDACTED_NAME]"
        );
      }
    }
  } catch (error) {
    console.warn("Name extraction failed:", error);
  }

  // Remove duplicates while preserving type
  const uniqueFindings = findings.filter((value, index, self) =>
    index === self.findIndex((t) => t.value === value.value && t.type === value.type)
  );

  return {
    redactedText,
    findings: uniqueFindings,
    findingsCount: uniqueFindings.length,
  };
}

/**
 * Get PII statistics from findings
 */
export function getPIIStatistics(findings: PIIFinding[]) {
  const stats: { [key: string]: number } = {};

  for (const finding of findings) {
    stats[finding.type] = (stats[finding.type] || 0) + 1;
  }

  return stats;
}

/**
 * Check if text contains high-risk PII
 */
export function hasHighRiskPII(findings: PIIFinding[]): boolean {
  const highRiskTypes = ["SSN", "CREDIT_CARD", "PRIVATE_KEY", "API_KEY", "DATABASE_URL", "JWT"];
  return findings.some((f) => highRiskTypes.includes(f.type));
}

/**
 * Generate PII risk level
 */
export function calculatePIIRisk(findings: PIIFinding[]): "low" | "medium" | "high" {
  if (findings.length === 0) return "low";
  if (hasHighRiskPII(findings)) return "high";
  if (findings.length > 10) return "high";
  if (findings.length > 5) return "medium";
  return "low";
}
