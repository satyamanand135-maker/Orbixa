import crypto from "crypto";
import fs from "fs/promises";
import path from "path";

export interface PresignInput {
  key: string;
  contentType?: string;
  expiresSeconds?: number;
}

export interface PresignedUpload {
  provider: "s3" | "r2" | "local";
  method: "PUT";
  url: string;
  headers: Record<string, string>;
  key: string;
  expiresAt: string;
}

function hmac(key: Buffer | string, data: string): Buffer {
  return crypto.createHmac("sha256", key).update(data).digest();
}

function sha256Hex(data: string): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

function sanitizeKey(key: string): string {
  return key.replace(/^\/+/, "").replace(/\.\./g, "_");
}

export function getStorageProvider(): "s3" | "r2" | "local" {
  return (process.env.OBJECT_STORAGE_PROVIDER || (process.env.S3_BUCKET ? "s3" : "local")).toLowerCase() as any;
}

export function createPresignedUpload(input: PresignInput): PresignedUpload {
  const provider = getStorageProvider();
  const key = sanitizeKey(input.key);
  const expiresSeconds = Math.min(Math.max(input.expiresSeconds || 900, 60), 3600);
  const expiresAt = new Date(Date.now() + expiresSeconds * 1000).toISOString();
  const contentType = input.contentType || "application/octet-stream";

  if (provider === "local") {
    return {
      provider,
      method: "PUT",
      url: `/api/storage/upload?key=${encodeRfc3986(key)}`,
      headers: { "Content-Type": contentType },
      key,
      expiresAt,
    };
  }

  const accessKeyId = process.env.S3_ACCESS_KEY_ID || process.env.R2_ACCESS_KEY_ID || "";
  const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY || process.env.R2_SECRET_ACCESS_KEY || "";
  const bucket = process.env.S3_BUCKET || process.env.R2_BUCKET || "";
  const region = process.env.S3_REGION || "auto";
  const endpoint = (process.env.S3_ENDPOINT || process.env.R2_ENDPOINT || `https://${bucket}.s3.${region}.amazonaws.com`).replace(/\/$/, "");

  if (!accessKeyId || !secretAccessKey || !bucket) {
    throw new Error("Object storage credentials are incomplete. Configure S3/R2 keys and bucket, or set OBJECT_STORAGE_PROVIDER=local.");
  }

  const now = new Date();
  const dateStamp = now.toISOString().slice(0, 10).replace(/-/g, "");
  const amzDate = `${dateStamp}T${now.toISOString().slice(11, 19).replace(/:/g, "")}Z`;
  const host = new URL(endpoint).host;
  const credentialScope = `${dateStamp}/${region}/s3/aws4_request`;
  const credential = `${accessKeyId}/${credentialScope}`;
  const canonicalUri = `/${bucket}/${key.split("/").map(encodeRfc3986).join("/")}`;
  const signedHeaders = "host";
  const query: Record<string, string> = {
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": credential,
    "X-Amz-Date": amzDate,
    "X-Amz-Expires": String(expiresSeconds),
    "X-Amz-SignedHeaders": signedHeaders,
  };
  const canonicalQuery = Object.keys(query).sort().map((name) => `${encodeRfc3986(name)}=${encodeRfc3986(query[name])}`).join("&");
  const canonicalRequest = ["PUT", canonicalUri, canonicalQuery, `host:${host}\n`, signedHeaders, "UNSIGNED-PAYLOAD"].join("\n");
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, credentialScope, sha256Hex(canonicalRequest)].join("\n");
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${secretAccessKey}`, dateStamp), region), "s3"), "aws4_request");
  const signature = crypto.createHmac("sha256", signingKey).update(stringToSign).digest("hex");

  return {
    provider,
    method: "PUT",
    url: `${endpoint}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`,
    headers: { "Content-Type": contentType },
    key,
    expiresAt,
  };
}

export async function saveLocalObject(key: string, body: Buffer): Promise<{ key: string; bytes: number; path: string }> {
  const safeKey = sanitizeKey(key);
  const root = path.join(process.cwd(), "object-storage");
  const target = path.join(root, safeKey);
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  if (!resolvedTarget.startsWith(resolvedRoot)) throw new Error("Invalid object key");
  await fs.mkdir(path.dirname(resolvedTarget), { recursive: true });
  await fs.writeFile(resolvedTarget, body);
  return { key: safeKey, bytes: body.length, path: resolvedTarget };
}