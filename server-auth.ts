import jwt from "jsonwebtoken";
import { Request, Response, NextFunction } from "express";
import crypto from "crypto";
import bcrypt from "bcryptjs";
import redis from "redis";
import { pgEnabled, pgGetUserById, pgGetOrganization } from "./server-pg.ts";

// Extend Express Request with user info
declare global {
  namespace Express {
    interface Request {
      user?: {
        id: string;
        email: string;
        role: "admin" | "user" | "viewer";
        tenantId?: string;
      };
      sessionId?: string;
    }
  }
}

const JWT_SECRET = process.env.JWT_SECRET || "your-super-secret-key-change-in-production";
const JWT_EXPIRY = process.env.JWT_EXPIRY || "24h";
const REFRESH_TOKEN_SECRET = process.env.REFRESH_TOKEN_SECRET || "refresh-secret-change-in-production";

const IS_TEST = process.env.NODE_ENV === "test";

// Redis client for rate limiting and fallback sessions
// In test mode, export a no-op stub to prevent connection attempts
const redisHost = process.env.REDIS_HOST || "localhost";
const redisPort = parseInt(process.env.REDIS_PORT || "6379");
const redisPassword = process.env.REDIS_PASSWORD;
const redisUrl = process.env.REDIS_URL;

export const authRedisClient: any = IS_TEST
  ? {
      get: async () => null,
      set: async () => null,
      del: async () => null,
      incr: async () => 1,
      expire: async () => true,
      pTTL: async () => 60000,
      eval: async () => [1, 60000],
      ping: async () => "PONG",
      quit: async () => {},
      sendCommand: async () => null,
      isOpen: true,
    }
  : redis.createClient(
      redisUrl
        ? { url: redisUrl, socket: { reconnectStrategy: (retries) => Math.min(retries * 50, 2000) } }
        : { socket: { host: redisHost, port: redisPort, reconnectStrategy: (retries) => Math.min(retries * 50, 2000) }, password: redisPassword }
    );

if (!IS_TEST) {
  (authRedisClient as any).connect().catch((err: any) => {
    console.warn("Auth Redis Client connection failed; rate-limited routes will return 503 until Redis is available:", err.message);
  });
}

// Session store - fallback to in-memory Map for development if Redis unavailable
const sessions = new Map<string, SessionData>();

interface SessionData {
  userId: string;
  email: string;
  role: "admin" | "user" | "viewer";
  tenantId: string;
  createdAt: number;
  expiresAt: number;
  ipAddress: string;
  userAgent: string;
}

interface TokenPayload {
  userId: string;
  email: string;
  role: "admin" | "user" | "viewer";
  tenantId: string;
}

/**
 * Generate JWT token
 */
export function generateToken(user: TokenPayload): string {
  return jwt.sign(user, JWT_SECRET, { expiresIn: JWT_EXPIRY });
}

/**
 * Generate refresh token
 */
export function generateRefreshToken(user: TokenPayload): string {
  return jwt.sign(user, REFRESH_TOKEN_SECRET, { expiresIn: "7d" });
}

/**
 * Verify JWT token
 */
export function verifyToken(token: string): TokenPayload | null {
  try {
    return jwt.verify(token, JWT_SECRET) as TokenPayload;
  } catch (error) {
    return null;
  }
}

/**
 * Verify refresh token
 */
export function verifyRefreshToken(token: string): TokenPayload | null {
  try {
    return jwt.verify(token, REFRESH_TOKEN_SECRET) as TokenPayload;
  } catch (error) {
    return null;
  }
}

/**
 * Create session
 */
export function createSession(user: TokenPayload, req: Request): string {
  const sessionId = crypto.randomBytes(32).toString("hex");
  const sessionData: SessionData = {
    userId: user.userId,
    email: user.email,
    role: user.role,
    tenantId: user.tenantId,
    createdAt: Date.now(),
    expiresAt: Date.now() + 24 * 60 * 60 * 1000, // 24 hours
    ipAddress: req.ip || "unknown",
    userAgent: req.get("user-agent") || "unknown",
  };

  sessions.set(sessionId, sessionData);
  return sessionId;
}

/**
 * Get session
 */
export function getSession(sessionId: string): SessionData | null {
  const session = sessions.get(sessionId);
  if (!session) return null;

  // Check expiration
  if (session.expiresAt < Date.now()) {
    sessions.delete(sessionId);
    return null;
  }

  return session;
}

/**
 * Invalidate session
 */
export function invalidateSession(sessionId: string): void {
  sessions.delete(sessionId);
}

/**
 * Middleware: Verify JWT token
 */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;

  if (!token) {
    res.status(401).json({ error: "Missing authorization token" });
    return;
  }

  const payload = verifyToken(token);
  if (!payload) {
    res.status(401).json({ error: "Invalid or expired token" });
    return;
  }

  req.user = {
    id: payload.userId,
    email: payload.email,
    role: payload.role,
    tenantId: payload.tenantId,
  };

  next();
}

/**
 * Middleware: Verify session
 */
export function requireSession(req: Request, res: Response, next: NextFunction): void {
  const sessionId = req.cookies?.sessionId || req.headers["x-session-id"];

  if (!sessionId) {
    res.status(401).json({ error: "Missing session" });
    return;
  }

  const session = getSession(sessionId as string);
  if (!session) {
    res.status(401).json({ error: "Invalid or expired session" });
    return;
  }

  req.user = {
    id: session.userId,
    email: session.email,
    role: session.role,
    tenantId: session.tenantId,
  };
  req.sessionId = sessionId as string;

  next();
}

