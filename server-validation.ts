import { Request, Response, NextFunction } from "express";

export interface ApiError extends Error {
  statusCode?: number;
  details?: any;
}

// Custom error handler
export class ValidationError extends Error implements ApiError {
  statusCode = 400;
  details: any;

  constructor(message: string, details?: any) {
    super(message);
    this.details = details;
  }
}

export class AuthenticationError extends Error implements ApiError {
  statusCode = 401;
  details: any;

  constructor(message: string, details?: any) {
    super(message);
    this.details = details;
  }
}

export class AuthorizationError extends Error implements ApiError {
  statusCode = 403;
  details: any;

  constructor(message: string, details?: any) {
    super(message);
    this.details = details;
  }
}

export class NotFoundError extends Error implements ApiError {
  statusCode = 404;
  details: any;

  constructor(message: string, details?: any) {
    super(message);
    this.details = details;
  }
}

export class InternalServerError extends Error implements ApiError {
  statusCode = 500;
  details: any;

  constructor(message: string, details?: any) {
    super(message);
    this.details = details;
  }
}

// Validation schemas
export const validateDocumentInput = (data: any) => {
  const errors: string[] = [];

  if (!data.name || typeof data.name !== "string" || data.name.trim().length === 0) {
    errors.push("Document name is required and must be a non-empty string");
  } else if (data.name.length > 255) {
    errors.push("Document name must be 255 characters or less");
  }

  if (!data.rawContent || typeof data.rawContent !== "string") {
    errors.push("Raw content is required and must be a string");
  } else if (data.rawContent.length > 50 * 1024 * 1024) {
    errors.push("Document size exceeds 50MB limit");
  }

  if (data.type && !["PDF", "DOCX", "XLSX", "PPTX", "TXT"].includes(data.type)) {
    errors.push("Invalid document type. Must be one of: PDF, DOCX, XLSX, PPTX, TXT");
  }

  if (data.connector && typeof data.connector !== "string") {
    errors.push("Connector must be a string");
  }

  if (errors.length > 0) {
    throw new ValidationError("Document validation failed", { errors });
  }
};

export const validateConnectorInput = (data: any) => {
  const errors: string[] = [];

  if (!data.name || typeof data.name !== "string") {
    errors.push("Connector name is required");
  }

  if (!data.type || !["Google Drive", "GitHub", "Notion", "SharePoint", "Confluence", "S3"].includes(data.type)) {
    errors.push("Invalid connector type");
  }

  if (data.credentials) {
    if (!data.credentials.oauthToken && !data.credentials.clientId) {
      errors.push("Credentials must include either oauthToken or clientId");
    }
  }

  if (errors.length > 0) {
    throw new ValidationError("Connector validation failed", { errors });
  }
};

export const validateVectorDbInput = (data: any) => {
  const errors: string[] = [];

  if (!data.name || typeof data.name !== "string") {
    errors.push("Vector DB name is required");
  }

  if (!data.embeddingModel || typeof data.embeddingModel !== "string") {
    errors.push("Embedding model is required");
  }

  if (data.credentials) {
    if (!data.credentials.endpoint || !data.credentials.apiKey) {
      errors.push("Credentials must include both endpoint and apiKey");
    }
  }

  if (errors.length > 0) {
    throw new ValidationError("Vector DB validation failed", { errors });
  }
};

// Error handling middleware
export function errorHandler(
  err: any,
  req: Request,
  res: Response,
  next: NextFunction
) {
  console.error("Error:", err);

  const statusCode = err.statusCode || 500;
  const message = err.message || "Internal server error";
  const details = err.details || null;

  res.status(statusCode).json({
    error: message,
    details,
    timestamp: new Date().toISOString(),
    path: req.path,
  });
}

// Async handler wrapper to catch errors in route handlers
export function asyncHandler(fn: Function) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}
