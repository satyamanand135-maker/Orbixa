export interface RefinedMetadata {
  title: string;
  category: string;
  tags: string[];
  classification: "Public" | "Internal" | "Confidential" | "Highly Sensitive";
  accessLevel: "L1" | "L2" | "L3";
  language: string;
  author: string;
  summary: string;
}

export interface Chunk {
  id: string;
  text: string;
  tokenCount: number;
  headingContext: string;
}

export interface ReadinessScore {
  score: number;
  layoutScore: number;
  securityScore: number;
  hygieneScore: number;
  metadataScore: number;
  warnings: string[];
  recommendations: string[];
}

export interface DocumentRecord {
  _id?: string;
  id: string;
  name: string;
  type: "PDF" | "DOCX" | "XLSX" | "PPTX" | "TXT";
  size: string;
  connector: string;
  status: "raw" | "processing" | "refined" | "failed";
  rawContent: string;
  parsedContent: string;
  cleanedContent: string;
  redactedContent: string;
  metadata: RefinedMetadata | null;
  chunks: Chunk[];
  vectorSync: any;
  readinessScore: ReadinessScore | null;
  piiFindingsCount: number;
  piiFindings: { type: string; value: string }[];
  duplicatesRemoved: number;
  createdAt: string;
}

export type ActiveView = "dashboard" | "refinery" | "connectors" | "vector" | "analytics" | "admin" | "gaps" | "pricing";

export type PipelineStage = "connect" | "parse" | "clean" | "pii" | "meta" | "chunk" | "sync" | "done" | "idle";
