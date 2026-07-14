/**
 * server-secrets.ts — Secrets Manager integration (Gap 7)
 *
 * Loads secrets from AWS Secrets Manager, Azure Key Vault, or HashiCorp Vault
 * and injects them into process.env so the rest of the app works unchanged.
 *
 * Priority chain:
 *   1. AWS Secrets Manager (if AWS_REGION + SECRET_NAME set)
 *   2. Azure Key Vault (if AZURE_KEY_VAULT_NAME set)
 *   3. HashiCorp Vault (if VAULT_ADDR set)
 *   4. .env file (existing behaviour — never overwritten by secrets manager)
 *
 * All providers degrade gracefully: if credentials are absent the function
 * returns without error and process.env is unchanged.
 *
 * Usage in server.ts:
 *   import { loadSecrets } from "./server-secrets.ts";
 *   await loadSecrets();   // Call BEFORE any other import that reads env
 */

import { logStructured } from "./server-observability.ts";

// ---------------------------------------------------------------------------
// AWS Secrets Manager
// ---------------------------------------------------------------------------
async function loadFromAWS(): Promise<boolean> {
  const region = process.env.AWS_REGION;
  const secretName = process.env.AWS_SECRET_NAME || "dhub/production";

  if (!region) return false;

  try {
    const { SecretsManagerClient, GetSecretValueCommand } = await import(
      "@aws-sdk/client-secrets-manager" as any
    );
    const client = new SecretsManagerClient({ region });
    const response = await client.send(new GetSecretValueCommand({ SecretId: secretName }));

    const raw = response.SecretString;
    if (!raw) return false;

    const secrets: Record<string, string> = JSON.parse(raw);
    let count = 0;
    for (const [key, value] of Object.entries(secrets)) {
      // Only inject if not already set in environment (env file wins on explicit override)
      if (!process.env[key]) {
        process.env[key] = String(value);
        count++;
      }
    }
    logStructured("info", `[Secrets] Loaded ${count} secrets from AWS Secrets Manager`, { secretName });
    return true;
  } catch (err: any) {
    if (err.name === "ResourceNotFoundException") {
      logStructured("warn", `[Secrets] AWS secret not found: ${secretName}`);
    } else if (err.message?.includes("not installed")) {
      logStructured("warn", "[Secrets] @aws-sdk/client-secrets-manager not installed — skipping AWS");
    } else {
      logStructured("warn", `[Secrets] AWS Secrets Manager failed: ${err.message}`);
    }
    return false;
  }
}

// ---------------------------------------------------------------------------
// Azure Key Vault
// ---------------------------------------------------------------------------
async function loadFromAzure(): Promise<boolean> {
  const vaultName = process.env.AZURE_KEY_VAULT_NAME;
  if (!vaultName) return false;

  try {
    const { SecretClient } = await import("@azure/keyvault-secrets" as any);
    const { DefaultAzureCredential } = await import("@azure/identity" as any);

    const vaultUrl = `https://${vaultName}.vault.azure.net`;
    const client = new SecretClient(vaultUrl, new DefaultAzureCredential());

    const secretNames = (process.env.AZURE_SECRET_NAMES || "").split(",").filter(Boolean);
    let count = 0;
    for (const name of secretNames) {
      const secret = await client.getSecret(name);
      const envKey = name.replace(/-/g, "_").toUpperCase();
      if (!process.env[envKey] && secret.value) {
        process.env[envKey] = secret.value;
        count++;
      }
    }
    logStructured("info", `[Secrets] Loaded ${count} secrets from Azure Key Vault`, { vaultName });
    return true;
  } catch (err: any) {
    logStructured("warn", `[Secrets] Azure Key Vault failed: ${err.message}`);
    return false;
  }
}

// ---------------------------------------------------------------------------
// HashiCorp Vault (KV v2)
// ---------------------------------------------------------------------------
async function loadFromVault(): Promise<boolean> {
  const vaultAddr = process.env.VAULT_ADDR;
  const vaultToken = process.env.VAULT_TOKEN;
  const vaultPath = process.env.VAULT_SECRET_PATH || "secret/data/dhub";

  if (!vaultAddr || !vaultToken) return false;

  try {
    const resp = await fetch(`${vaultAddr}/v1/${vaultPath}`, {
      headers: { "X-Vault-Token": vaultToken },
    });

    if (!resp.ok) {
      logStructured("warn", `[Secrets] Vault returned ${resp.status} for path ${vaultPath}`);
      return false;
    }

    const body = await resp.json() as any;
    const data: Record<string, string> = body?.data?.data || body?.data || {};
    let count = 0;
    for (const [key, value] of Object.entries(data)) {
      if (!process.env[key]) {
        process.env[key] = String(value);
        count++;
      }
    }
    logStructured("info", `[Secrets] Loaded ${count} secrets from HashiCorp Vault`, { path: vaultPath });
    return true;
  } catch (err: any) {
    logStructured("warn", `[Secrets] HashiCorp Vault failed: ${err.message}`);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
export async function loadSecrets(): Promise<void> {
  const provider = (process.env.SECRETS_PROVIDER || "").toLowerCase();

  if (provider === "aws" || process.env.AWS_SECRET_NAME) {
    await loadFromAWS();
    return;
  }

  if (provider === "azure" || process.env.AZURE_KEY_VAULT_NAME) {
    await loadFromAzure();
    return;
  }

  if (provider === "vault" || process.env.VAULT_ADDR) {
    await loadFromVault();
    return;
  }

  // No secrets manager configured — .env file is sufficient
  logStructured("info", "[Secrets] No secrets manager configured — using .env only");
}
