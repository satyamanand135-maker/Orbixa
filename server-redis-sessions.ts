/**
 * Redis Session Store for Production
 * 
 * Provides a Redis-backed session store configuration
 * compatible with redis v4 clients.
 */

import redis from "redis";

/**
 * Create Redis-backed session store
 */
export async function createRedisSessionStore() {
  const redisClient = redis.createClient({
    socket: {
      host: process.env.REDIS_HOST || "localhost",
      port: parseInt(process.env.REDIS_PORT || "6379"),
    },
    password: process.env.REDIS_PASSWORD,
    database: 1, // Use database 1 for sessions (0 is for job queues)
  });

  await redisClient.connect();

  return {
    get: async (sessionId: string) => {
      const data = await redisClient.get(`session:${sessionId}`);
      return data ? JSON.parse(data) : null;
    },
    set: async (sessionId: string, sessionData: any) => {
      await redisClient.setEx(
        `session:${sessionId}`,
        24 * 60 * 60, // 24 hours TTL
        JSON.stringify(sessionData)
      );
    },
    destroy: async (sessionId: string) => {
      await redisClient.del(`session:${sessionId}`);
    },
    touch: async (sessionId: string, sessionData: any) => {
      await redisClient.setEx(
        `session:${sessionId}`,
        24 * 60 * 60,
        JSON.stringify(sessionData)
      );
    },
    length: async () => {
      const keys = await redisClient.keys("session:*");
      return keys.length;
    },
    clear: async () => {
      const keys = await redisClient.keys("session:*");
      if (keys.length > 0) {
        await redisClient.del(keys);
      }
    },
    all: async () => {
      const keys = await redisClient.keys("session:*");
      const sessions: Record<string, any> = {};
      for (const key of keys) {
        const sessionId = key.replace("session:", "");
        const data = await redisClient.get(key);
        if (data) {
          sessions[sessionId] = JSON.parse(data);
        }
      }
      return sessions;
    },
  };
}

/**
 * Session monitoring utilities
 */
export async function getSessionStats() {
  const redisClient = redis.createClient({
    socket: {
      host: process.env.REDIS_HOST || "localhost",
      port: parseInt(process.env.REDIS_PORT || "6379"),
    },
    password: process.env.REDIS_PASSWORD,
    database: 1,
  });

  await redisClient.connect();

  const keys = await redisClient.keys("session:*");
  const sessions = [];

  for (const key of keys) {
    const data = await redisClient.get(key);
    if (data) {
      sessions.push({
        sessionId: key.replace("session:", ""),
        data: JSON.parse(data),
        ttl: await redisClient.ttl(key),
      });
    }
  }

  await redisClient.quit();

  return {
    totalSessions: sessions.length,
    sessions: sessions,
    memoryUsage: await getRedisMemory(),
  };
}

async function getRedisMemory() {
  const redisClient = redis.createClient({
    socket: {
      host: process.env.REDIS_HOST || "localhost",
      port: parseInt(process.env.REDIS_PORT || "6379"),
    },
    password: process.env.REDIS_PASSWORD,
  });

  await redisClient.connect();
  const info = await redisClient.info("memory");
  await redisClient.quit();
  return info;
}
