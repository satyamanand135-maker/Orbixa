import { DocumentRecord } from "./src/types";
import { Parser } from "json2csv";

// Batch Operations
export async function batchRefineDocuments(
  documentIds: string[],
  refineFunction: (docId: string) => Promise<any>
): Promise<{ succeeded: string[]; failed: { id: string; error: string }[] }> {
  const results = {
    succeeded: [] as string[],
    failed: [] as { id: string; error: string }[],
  };

  // Process in parallel with concurrency limit
  const concurrencyLimit = 3;
  for (let i = 0; i < documentIds.length; i += concurrencyLimit) {
    const batch = documentIds.slice(i, i + concurrencyLimit);

    const promises = batch.map(async (docId) => {
      try {
        await refineFunction(docId);
        results.succeeded.push(docId);
      } catch (error) {
        results.failed.push({
          id: docId,
          error: error instanceof Error ? error.message : "Unknown error",
        });
      }
    });

    await Promise.all(promises);
  }

  return results;
}

export async function batchDeleteDocuments(
  documentIds: string[],
  deleteFunction: (docId: string) => Promise<void>
): Promise<{ succeeded: string[]; failed: { id: string; error: string }[] }> {
  const results = {
    succeeded: [] as string[],
    failed: [] as { id: string; error: string }[],
  };

  for (const docId of documentIds) {
    try {
      await deleteFunction(docId);
      results.succeeded.push(docId);
    } catch (error) {
      results.failed.push({
        id: docId,
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }

  return results;
}

// Export Formats
export function exportToJSON(documents: DocumentRecord[]): string {
  return JSON.stringify(
    documents.map((doc) => ({
      id: doc.id,
      name: doc.name,
      type: doc.type,
      size: doc.size,
      connector: doc.connector,
      status: doc.status,
      metadata: doc.metadata,
      piiFindingsCount: doc.piiFindingsCount,
      readinessScore: doc.readinessScore,
      createdAt: doc.createdAt,
    })),
    null,
    2
  );
}

export function exportToCSV(documents: DocumentRecord[]): string {
  const fields = [
    "id",
    "name",
    "type",
    "size",
    "connector",
    "status",
    "category",
    "classification",
    "accessLevel",
    "piiFindingsCount",
    "readinessScore",
    "createdAt",
  ];

  const data = documents.map((doc) => ({
    id: doc.id,
    name: doc.name,
    type: doc.type,
    size: doc.size,
    connector: doc.connector,
    status: doc.status,
    category: doc.metadata?.category || "N/A",
    classification: doc.metadata?.classification || "N/A",
    accessLevel: doc.metadata?.accessLevel || "N/A",
    piiFindingsCount: doc.piiFindingsCount,
    readinessScore: doc.readinessScore?.score || "N/A",
    createdAt: doc.createdAt,
  }));

  try {
    const parser = new Parser({ fields });
    return parser.parse(data);
  } catch (error) {
    console.error("CSV export failed:", error);
    throw error;
  }
}

export function exportMarkdownReport(documents: DocumentRecord[]): string {
  let markdown = "# Data Refinery Report\n\n";
  markdown += `Generated: ${new Date().toISOString()}\n\n`;

  markdown += "## Summary\n\n";
  markdown += `- **Total Documents:** ${documents.length}\n`;
  markdown += `- **Refined:** ${documents.filter((d) => d.status === "refined").length}\n`;
  markdown += `- **Raw:** ${documents.filter((d) => d.status === "raw").length}\n`;
  markdown += `- **Failed:** ${documents.filter((d) => d.status === "failed").length}\n\n`;

  markdown += "## Document Details\n\n";

  documents.forEach((doc) => {
    markdown += `### ${doc.name}\n\n`;
    markdown += `- **Status:** ${doc.status}\n`;
    markdown += `- **Type:** ${doc.type}\n`;
    markdown += `- **Size:** ${doc.size}\n`;
    markdown += `- **Connector:** ${doc.connector}\n`;

    if (doc.metadata) {
      markdown += `- **Category:** ${doc.metadata.category}\n`;
      markdown += `- **Classification:** ${doc.metadata.classification}\n`;
      markdown += `- **Access Level:** ${doc.metadata.accessLevel}\n`;
      markdown += `- **Summary:** ${doc.metadata.summary}\n`;
    }

    if (doc.readinessScore) {
      markdown += `- **Readiness Score:** ${doc.readinessScore.score}%\n`;
      markdown += `  - Layout: ${doc.readinessScore.layoutScore}%\n`;
      markdown += `  - Security: ${doc.readinessScore.securityScore}%\n`;
      markdown += `  - Hygiene: ${doc.readinessScore.hygieneScore}%\n`;
      markdown += `  - Metadata: ${doc.readinessScore.metadataScore}%\n`;
    }

    if (doc.piiFindingsCount > 0) {
      markdown += `- **PII Findings:** ${doc.piiFindingsCount}\n`;
      markdown += "  - Types: ";
      markdown += doc.piiFindings.map((f) => f.type).join(", ");
      markdown += "\n";
    }

    markdown += "\n";
  });

  return markdown;
}

// Scheduled Sync Interface
export interface SyncSchedule {
  connectorId: string;
  frequency: "2h" | "4h" | "6h" | "12h" | "daily" | "manual";
  nextSync: Date;
  isActive: boolean;
}

export function parseFrequencyToMs(frequency: string): number {
  const frequencies: { [key: string]: number } = {
    "2h": 2 * 60 * 60 * 1000,
    "4h": 4 * 60 * 60 * 1000,
    "6h": 6 * 60 * 60 * 1000,
    "12h": 12 * 60 * 60 * 1000,
    daily: 24 * 60 * 60 * 1000,
  };
  return frequencies[frequency] || 0;
}

export function getNextSyncTime(frequency: string): Date {
  const now = new Date();
  const ms = parseFrequencyToMs(frequency);
  if (ms === 0) return new Date(0); // manual sync has no next time
  return new Date(now.getTime() + ms);
}

// Document filtering and search
export function filterDocuments(
  documents: DocumentRecord[],
  filters: {
    status?: string;
    connector?: string;
    category?: string;
    classification?: string;
    minReadinessScore?: number;
    search?: string;
  }
): DocumentRecord[] {
  return documents.filter((doc) => {
    if (filters.status && doc.status !== filters.status) return false;
    if (filters.connector && doc.connector !== filters.connector) return false;
    if (filters.category && doc.metadata?.category !== filters.category) return false;
    if (filters.classification && doc.metadata?.classification !== filters.classification)
      return false;
    if (
      filters.minReadinessScore &&
      (!doc.readinessScore || doc.readinessScore.score < filters.minReadinessScore)
    )
      return false;
    if (filters.search) {
      const query = filters.search.toLowerCase();
      return (
        doc.name.toLowerCase().includes(query) ||
        doc.metadata?.title?.toLowerCase().includes(query) ||
        doc.metadata?.summary?.toLowerCase().includes(query)
      );
    }
    return true;
  });
}

// Sort documents
export function sortDocuments(
  documents: DocumentRecord[],
  sortBy: "name" | "createdAt" | "readinessScore",
  order: "asc" | "desc" = "asc"
): DocumentRecord[] {
  const sorted = [...documents].sort((a, b) => {
    let aVal, bVal;

    if (sortBy === "name") {
      aVal = a.name.toLowerCase();
      bVal = b.name.toLowerCase();
    } else if (sortBy === "createdAt") {
      aVal = new Date(a.createdAt).getTime();
      bVal = new Date(b.createdAt).getTime();
    } else if (sortBy === "readinessScore") {
      aVal = a.readinessScore?.score || 0;
      bVal = b.readinessScore?.score || 0;
    }

    if (aVal < bVal) return order === "asc" ? -1 : 1;
    if (aVal > bVal) return order === "asc" ? 1 : -1;
    return 0;
  });

  return sorted;
}
