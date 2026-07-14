import crypto from "crypto";

// Encryption helper for storing sensitive credentials
// CRITICAL: Must be set in environment - random generation means credentials lost on restart
if (!process.env.ENCRYPTION_KEY) {
  throw new Error(
    "ENCRYPTION_KEY environment variable is required. Generate with: " +
    "node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\""
  );
}
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY;

export function encryptCredential(credential: string): string {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv("aes-256-cbc", Buffer.from(ENCRYPTION_KEY, "hex"), iv);
  let encrypted = cipher.update(credential, "utf-8", "hex");
  encrypted += cipher.final("hex");
  return iv.toString("hex") + ":" + encrypted;
}

export function decryptCredential(encrypted: string): string {
  const parts = encrypted.split(":");
  const iv = Buffer.from(parts[0], "hex");
  const decipher = crypto.createDecipheriv("aes-256-cbc", Buffer.from(ENCRYPTION_KEY, "hex"), iv);
  let decrypted = decipher.update(parts[1], "hex", "utf-8");
  decrypted += decipher.final("utf-8");
  return decrypted;
}

export type OAuthProvider = "google-drive" | "notion" | "slack" | "github";

interface OAuthProviderConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  authorizationUrl: string;
  tokenUrl: string;
  scope: string;
  extraAuthParams?: Record<string, string>;
  connectorType: string;
  connectorName: string;
}

function env(...names: string[]): string {
  for (const name of names) {
    if (process.env[name]) return process.env[name] as string;
  }
  return "";
}

// OAuth config for connector providers
export const OAUTH_CONFIG: Record<OAuthProvider, OAuthProviderConfig> = {
  "google-drive": {
    clientId: env("GOOGLE_OAUTH_CLIENT_ID") || "your-client-id.apps.googleusercontent.com",
    clientSecret: env("GOOGLE_OAUTH_CLIENT_SECRET"),
    redirectUri: env("GOOGLE_OAUTH_REDIRECT_URI", "GOOGLE_OAUTH_CALLBACK_URL") || "http://localhost:3000/api/connectors/oauth/google-drive/callback",
    authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    scope: "https://www.googleapis.com/auth/drive.readonly",
    extraAuthParams: { access_type: "offline", prompt: "consent" },
    connectorType: "Google Drive",
    connectorName: "Google Drive Workspace",
  },
  notion: {
    clientId: env("NOTION_OAUTH_CLIENT_ID"),
    clientSecret: env("NOTION_OAUTH_CLIENT_SECRET"),
    redirectUri: env("NOTION_OAUTH_REDIRECT_URI", "NOTION_OAUTH_CALLBACK_URL") || "http://localhost:3000/api/connectors/oauth/notion/callback",
    authorizationUrl: "https://api.notion.com/v1/oauth/authorize",
    tokenUrl: "https://api.notion.com/v1/oauth/token",
    scope: "",
    connectorType: "Notion",
    connectorName: "Notion Knowledge Base",
  },
  slack: {
    clientId: env("SLACK_OAUTH_CLIENT_ID"),
    clientSecret: env("SLACK_OAUTH_CLIENT_SECRET"),
    redirectUri: env("SLACK_OAUTH_REDIRECT_URI", "SLACK_OAUTH_CALLBACK_URL") || "http://localhost:3000/api/connectors/oauth/slack/callback",
    authorizationUrl: "https://slack.com/oauth/v2/authorize",
    tokenUrl: "https://slack.com/api/oauth.v2.access",
    scope: "channels:history,groups:history,im:history,mpim:history,files:read,team:read",
    connectorType: "Slack",
    connectorName: "Slack Workspace",
  },
  github: {
    clientId: env("GITHUB_OAUTH_CLIENT_ID"),
    clientSecret: env("GITHUB_OAUTH_CLIENT_SECRET"),
    redirectUri: env("GITHUB_OAUTH_REDIRECT_URI", "GITHUB_OAUTH_CALLBACK_URL") || "http://localhost:3000/api/connectors/oauth/github/callback",
    authorizationUrl: "https://github.com/login/oauth/authorize",
    tokenUrl: "https://github.com/login/oauth/access_token",
    scope: "repo,read:user",
    connectorType: "GitHub",
    connectorName: "GitHub Repositories",
  },
};

