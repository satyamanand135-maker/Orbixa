import crypto from "crypto";

export interface EmbeddingProvider {
  name: string;
  dimensions: number;
  embed(texts: string[]): Promise<number[][]>;
}

function deterministicVector(text: string, dimensions: number = 1536): number[] {
  const hash = crypto.createHash("sha256").update(text).digest("hex");
  const seed = parseInt(hash.slice(0, 8), 16);
  const vector: number[] = [];

  for (let i = 0; i < dimensions; i++) {
    const x = Math.sin(seed + i) * 10000;
    vector.push(Number((x - Math.floor(x)).toFixed(6)));
  }

  return vector;
}

class DeterministicEmbeddingProvider implements EmbeddingProvider {
  name = "deterministic";
  dimensions = 1536;

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((text) => deterministicVector(text, this.dimensions));
  }
}

class PythonSidecarEmbeddingProvider implements EmbeddingProvider {
  name = "python-sidecar";
  dimensions = 1536;

  async embed(texts: string[]): Promise<number[][]> {
    const { execFile } = await import("child_process");
    const { promisify } = await import("util");
    const path = await import("path");
    const execFileAsync = promisify(execFile);
    const pythonPath = process.env.PYTHON_PATH || "python";
    const scriptPath = path.join(process.cwd(), "pdf_parser.py");

    const { stdout } = await execFileAsync(pythonPath, [scriptPath, "embed", JSON.stringify(texts)]);
    const result = JSON.parse(stdout);
    if (result.error) throw new Error(result.error);
    return result.embeddings;
  }
}

class OpenAICompatibleEmbeddingProvider implements EmbeddingProvider {
  name: string;
  dimensions: number;
  private url: string;
  private apiKey: string;
  private model: string;

  constructor() {
    this.name = process.env.EMBEDDING_PROVIDER || "openai-compatible";
    this.url = process.env.EMBEDDING_API_URL || "https://api.openai.com/v1/embeddings";
    this.apiKey = process.env.EMBEDDING_API_KEY || process.env.OPENAI_API_KEY || "";
    this.model = process.env.EMBEDDING_MODEL || "text-embedding-3-small";
    this.dimensions = Number(process.env.EMBEDDING_DIMENSIONS || 1536);
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (!this.apiKey) throw new Error("EMBEDDING_API_KEY or OPENAI_API_KEY is required for REST embedding provider");

    const response = await fetch(this.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({ model: this.model, input: texts }),
    });

    if (!response.ok) {
      throw new Error(`Embedding REST provider failed: ${response.status} ${await response.text()}`);
    }

    const payload = await response.json();
    const vectors = (payload.data || []).map((item: any) => item.embedding);
    if (vectors.length !== texts.length) throw new Error("Embedding provider returned an unexpected vector count");
    return vectors;
  }
}

/**
 * Gap 17 — Gemini Embedding Provider (text-embedding-004)
 * Free tier: 1500 requests/day, 768 dimensions
 */
class GeminiEmbeddingProvider implements EmbeddingProvider {
  name = "gemini";
  dimensions = 768; // text-embedding-004 output size

  async embed(texts: string[]): Promise<number[][]> {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error("GEMINI_API_KEY is required for Gemini embedding provider");

    const embeddings: number[][] = [];
    // Gemini API batches 1 text per request
    for (const text of texts) {
      const resp = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:embedContent?key=${apiKey}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: "models/text-embedding-004",
            content: { parts: [{ text }] },
          }),
        }
      );
      if (!resp.ok) throw new Error(`Gemini embedding failed: ${resp.status} ${await resp.text()}`);
      const data = await resp.json() as any;
      embeddings.push(data.embedding?.values || []);
    }
    return embeddings;
  }
}



/**
 * Gap 17 — Fully config-driven embedding provider selection.
 *
 * Provider is chosen by EMBEDDING_PROVIDER env var with this priority:
 *   1. "gemini"          → Google Gemini text-embedding-004 (free tier)
 *   2. "openai"/"rest"   → OpenAI-compatible REST endpoint
 *   3. "python-sidecar"  → Local sentence-transformers via pdf_parser.py
 *   4. "deterministic"   → SHA-256 pseudo-embedding (test/fallback)
 *
 * If EMBEDDING_PROVIDER is unset the function auto-detects based on available keys:
 *   GEMINI_API_KEY → gemini
 *   EMBEDDING_API_KEY → openai-compatible
 *   else → python-sidecar → deterministic
 */
export function getEmbeddingProvider(): EmbeddingProvider {
  const explicit = (process.env.EMBEDDING_PROVIDER || "").toLowerCase();

  // --- Explicit selection ---
  if (["openai", "voyage", "cohere", "rest", "openai-compatible"].includes(explicit)) {
    return new OpenAICompatibleEmbeddingProvider();
  }
  if (["local", "python", "python-sidecar", "sentence-transformers"].includes(explicit)) {
    return new PythonSidecarEmbeddingProvider();
  }
  if (explicit === "deterministic") {
    return new DeterministicEmbeddingProvider();
  }
  if (explicit === "gemini") {
    return new GeminiEmbeddingProvider();
  }

  // --- Auto-detect from available keys ---
  if (process.env.GEMINI_API_KEY) return new GeminiEmbeddingProvider();
  if (process.env.EMBEDDING_API_KEY || process.env.OPENAI_API_KEY) return new OpenAICompatibleEmbeddingProvider();

  // --- Try Python sidecar, then deterministic ---
  return new PythonSidecarEmbeddingProvider();
}

export function fallbackEmbeddingProvider(): EmbeddingProvider {
  return new DeterministicEmbeddingProvider();
}