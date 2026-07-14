import crypto from "crypto";

export interface VectorDbAdapter {
  upsert(documentId: string, chunks: any[], embeddings: number[][], tenantId: string): Promise<void>;
  delete(documentId: string, tenantId: string): Promise<void>;
  query(queryVector: number[], tenantId: string, limit: number): Promise<any[]>;
  healthCheck(): Promise<boolean>;
}

export async function retryWithBackoff<T>(fn: () => Promise<T>, retries = 3, delay = 1000): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (retries <= 0) throw error;
    console.warn(`Vector DB operation failed, retrying in ${delay}ms... Error:`, (error as Error).message);
    await new Promise((resolve) => setTimeout(resolve, delay));
    return retryWithBackoff(fn, retries - 1, delay * 2);
  }
}

/**
 * Generate a deterministic UUID based on input string (for vector IDs)
 */
export function createDeterministicUUID(input: string): string {
  const hash = crypto.createHash("md5").update(input).digest("hex");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
}

/**
 * Qdrant Vector Database REST Adapter
 */
export class QdrantAdapter implements VectorDbAdapter {
  private url: string;
  private apiKey: string;
  private collectionName: string;

  constructor() {
    this.url = (process.env.QDRANT_URL || process.env.VECTOR_DB_URL || "http://localhost:6333").replace(/\/$/, "");
    this.apiKey = process.env.QDRANT_API_KEY || "";
    this.collectionName = process.env.QDRANT_COLLECTION || "documents";
  }