// Generate OAuth authorization URL
export function generateAuthorizationUrl(provider: OAuthProvider, state: string): string {
  const config = OAUTH_CONFIG[provider];
  if (!config.clientId) {
    throw new Error(`OAuth client ID is not configured for ${provider}`);
  }

  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: "code",
    state,
    ...config.extraAuthParams,
  });

  if (config.scope) params.set("scope", config.scope);
  return `${config.authorizationUrl}?${params.toString()}`;
}

// Exchange authorization code for access token
export async function exchangeCodeForToken(
  provider: OAuthProvider,
  code: string
): Promise<{ accessToken: string; refreshToken?: string; expiresIn?: number; raw: any }> {
  const config = OAUTH_CONFIG[provider];
  if (!config.clientId || !config.clientSecret) {
    throw new Error(`OAuth client credentials are not configured for ${provider}`);
  }

  const params = new URLSearchParams({
    code,
    client_id: config.clientId,
    client_secret: config.clientSecret,
    redirect_uri: config.redirectUri,
    grant_type: "authorization_code",
  });

  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    };
    if (provider === "notion") {
      headers.Authorization = `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64")}`;
    }

    const response = await fetch(config.tokenUrl, {
      method: "POST",
      headers,
      body: params.toString(),
    });

    if (!response.ok) {
      throw new Error(`OAuth token exchange failed: ${response.statusText}`);
    }

    const data = await response.json();
    if (data.ok === false) {
      throw new Error(`OAuth token exchange failed: ${data.error || "provider rejected request"}`);
    }

    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresIn: data.expires_in,
      raw: data,
    };
  } catch (error) {
    console.error(`OAuth exchange failed for ${provider}:`, error);
    throw error;
  }
}

// Refresh access token
export async function refreshAccessToken(
  provider: OAuthProvider,
  refreshToken: string
): Promise<string> {
  const config = OAUTH_CONFIG[provider];

  const params = new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });

  try {
    const response = await fetch(config.tokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: params.toString(),
    });

    if (!response.ok) {
      throw new Error(`Token refresh failed: ${response.statusText}`);
    }

    const data = await response.json();
    return data.access_token;
  } catch (error) {
    console.error(`Token refresh failed for ${provider}:`, error);
    throw error;
  }
}

// Get user info from OAuth provider
export async function getUserInfo(
  provider: OAuthProvider,
  accessToken: string
): Promise<{ id: string; name: string; email: string }> {
  try {
    if (provider === "google-drive") {
      const response = await fetch("https://www.googleapis.com/oauth2/v1/userinfo", {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const data = await response.json();
      return {
        id: data.id,
        name: data.name,
        email: data.email,
      };
    } else if (provider === "github") {
      const response = await fetch("https://api.github.com/user", {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/vnd.github.v3+json",
        },
      });
      const data = await response.json();
      return {
        id: data.id.toString(),
        name: data.name || data.login,
        email: data.email || `${data.login}@github.com`,
      };
    } else if (provider === "slack") {
      const response = await fetch("https://slack.com/api/auth.test", {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const data = await response.json();
      return {
        id: data.user_id || data.team_id,
        name: data.team || data.user || "Slack Workspace",
        email: data.url || "",
      };
    } else if (provider === "notion") {
      return {
        id: "notion-workspace",
        name: "Notion Workspace",
        email: "",
      };
    }
  } catch (error) {
    console.error(`Failed to get user info from ${provider}:`, error);
    throw error;
  }

  throw new Error(`Unsupported provider: ${provider}`);
}
