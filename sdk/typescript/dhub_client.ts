/**
 * TypeScript SDK Client for Clean Data Hub Enterprise API.
 */
export class DHubClient {
  private baseUrl: string;
  private token: string | null = null;

  constructor(baseUrl: string = "http://localhost:3000") {
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  /**
   * Set Bearer authorization token
   */
  public setToken(token: string): void {
    this.token = token;
  }

  /**
   * Authenticate local user credentials and store JWT token.
   */
  public async authenticate(email: string, password: string): Promise<any> {
    const res = await fetch(`${this.baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    
    if (!res.ok) {
      throw new Error(`Authentication failed with status ${res.status}`);
    }

    const data = await res.json();
    this.token = data.token;
    return data;
  }

  private getHeaders(): HeadersInit {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.token) {
      headers["Authorization"] = `Bearer ${this.token}`;
    }
    return headers;
  }

  /**
   * Ingest raw text document into pipeline database
   */
  public async uploadDocument(name: string, content: string, type: "PDF" | "DOCX" | "XLSX" | "TXT" = "TXT", connector: string = "SDK Upload"): Promise<any> {
    const res = await fetch(`${this.baseUrl}/api/documents`, {
      method: "POST",
      headers: this.getHeaders(),
      body: JSON.stringify({ name, rawContent: content, type, connector }),
    });

    if (!res.ok) {
      throw new Error(`Document upload failed with status ${res.status}`);
    }
    return res.json();
  }

  /**
   * Fetch specific document record details
   */
  public async getDocument(docId: string): Promise<any> {
    const res = await fetch(`${this.baseUrl}/api/documents/${docId}`, {
      headers: this.getHeaders(),
    });

    if (!res.ok) {
      throw new Error(`Fetching document failed with status ${res.status}`);
    }
    return res.json();
  }

  /**
   * Trigger async pipeline refinery process
   */
  public async triggerRefinement(docId: string): Promise<any> {
    const res = await fetch(`${this.baseUrl}/api/documents/${docId}/refine`, {
      method: "POST",
      headers: this.getHeaders(),
    });

    if (!res.ok) {
      throw new Error(`Triggering refinement failed with status ${res.status}`);
    }
    return res.json();
  }

  /**
   * Poll refinement state until complete
   */
  public async pollRefinement(docId: string, timeoutMs: number = 60000, intervalMs: number = 2000): Promise<any> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const doc = await this.getDocument(docId);
      if (doc.status === "refined" || doc.status === "failed") {
        return doc;
      }
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    throw new Error(`Polling document ${docId} timed out after ${timeoutMs / 1000}s`);
  }

  /**
   * Retrieve stats
   */
  public async getStats(): Promise<any> {
    const res = await fetch(`${this.baseUrl}/api/stats`, {
      headers: this.getHeaders(),
    });

    if (!res.ok) {
      throw new Error(`Fetching statistics failed with status ${res.status}`);
    }
    return res.json();
  }

  /**
   * Upgrade plan
   */
  public async upgradePlan(): Promise<any> {
    const res = await fetch(`${this.baseUrl}/api/billing/upgrade`, {
      method: "POST",
      headers: this.getHeaders(),
    });

    if (!res.ok) {
      throw new Error(`Upgrading plan failed with status ${res.status}`);
    }
    return res.json();
  }
}