/**
 * Middleware: Require specific role
 */
export function requireRole(...roles: Array<"admin" | "user" | "viewer">) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) {
      res.status(401).json({ error: "Not authenticated" });
      return;
    }

    if (!roles.includes(req.user.role)) {
      res.status(403).json({ error: "Insufficient permissions" });
      return;
    }

    next();
  };
}

const RATE_LIMIT_SCRIPT = `
local current = redis.call("INCR", KEYS[1])
if current == 1 then
  redis.call("PEXPIRE", KEYS[1], ARGV[1])
end
local ttl = redis.call("PTTL", KEYS[1])
return { current, ttl }
`;

/**
 * Middleware: Redis-backed rate limiting.
 *
 * Counters live in Redis, so limits survive restarts and are shared across
 * all server pods. If Redis is unavailable, the route fails closed instead
 * of silently reverting to per-process counters.
 */
export function rateLimit(maxRequests: number = 100, windowMs: number = 60000) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const authHeader = req.headers.authorization;
    const bearerToken = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
    const tokenPayload = bearerToken ? verifyToken(bearerToken) : null;
    const subject = req.user?.id || tokenPayload?.userId || req.ip || "anonymous";
    const key = `rl:${subject}:${Math.floor(Date.now() / windowMs)}`;
    const windowSeconds = Math.ceil(windowMs / 1000);

    if (!authRedisClient?.isOpen) {
      res.set("Retry-After", String(windowSeconds));
      res.status(503).json({ error: "Rate limiter unavailable" });
      return;
    }

    try {
      let current: number;
      let ttlMs: number;

      if (typeof authRedisClient.eval === "function") {
        const result = await authRedisClient.eval(RATE_LIMIT_SCRIPT, {
          keys: [key],
          arguments: [String(windowMs)],
        });
        current = Number(result?.[0] ?? 0);
        ttlMs = Number(result?.[1] ?? windowMs);
      } else {
        current = await authRedisClient.incr(key);
        if (current === 1) {
          await authRedisClient.expire(key, windowSeconds);
        }
        ttlMs = typeof authRedisClient.pTTL === "function" ? await authRedisClient.pTTL(key) : windowMs;
      }

      const resetMs = ttlMs > 0 ? ttlMs : windowMs;
      const retryAfter = Math.ceil(resetMs / 1000);
      const remaining = Math.max(0, maxRequests - current);
      res.set("X-RateLimit-Limit", String(maxRequests));
      res.set("X-RateLimit-Remaining", String(remaining));
      res.set("X-RateLimit-Reset", String(Math.ceil((Date.now() + resetMs) / 1000)));

      if (current > maxRequests) {
        res.set("Retry-After", String(retryAfter));
        res.status(429).json({ error: "Rate limit exceeded", retryAfter });
        return;
      }

      next();
    } catch (err: any) {
      console.error("Redis rate limiter failed:", err.message);
      res.set("Retry-After", String(windowSeconds));
      res.status(503).json({ error: "Rate limiter unavailable" });
    }
  };
}
/**
 * Hash password using bcryptjs
 */
export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 12);
}

/**
 * Verify password using bcryptjs
 */
export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

/**
 * Middleware: Enforce IP Allow-listing per tenant organization
 */
export async function enforceIpAllowlist(req: Request, res: Response, next: NextFunction) {
  if (!req.user) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }

  try {
    let userEmail = "";
    let allowlist: string[] = [];

    if (pgEnabled) {
      const user = await pgGetUserById(req.user.id, req.user.tenantId || "");
      if (!user) {
        res.status(401).json({ error: "User not found" });
        return;
      }
      userEmail = user.email;
      const org = await pgGetOrganization(user.tenant_id);
      allowlist = org ? (org.ip_allowlist || []) : [];
    } else {
      const { User, Organization } = await import("./server-db.ts");
      const user = await User.findById(req.user.id);
      if (!user) {
        res.status(401).json({ error: "User not found" });
        return;
      }
      userEmail = user.email;
      const org = await Organization.findOne({ tenantId: user.tenantId });
      allowlist = org ? (org.ipAllowlist || []) : [];
    }

    if (allowlist.length === 0) {
      // If allowlist is empty, allow access from all IPs
      return next();
    }

    const clientIp = req.ip || "127.0.0.1";
    
    // Normalize localhost / loopbacks
    const isAllowed = allowlist.some((ip) => {
      const normalizedIp = ip.trim();
      if (normalizedIp === clientIp) return true;
      if (normalizedIp === "127.0.0.1" && (clientIp === "::1" || clientIp === "::ffff:127.0.0.1")) return true;
      if (normalizedIp === "::1" && (clientIp === "127.0.0.1" || clientIp === "::ffff:127.0.0.1")) return true;
      return false;
    });

    if (!isAllowed) {
      console.warn(`[IP_BLOCK] Blocked request from IP ${clientIp} for user ${userEmail}`);
      res.status(403).json({ error: "Access denied: client IP address is not allow-listed" });
      return;
    }

    next();
  } catch (err: any) {
    console.error("IP verification failed:", err);
    res.status(500).json({ error: "Internal server error verifying IP address access controls" });
  }
}
