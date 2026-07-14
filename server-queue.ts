import Queue from "bull";
import redis from "redis";

const IS_TEST = process.env.NODE_ENV === "test";

// In test mode, create a no-op stub instead of real Bull queues
// to prevent Redis connection attempts that block process.exit()
function createQueue(name: string) {
  if (IS_TEST) {
    // Minimal no-op stub satisfying the Queue API used by the app
    const noop = async () => {};
    const stub: any = {
      name,
      process: noop,
      add: async () => ({ id: "test-job-stub" }),
      close: async () => {},
      getJobCounts: async () => ({ waiting: 0, active: 0, completed: 0, failed: 0 }),
      on: () => stub,
      off: () => stub,
    };
    return stub as Queue.Queue;
  }
  return new Queue(name, {
    redis: {
      host: process.env.REDIS_HOST || "localhost",
      port: parseInt(process.env.REDIS_PORT || "6379"),
      password: process.env.REDIS_PASSWORD,
    },
  });
}

// Redis client for session store (skipped in test mode)
export const redisClient = IS_TEST ? null : redis.createClient({
  socket: {
    host: process.env.REDIS_HOST || "localhost",
    port: parseInt(process.env.REDIS_PORT || "6379"),
  },
  password: process.env.REDIS_PASSWORD,
});

// Create queues for different processing stages
export const documentRefineQueue = createQueue("document:refine");
export const piiDetectionQueue   = createQueue("pii:detection");
export const connectorSyncQueue  = createQueue("connector:sync");
export const embeddingQueue      = createQueue("embedding:generate");

// Job configurations
export const JOB_OPTIONS = {
  refine: {
    attempts: 3,
    backoff: { type: "exponential", delay: 2000 },
    removeOnComplete: true,
    removeOnFail: false,
  },
  pii: {
    attempts: 2,
    backoff: { type: "fixed", delay: 1000 },
  },
  sync: {
    attempts: 5,
    backoff: { type: "exponential", delay: 3000 },
  },
  embedding: {
    attempts: 3,
    backoff: { type: "exponential", delay: 2000 },
  },
};

if (!IS_TEST) {
  // Queue event handlers — only register in non-test environments
  documentRefineQueue.on("completed", (job) => {
    console.log(`[QUEUE] Document refine job ${job.id} completed`);
  });

  documentRefineQueue.on("failed", (job, err) => {
    console.error(`[QUEUE] Document refine job ${job.id} failed:`, err.message);
  });

  piiDetectionQueue.on("completed", (job) => {
    console.log(`[QUEUE] PII detection job ${job.id} completed`);
  });

  piiDetectionQueue.on("failed", (job, err) => {
    console.error(`[QUEUE] PII detection job ${job.id} failed:`, err.message);
  });

  connectorSyncQueue.on("completed", (job) => {
    console.log(`[QUEUE] Connector sync job ${job.id} completed`);
  });

  connectorSyncQueue.on("failed", (job, err) => {
    console.error(`[QUEUE] Connector sync job ${job.id} failed:`, err.message);
  });
}

// Helper to add jobs
export async function addRefineJob(documentId: string) {
  return await documentRefineQueue.add({ documentId }, JOB_OPTIONS.refine);
}

export async function addPiiJob(documentId: string) {
  return await piiDetectionQueue.add({ documentId }, JOB_OPTIONS.pii);
}

export async function addConnectorSyncJob(connectorId: string, options: any = {}) {
  return await connectorSyncQueue.add({ connectorId }, { ...JOB_OPTIONS.sync, ...options });
}

export async function addEmbeddingJob(documentId: string, chunkIds: string[]) {
  return await embeddingQueue.add({ documentId, chunkIds }, JOB_OPTIONS.embedding);
}

// Cleanup connections
export async function closeQueues() {
  await Promise.all([
    documentRefineQueue.close(),
    piiDetectionQueue.close(),
    connectorSyncQueue.close(),
    embeddingQueue.close(),
  ]);
}
