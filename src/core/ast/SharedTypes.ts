/**
 * Shared Type Definitions for Generated API Clients
 *
 * This module contains common type definitions that are shared across
 * all generated API client files to reduce boilerplate and maintain consistency.
 */

/**
 * Standard API response structure
 * Generic response wrapper that provides consistent structure
 * for all API responses including success status, data, and metadata.
 */
export interface ApiResponse<T = unknown> {
  /** Whether the API call was successful */
  success: boolean;
  /** The response data */
  data: T;
  /** HTTP status code */
  status: number;
  /** Response headers */
  headers: Record<string, string>;
}

/** HTTP request configuration options */
export interface RequestOptions {
  /** HTTP method */
  method: string;
  /** Request headers */
  headers: Record<string, string>;
  /** Request body */
  body?: string;
}

/**
 * Authentication configuration interface
 * Supports multiple authentication methods including Bearer tokens,
 * API keys, basic auth, session cookies, and custom headers.
 */
export interface AuthConfig {
  /** Authentication type */
  type: "bearer" | "api_key" | "basic" | "session" | "custom";
  /** Bearer token */
  token?: string;
  /** API key */
  apiKey?: string;
  /** Username for basic auth */
  username?: string;
  /** Password for basic auth */
  password?: string;
  /** Session cookies */
  sessionCookies?: Record<string, string>;
  /** Custom authentication headers */
  customHeaders?: Record<string, string>;
  /** URL for refreshing tokens */
  tokenRefreshUrl?: string;
  /** Callback for handling token expiration */
  onTokenExpired?: () => Promise<string>;
}

/** Authentication error for retry logic */
export class AuthenticationError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly response?: unknown
  ) {
    super(message);
    this.name = "AuthenticationError";
  }
}

/** Network request error with contextual information */
export class NetworkRequestError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly url: string,
    public readonly method: string,
    public readonly headers?: Record<string, string>,
    public readonly body?: string,
    public readonly response?: unknown
  ) {
    super(message);
    this.name = "NetworkRequestError";
  }

  /** Get a detailed error summary for debugging */
  getDebugInfo(): string {
    return `${this.name}: ${this.message}
URL: ${this.method} ${this.url}
Status: ${this.status}
Headers: ${JSON.stringify(this.headers, null, 2)}
${this.body ? `Body: ${this.body}` : ""}
${this.response ? `Response: ${JSON.stringify(this.response, null, 2)}` : ""}`.trim();
  }
}

/** Workflow execution error with step context */
export class WorkflowExecutionError extends Error {
  constructor(
    message: string,
    public readonly stepName: string,
    public readonly stepType: "cookie" | "auth" | "api_call",
    public readonly status?: number,
    public readonly originalError?: Error
  ) {
    super(message);
    this.name = "WorkflowExecutionError";
  }

  /** Get a detailed error summary for debugging */
  getDebugInfo(): string {
    return `${this.name}: ${this.message}
Step: ${this.stepName} (${this.stepType})
${this.status ? `Status: ${this.status}` : ""}
${this.originalError ? `Original Error: ${this.originalError.message}` : ""}`.trim();
  }
}

/** Cookie management error */
export class CookieError extends Error {
  constructor(
    message: string,
    public readonly cookieName: string,
    public readonly operation: "set" | "get" | "delete",
    public readonly originalError?: Error
  ) {
    super(message);
    this.name = "CookieError";
  }
}

// Note: ApiResponse, RequestOptions, and AuthConfig are already exported as interfaces above