  private getHeaders(): HeadersInit {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.apiKey) {
      headers["api-key"] = this.apiKey;
    }
    return headers;
  }

  async upsert(documentId: string, chunks: any[], embeddings: number[][], tenantId: string): Promise<void> {
    const points = chunks.map((chunk, index) => {
      const vector = embeddings[index];
      const deterministicId = createDeterministicUUID(`${documentId}-${chunk.id}-${index}`);
      const chunkHash = crypto.createHash("sha256").update(chunk.text).digest("hex");
      return {
        id: deterministicId,
        vector,
        payload: {
          documentId,
          tenantId,
          chunkId: chunk.id,
          text: chunk.text,
          headingContext: chunk.headingContext || "",
          chunkHash,
        },
      };
    });

    // Ensure collection exists first (ignore if it already exists)
    try {
      await fetch(`${this.url}/collections/${this.collectionName}`, {
        method: "PUT",
        headers: this.getHeaders(),
        body: JSON.stringify({
          vectors: {
            size: embeddings[0]?.length || 1536,
            distance: "Cosine",
          },
        }),
      });
    } catch (e) {
      // Ignore if collection already exists
    }

    // Version sync check: fetch existing points to compare hashes
    let pointsToUpsert = points;
    try {
      const ids = points.map((p) => p.id);
      const pointsRes = await fetch(`${this.url}/collections/${this.collectionName}/points`, {
        method: "POST",
        headers: this.getHeaders(),
        body: JSON.stringify({ ids, with_payload: true, with_vector: false }),
      });
      if (pointsRes.ok) {
        const data = await pointsRes.json();
        const existingPoints = data.result || [];
        const existingHashMap = new Map<string, string>();
        for (const ep of existingPoints) {
          if (ep?.payload?.chunkHash) {
            existingHashMap.set(ep.id, ep.payload.chunkHash);
          }
        }

        pointsToUpsert = points.filter((p) => {
          const existingHash = existingHashMap.get(p.id);
          return existingHash !== p.payload.chunkHash;
        });
      }
    } catch (e) {
      console.warn("Failed to fetch existing Qdrant points for version comparison, proceeding with overwrite:", (e as Error).message);
    }

    if (pointsToUpsert.length === 0) {
      console.log(`[QDRANT] All ${points.length} chunks up-to-date. Skipping upsert.`);
      return;
    }

    console.log(`[QDRANT] Upserting ${pointsToUpsert.length} / ${points.length} chunks`);

    await retryWithBackoff(async () => {
      const response = await fetch(`${this.url}/collections/${this.collectionName}/points?wait=true`, {
        method: "PUT",
        headers: this.getHeaders(),
        body: JSON.stringify({ points: pointsToUpsert }),
      });

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Qdrant upsert failed: ${response.statusText} - ${errText}`);
      }
    });
  }

  async delete(documentId: string, tenantId: string): Promise<void> {
    const response = await fetch(`${this.url}/collections/${this.collectionName}/points/delete`, {
      method: "POST",
      headers: this.getHeaders(),
      body: JSON.stringify({
        filter: {
          must: [
            { key: "documentId", match: { value: documentId } },
            { key: "tenantId", match: { value: tenantId } },
          ],
        },
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Qdrant delete failed: ${response.statusText} - ${errText}`);
    }
  }

  async query(queryVector: number[], tenantId: string, limit: number = 5): Promise<any[]> {
    const response = await fetch(`${this.url}/collections/${this.collectionName}/points/search`, {
      method: "POST",
      headers: this.getHeaders(),
      body: JSON.stringify({
        vector: queryVector,
        limit,
        filter: {
          must: [
            { key: "tenantId", match: { value: tenantId } },
          ],
        },
        with_payload: true,
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Qdrant search failed: ${response.statusText} - ${errText}`);
    }

    const data = await response.json();
    return (data.result || []).map((match: any) => ({
      id: match.id,
      score: match.score,
      payload: match.payload,
    }));
  }

  async healthCheck(): Promise<boolean> {
    try {
      const response = await fetch(`${this.url}/health`, {
        method: "GET",
        headers: this.getHeaders(),
      });
      return response.ok;
    } catch (e) {
      return false;
    }
  }
}

/**
 * Pinecone Vector Database REST Adapter
 */
export class PineconeAdapter implements VectorDbAdapter {
  private host: string;
  private apiKey: string;

  constructor() {
    this.host = (process.env.PINECONE_HOST || process.env.VECTOR_DB_URL || "").replace(/\/$/, "");
    this.apiKey = process.env.PINECONE_API_KEY || "";
  }

  private getHeaders(): HeadersInit {
    return {
      "Content-Type": "application/json",
      "Api-Key": this.apiKey,
    };
  }

  async upsert(documentId: string, chunks: any[], embeddings: number[][], tenantId: string): Promise<void> {
    if (!this.host) throw new Error("Pinecone index host (VECTOR_DB_URL) is not configured");

    const vectors = chunks.map((chunk, index) => {
      const values = embeddings[index];
      const deterministicId = createDeterministicUUID(`${documentId}-${chunk.id}-${index}`);
      const chunkHash = crypto.createHash("sha256").update(chunk.text).digest("hex");
      return {
        id: deterministicId,
        values,
        metadata: {
          documentId,
          tenantId,
          chunkId: chunk.id,
          text: chunk.text,
          headingContext: chunk.headingContext || "",
          chunkHash,
        },
      };
    });

    // Version sync check: query existing Pinecone vectors to check hashes
    let vectorsToUpsert = vectors;
    try {
      const idsQuery = vectors.map((v) => `ids=${v.id}`).join("&");
      const fetchRes = await fetch(`${this.host}/vectors/fetch?${idsQuery}`, {
        method: "GET",
        headers: this.getHeaders(),
      });
      if (fetchRes.ok) {
        const data = await fetchRes.json();
        const existingVectors = data.vectors || {};
        const existingHashMap = new Map<string, string>();
        for (const [vid, vdata] of Object.entries(existingVectors)) {
          const meta = (vdata as any)?.metadata;
          if (meta?.chunkHash) {
            existingHashMap.set(vid, meta.chunkHash);
          }
        }
        vectorsToUpsert = vectors.filter((v) => {
          const existingHash = existingHashMap.get(v.id);
          return existingHash !== v.metadata.chunkHash;
        });
      }
    } catch (e) {
      console.warn("Failed to fetch existing Pinecone vectors for version comparison, proceeding with overwrite:", (e as Error).message);
    }

    if (vectorsToUpsert.length === 0) {
      console.log(`[PINECONE] All ${vectors.length} chunks up-to-date. Skipping upsert.`);
      return;
    }

    console.log(`[PINECONE] Upserting ${vectorsToUpsert.length} / ${vectors.length} chunks`);

    await retryWithBackoff(async () => {
      const response = await fetch(`${this.host}/vectors/upsert`, {
        method: "POST",
        headers: this.getHeaders(),
        body: JSON.stringify({ vectors: vectorsToUpsert }),
      });

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Pinecone upsert failed: ${response.statusText} - ${errText}`);
      }
    });
  }

  async delete(documentId: string, tenantId: string): Promise<void> {
    if (!this.host) throw new Error("Pinecone index host is not configured");

    const response = await fetch(`${this.host}/vectors/delete`, {
      method: "POST",
      headers: this.getHeaders(),
      body: JSON.stringify({
        filter: {
          documentId: { $eq: documentId },
          tenantId: { $eq: tenantId },
        },
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Pinecone delete failed: ${response.statusText} - ${errText}`);
    }
  }

  async query(queryVector: number[], tenantId: string, limit: number = 5): Promise<any[]> {
    if (!this.host) throw new Error("Pinecone index host is not configured");

    const response = await fetch(`${this.host}/query`, {
      method: "POST",
      headers: this.getHeaders(),
      body: JSON.stringify({
        vector: queryVector,
        topK: limit,
        filter: {
          tenantId: { $eq: tenantId },
        },
        includeMetadata: true,
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Pinecone query failed: ${response.statusText} - ${errText}`);
    }

    const data = await response.json();
    return (data.matches || []).map((match: any) => ({
      id: match.id,
      score: match.score,
      payload: match.metadata,
    }));
  }

  async healthCheck(): Promise<boolean> {
    if (!this.host) return false;
    try {
      const response = await fetch(`${this.host}/describe_index_stats`, {
        method: "POST",
        headers: this.getHeaders(),
        body: JSON.stringify({}),
      });
      return response.ok;
    } catch (e) {
      return false;
    }
  }
}

class GenericRestVectorAdapter implements VectorDbAdapter {
  protected url: string;
  protected apiKey: string;
  protected collectionName: string;
  protected adapterName: string;

  constructor(adapterName: string) {
    this.adapterName = adapterName;
    this.url = (process.env.VECTOR_DB_URL || "").replace(/\/$/, "");
    this.apiKey = process.env.VECTOR_DB_API_KEY || "";
    this.collectionName = process.env.VECTOR_DB_COLLECTION || "documents";
  }

  protected getHeaders(): HeadersInit {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
    return headers;
  }

  async upsert(documentId: string, chunks: any[], embeddings: number[][], tenantId: string): Promise<void> {
    if (!this.url) throw new Error(`${this.adapterName} VECTOR_DB_URL is not configured`);
    const response = await fetch(`${this.url}/vectors/upsert`, {
      method: "POST",
      headers: this.getHeaders(),
      body: JSON.stringify({
        collection: this.collectionName,
        vectors: chunks.map((chunk, index) => ({
          id: createDeterministicUUID(`${documentId}-${chunk.id}-${index}`),
          values: embeddings[index],
          metadata: { documentId, tenantId, chunkId: chunk.id, text: chunk.text, headingContext: chunk.headingContext || "" },
        })),
      }),
    });
    if (!response.ok) throw new Error(`${this.adapterName} upsert failed: ${response.statusText} - ${await response.text()}`);
  }

  async delete(documentId: string, tenantId: string): Promise<void> {
    if (!this.url) throw new Error(`${this.adapterName} VECTOR_DB_URL is not configured`);
    const response = await fetch(`${this.url}/vectors/delete`, {
      method: "POST",
      headers: this.getHeaders(),
      body: JSON.stringify({ collection: this.collectionName, filter: { documentId, tenantId } }),
    });
    if (!response.ok) throw new Error(`${this.adapterName} delete failed: ${response.statusText} - ${await response.text()}`);
  }

  async query(queryVector: number[], tenantId: string, limit: number = 5): Promise<any[]> {
    if (!this.url) throw new Error(`${this.adapterName} VECTOR_DB_URL is not configured`);
    const response = await fetch(`${this.url}/vectors/query`, {
      method: "POST",
      headers: this.getHeaders(),
      body: JSON.stringify({ collection: this.collectionName, vector: queryVector, tenantId, limit }),
    });
    if (!response.ok) throw new Error(`${this.adapterName} query failed: ${response.statusText} - ${await response.text()}`);
    const data = await response.json();
    return data.matches || data.results || [];
  }

  async healthCheck(): Promise<boolean> {
    if (!this.url) return false;
    try {
      const response = await fetch(`${this.url}/health`, { headers: this.getHeaders() });
      return response.ok;
    } catch {
      return false;
    }
  }
}

export class ChromaAdapter extends GenericRestVectorAdapter {
  constructor() { super("Chroma"); }
}

export class MilvusAdapter extends GenericRestVectorAdapter {
  constructor() { super("Milvus"); }
}

export class WeaviateAdapter extends GenericRestVectorAdapter {
  constructor() { super("Weaviate"); }

  async upsert(documentId: string, chunks: any[], embeddings: number[][], tenantId: string): Promise<void> {
    if (!this.url) throw new Error("Weaviate VECTOR_DB_URL is not configured");
    const objects = chunks.map((chunk, index) => ({
      class: this.collectionName,
      id: createDeterministicUUID(`${documentId}-${chunk.id}-${index}`),
      vector: embeddings[index],
      properties: { documentId, tenantId, chunkId: chunk.id, text: chunk.text, headingContext: chunk.headingContext || "" },
    }));
    const response = await fetch(`${this.url}/v1/batch/objects`, {
      method: "POST",
      headers: this.getHeaders(),
      body: JSON.stringify({ objects }),
    });
    if (!response.ok) throw new Error(`Weaviate upsert failed: ${response.statusText} - ${await response.text()}`);
  }
}
/**
 * Pluggable factory to retrieve configured adapter
 */
export function getVectorDbAdapter(): VectorDbAdapter {
  const type = (process.env.VECTOR_DB_TYPE || "qdrant").toLowerCase();
  if (type === "pinecone") return new PineconeAdapter();
  if (type === "weaviate") return new WeaviateAdapter();
  if (type === "milvus") return new MilvusAdapter();
  if (type === "chroma" || type === "chromadb") return new ChromaAdapter();
  return new QdrantAdapter();
}
