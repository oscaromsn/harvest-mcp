import { z } from "zod";

// ========== Authentication Types ==========

/**
 * Supported authentication types
 */
export type AuthenticationType =
  | "bearer_token"
  | "api_key"
  | "basic_auth"
  | "session_cookie"
  | "oauth"
  | "custom_header"
  | "url_parameter"
  | "none";

/**
 * Authentication requirement levels
 */
export type AuthenticationRequirement = "required" | "optional" | "none";

/**
 * Token lifecycle information
 */
export interface TokenLifecycle {
  isStatic: boolean;
  expiresIn?: number;
  refreshEndpoint?: string;
  refreshMethod?: string;
  generationEndpoint?: string;
  generationMethod?: string;
  expirationPattern?: string;
}

/**
 * Authentication endpoint information
 */
export interface AuthenticationEndpoint {
  url: string;
  method: string;
  purpose: "login" | "refresh" | "logout" | "validate";
  request?: RequestModel;
  responseContainsToken?: boolean;
}

/**
 * Individual request authentication analysis
 */
export interface RequestAuthenticationInfo {
  requestId: string;
  url: string;
  method: string;
  authenticationType: AuthenticationType;
  requirement: AuthenticationRequirement;
  tokens: TokenInfo[];
  authHeaders: Record<string, string>;
  authCookies: Record<string, string>;
  authParams: Record<string, string>;
  isAuthFailure: boolean;
  authErrorDetails?: {
    status: number;
    statusText: string;
    wwwAuthenticate?: string;
    errorMessage?: string;
  };
}

/**
 * Token information extracted from requests
 */
export interface TokenInfo {
  type: "bearer" | "api_key" | "session" | "csrf" | "custom";
  location: "header" | "cookie" | "url_param" | "body";
  name: string;
  value: string;
  isExpired?: boolean;
  expiresAt?: Date;
  scope?: string[];
}

/**
 * Comprehensive authentication analysis result
 */
export interface AuthenticationAnalysis {
  // Overall authentication summary
  hasAuthentication: boolean;
  primaryAuthType: AuthenticationType;
  authTypes: AuthenticationType[];

  // Request-level analysis
  authenticatedRequests: RequestAuthenticationInfo[];
  unauthenticatedRequests: RequestAuthenticationInfo[];
  failedAuthRequests: RequestAuthenticationInfo[];

  // Token analysis
  tokens: TokenInfo[];
  tokenLifecycle: TokenLifecycle;

  // Authentication flow
  authEndpoints: AuthenticationEndpoint[];
  authFlow: {
    hasLoginFlow: boolean;
    hasRefreshFlow: boolean;
    hasLogoutFlow: boolean;
    flowComplexity: "simple" | "moderate" | "complex";
  };

  // Security concerns
  securityIssues: string[];
  recommendations: string[];

  // Code generation readiness
  codeGeneration: {
    isReady: boolean;
    requiredSetup: string[];
    supportedPatterns: string[];
    hardcodedTokens: string[];
    dynamicTokens: string[];
  };
}

// ========== Parameter Classification Types ==========

/**
 * Parameter classification types for enhanced analysis
 */
export type ParameterClassification =
  | "dynamic" // Resolved from previous API response
  | "sessionConstant" // Session-scoped constant that must be dynamically fetched during bootstrap
  | "staticConstant" // Hardcoded application constant that remains the same across all sessions
  | "userInput" // User-provided parameter (search terms, IDs)
  | "optional"; // Can be omitted without breaking functionality

// ========== Bootstrap Parameter Types ==========

/**
 * Types of sources where bootstrap parameters can be found
 */
export type BootstrapSourceType =
  | "initial-page-html"
  | "initial-page-cookie"
  | "dedicated-auth-request";

/**
 * Source information for session bootstrap parameters
 */
export interface BootstrapParameterSource {
  type: BootstrapSourceType;
  // The URL of the request that provides the bootstrap parameter.
  sourceUrl: string;
  // Details on how to extract the value.
  extractionDetails: {
    // e.g., for 'initial-page-html', this could be a regex or CSS selector.
    pattern: string;
    // e.g., for 'initial-page-cookie', this is the cookie name.
    cookieName?: string;
    // e.g., for 'dedicated-auth-request', this is the JSON path.
    jsonPath?: string;
    // Indicates this is a synthetic source for testing/mid-session HAR captures
    syntheticSource?: boolean;
  };
}

/**
 * Classified parameter with metadata for analysis
 */
export interface ClassifiedParameter {
  name: string;
  value: string;
  classification: ParameterClassification;
  confidence: number;
  source: "heuristic" | "llm" | "manual" | "consistency_analysis";
  metadata: {
    occurrenceCount: number;
    totalRequests: number;
    consistencyScore: number; // 0-1, how consistent across requests
    parameterPattern: string; // regex pattern if detected
    domainContext?: string; // session, auth, pagination, etc.
    bootstrapSource?: BootstrapParameterSource; // Source for session bootstrap parameters
    requiresBootstrap?: boolean; // Whether this parameter requires bootstrap initialization
  };
}

/**
 * Parameter diagnostic information for error reporting
 */
export interface ParameterDiagnostic {
  parameter: string;
  classification: ParameterClassification;
  issue: string;
  possibleSources: string[];
  recommendedAction: string;
  debugCommand?: string;
}

/**
 * Enhanced error context for parameter-related issues
 */
export interface ParameterErrorContext {
  sessionId: string;
  unresolvedNodes: Array<{
    nodeId: string;
    parameters: ClassifiedParameter[];
  }>;
  recommendations: string[];
  debugCommands: string[];
  parameterAnalysis: ParameterDiagnostic[];
}

// ========== Core Session Types ==========

export interface HarvestSession {
  id: string;
  prompt: string;
  harData: ParsedHARData;
  cookieData?: CookieData;
  dagManager: DAGManager;
  state: SessionState;
  createdAt: Date;
  lastActivity: Date;
}

export interface SessionState {
  actionUrl?: string;
  masterNodeId?: string;
  inProcessNodeId?: string;
  toBeProcessedNodes: string[];
  inProcessNodeDynamicParts: string[];
  inputVariables: Record<string, string>;
  isComplete: boolean;
  logs: LogEntry[];
  generatedCode?: string;
  authAnalysis?: AuthenticationAnalysis;
  authReadiness?: {
    isAuthComplete: boolean;
    authBlockers: string[];
    authRecommendations: string[];
  };
  bootstrapAnalysis?: {
    isNeeded: boolean;
    bootstrapUrl?: string; // The main page URL that starts the session
    parameters: Array<{ name: string; source: BootstrapParameterSource }>;
  };
}

export interface LogEntry {
  timestamp: Date;
  level: "info" | "debug" | "error" | "warn";
  message: string;
  data?: unknown;
}

export interface SessionInfo {
  id: string;
  prompt: string;
  createdAt: Date;
  lastActivity: Date;
  isComplete: boolean;
  nodeCount: number;
  hasAuthentication?: boolean;
  authTypes?: AuthenticationType[];
  authReadiness?: boolean;
}

// ========== DAG Types ==========

export type NodeType =
  | "cookie"
  | "master"
  | "master_curl"
  | "curl"
  | "not_found";

// Base content interfaces
export interface RequestNodeContent {
  key: RequestModel;
  value?: ResponseData | null;
}

/**
 * Authentication-specific node content for auth flows
 */
export interface AuthNodeContent {
  key: string;
  value: TokenInfo | AuthenticationEndpoint;
  authType: AuthenticationType;
}

export interface CookieNodeContent {
  key: string;
  value: string;
}

export interface NotFoundNodeContent {
  key: string;
}

// Discriminated union for DAG nodes
export interface CurlDAGNode {
  id: string;
  nodeType: "curl";
  content: RequestNodeContent;
  dynamicParts?: string[];
  extractedParts?: string[];
  inputVariables?: Record<string, string>;
  authInfo?: RequestAuthenticationInfo;
  classifiedParameters?: ClassifiedParameter[];
  bootstrapSource?: BootstrapParameterSource;
}

export interface CookieDAGNode {
  id: string;
  nodeType: "cookie";
  content: CookieNodeContent;
  dynamicParts?: string[];
  extractedParts?: string[];
  inputVariables?: Record<string, string>;
  classifiedParameters?: ClassifiedParameter[];
  bootstrapSource?: BootstrapParameterSource;
}

export interface NotFoundDAGNode {
  id: string;
  nodeType: "not_found";
  content: NotFoundNodeContent;
  dynamicParts?: string[];
  extractedParts?: string[];
  inputVariables?: Record<string, string>;
  classifiedParameters?: ClassifiedParameter[];
  bootstrapSource?: BootstrapParameterSource;
}

export interface MasterDAGNode {
  id: string;
  nodeType: "master";
  content: RequestNodeContent;
  dynamicParts?: string[];
  extractedParts?: string[];
  inputVariables?: Record<string, string>;
  authInfo?: RequestAuthenticationInfo;
  classifiedParameters?: ClassifiedParameter[];
  bootstrapSource?: BootstrapParameterSource;
}

export interface MasterCurlDAGNode {
  id: string;
  nodeType: "master_curl";
  content: RequestNodeContent;
  dynamicParts?: string[];
  extractedParts?: string[];
  inputVariables?: Record<string, string>;
  authInfo?: RequestAuthenticationInfo;
  classifiedParameters?: ClassifiedParameter[];
  bootstrapSource?: BootstrapParameterSource;
}

export type DAGNode =
  | CurlDAGNode
  | CookieDAGNode
  | NotFoundDAGNode
  | MasterDAGNode
  | MasterCurlDAGNode;

export interface DAGManager {
  addNode(
    nodeType: NodeType,
    content: RequestNodeContent | CookieNodeContent | NotFoundNodeContent,
    attributes?: Partial<DAGNode>
  ): string;
  updateNode(nodeId: string, attributes: Partial<DAGNode>): void;
  getNode(nodeId: string): DAGNode | undefined;
  addEdge(fromId: string, toId: string): void;
  detectCycles(): string[][] | null;
  getNodeCount(): number;
  getAllNodes(): Map<string, DAGNode>;
  toJSON(): DAGExport;
  topologicalSort(): string[];
  getPredecessors(nodeId: string): string[];
  getSuccessors(nodeId: string): string[];
  isComplete(): boolean;
  getUnresolvedNodes(): Array<{ nodeId: string; unresolvedParts: string[] }>;
  findNodeByRequest(request: RequestModel): string | null;
}

export interface DAGExport {
  nodes: Array<DAGNode & { id: string }>;
  edges: Array<{ from: string; to: string }>;
  nodeCount: number;
  edgeCount: number;
}

// ========== LLM Response Types ==========

/**
 * Response from URL identification function call
 */
export interface URLIdentificationResponse {
  url: string;
}

/**
 * Response from dynamic parts identification function call
 */
export interface DynamicPartsResponse {
  dynamic_parts: string[];
}

/**
 * Input variable item in LLM response
 */
export interface InputVariableItem {
  variable_name: string;
  variable_value: string;
}

/**
 * Response from input variables identification function call
 */
export interface InputVariablesResponse {
  identified_variables: InputVariableItem[];
}

/**
 * Result of input variable identification process
 */
export interface InputVariablesResult {
  identifiedVariables: Record<string, string>;
  removedDynamicParts: string[];
}

/**
 * LLM response for simplest request selection
 */
export interface SimplestRequestResponse {
  index: number;
}

/**
 * Cookie dependency found for a dynamic part
 */
export interface CookieDependency {
  type: "cookie";
  cookieKey: string;
  dynamicPart: string;
}

/**
 * Request dependency found for a dynamic part
 */
export interface RequestDependency {
  type: "request";
  sourceRequest: RequestModel;
  dynamicPart: string;
}

/**
 * Result of dependency finding process
 */
export interface DependencyResult {
  cookieDependencies: CookieDependency[];
  requestDependencies: RequestDependency[];
  notFoundParts: string[];
}

/**
 * Result of cookie dependency search
 */
export interface CookieSearchResult {
  found: CookieDependency[];
  remaining: string[];
}

/**
 * Analysis result for MCP tools
 */
export interface AnalysisResult {
  nodeId: string;
  status:
    | "completed"
    | "needs_input"
    | "failed"
    | "skipped_javascript"
    | "no_nodes_to_process";
  dynamicPartsFound?: number;
  inputVariablesFound?: number;
  finalDynamicParts?: number;
  newNodesAdded?: number;
  remainingNodes?: number;
  totalNodes?: number;
  nextStep?: string;
  message: string;
}

/**
 * Completion status result for MCP tools
 */
export interface CompletionStatusResult {
  isComplete: boolean;
  status: "complete" | "processing" | "needs_intervention" | "unknown";
  nodeCount: number;
  unresolvedNodesCount: number;
  unresolvedNodes: Array<{
    nodeId: string;
    unresolvedParts: string[];
    nodeType?: NodeType;
  }>;
  remainingToProcess: number;
  nextStep: string;
  message: string;
}

/**
 * Session start response with optional warnings and recommendations
 */
export interface SessionStartResponse {
  sessionId: string;
  message: string;
  harPath: string;
  prompt: string;
  harValidation?: HarValidationResult | undefined;
  warning?: string;
  recommendations?: string[];
}

/**
 * Standard cleanup result from ManualSessionManager
 */
export interface StandardCleanupResult {
  gcForced: boolean;
  memoryBefore: number;
  memoryAfter: number;
  memoryReclaimed: number;
  activeSessions: number;
  cleanupActions: string[];
}

/**
 * Aggressive cleanup result from ManualSessionManager
 */
export interface AggressiveCleanupResult {
  sessionsClosed: number;
  memoryReclaimed: number;
  errors: string[];
}

/**
 * Union type for cleanup results
 */
export type CleanupResult = StandardCleanupResult | AggressiveCleanupResult;

/**
 * HAR validation result
 */
export interface HarValidationResult {
  quality: "excellent" | "good" | "poor" | "empty";
  stats: {
    totalEntries: number;
    relevantEntries: number;
    apiRequests: number;
    postRequests: number;
    responsesWithContent: number;
  };
  isValid: boolean;
  issues?: string[];
  recommendations?: string[];
}

// ========== HAR Data Types ==========

export interface ParsedHARData {
  requests: RequestModel[];
  urls: URLInfo[];
  validation?: {
    isValid: boolean;
    quality: "excellent" | "good" | "poor" | "empty";
    issues: string[];
    recommendations: string[];
    stats: {
      totalEntries: number;
      relevantEntries: number;
      apiRequests: number;
      postRequests: number;
      responsesWithContent: number;
      authRequests: number;
      tokenRequests: number;
      authErrors: number;
    };
    authAnalysis: {
      hasAuthHeaders: boolean;
      hasCookies: boolean;
      hasTokens: boolean;
      authErrors: number;
      tokenPatterns: string[];
      authTypes: string[];
      issues: string[];
      recommendations: string[];
    };
  };
  authAnalysis?: AuthenticationAnalysis;
}

export interface URLInfo {
  method: string;
  url: string;
  requestType: string;
  responseType: string;
}

export interface RequestModel {
  method: string;
  url: string;
  headers: Record<string, string>;
  queryParams?: Record<string, string>;
  body?: unknown;
  response?: ResponseData;
  timestamp?: Date;
  toCurlCommand(): string;
}

export interface ResponseData {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  text?: string;
  json?: unknown;
}

// ========== Cookie Data Types ==========

export interface CookieData {
  [cookieName: string]: {
    value: string;
    domain?: string;
    path?: string;
    secure?: boolean;
    httpOnly?: boolean;
  };
}

// ========== Dependency Analysis Types ==========

export interface DependencyFindingResult {
  type: "cookie" | "request";
  source: string | RequestModel;
  part: string;
}

// ========== Zod Schemas for Validation ==========

export const SessionStartSchema = z.object({
  harPath: z.string().min(1, "HAR file path is required"),
  cookiePath: z.string().optional(),
  prompt: z.string().min(1, "Prompt is required"),
  inputVariables: z.record(z.string()).optional(),
  harParsingOptions: z
    .object({
      excludeKeywords: z.array(z.string()).optional(),
      includeAllApiRequests: z.boolean().optional(),
      minQualityThreshold: z.enum(["excellent", "good", "poor"]).optional(),
      preserveAnalyticsRequests: z.boolean().optional(),
      customFilters: z.array(z.function()).optional(),
    })
    .optional(),
});

export const SessionIdSchema = z.object({
  sessionId: z.string().uuid("Invalid session ID format"),
});

export const DebugForceDependencySchema = z.object({
  sessionId: z.string().uuid(),
  consumerNodeId: z.string().uuid(),
  providerNodeId: z.string().uuid(),
  providedPart: z.string().min(1),
});

export const DebugGetNodeDetailsSchema = z.object({
  sessionId: z.string().uuid(),
  nodeId: z.string().uuid(),
});

// ========== Manual Session Schemas ==========

export const ManualSessionStartSchema = z.object({
  sessionId: z
    .string()
    .uuid("Session ID must be a valid UUID if provided")
    .optional()
    .describe("Custom session identifier (auto-generated if not provided)"),
  url: z
    .string()
    .url("URL must be a valid HTTP/HTTPS URL")
    .optional()
    .transform((val) => {
      // Sanitize URL by ensuring it has a protocol
      if (val && !val.startsWith("http://") && !val.startsWith("https://")) {
        return `https://${val}`;
      }
      return val;
    })
    .describe("Starting URL for the browser session"),
  config: z
    .object({
      timeout: z
        .number()
        .min(1, "Timeout must be at least 1 minute")
        .max(1440, "Timeout cannot exceed 24 hours (1440 minutes)")
        .optional()
        .describe("Auto-cleanup timeout in minutes (1-1440, 0 = no timeout)"),
      browserOptions: z
        .object({
          headless: z
            .boolean()
            .optional()
            .describe(
              "Run browser in headless mode (default: false for manual interaction)"
            ),
          viewport: z
            .object({
              width: z
                .number()
                .min(320, "Viewport width must be at least 320px")
                .max(7680, "Viewport width cannot exceed 7680px")
                .optional()
                .describe("Browser viewport width (320-7680px)"),
              height: z
                .number()
                .min(240, "Viewport height must be at least 240px")
                .max(4320, "Viewport height cannot exceed 4320px")
                .optional()
                .describe("Browser viewport height (240-4320px)"),
            })
            .optional()
            .describe("Browser viewport configuration"),
          contextOptions: z
            .object({
              deviceScaleFactor: z
                .number()
                .min(0.25, "Device scale factor must be at least 0.25")
                .max(4, "Device scale factor cannot exceed 4")
                .optional()
                .describe(
                  "Device scale factor for coordinate accuracy (0.25-4)"
                ),
            })
            .optional()
            .describe("Browser context options"),
        })
        .optional()
        .describe("Browser configuration options"),
      artifactConfig: z
        .object({
          enabled: z
            .boolean()
            .optional()
            .describe("Enable artifact collection (default: true)"),
          outputDir: z
            .string()
            .min(1, "Output directory path cannot be empty")
            .refine(
              (path) => !path.includes(".."),
              "Output directory path cannot contain '..' for security"
            )
            .optional()
            .describe(
              "Custom output directory for artifacts (relative or absolute path)"
            ),
          saveHar: z
            .boolean()
            .optional()
            .describe("Save HAR files (default: true)"),
          saveCookies: z
            .boolean()
            .optional()
            .describe("Save cookies (default: true)"),
          saveScreenshots: z
            .boolean()
            .optional()
            .describe("Save screenshots (default: true)"),
          autoScreenshotInterval: z
            .number()
            .min(1, "Auto-screenshot interval must be at least 1 second")
            .max(
              3600,
              "Auto-screenshot interval cannot exceed 1 hour (3600 seconds)"
            )
            .optional()
            .describe(
              "Take screenshots automatically every N seconds (1-3600, 0 = disabled)"
            ),
        })
        .optional()
        .describe("Configuration for artifact collection during the session"),
    })
    .optional()
    .describe("Session configuration options"),
});

export const ManualSessionStopSchema = z.object({
  sessionId: z
    .string()
    .uuid("Session ID must be a valid UUID")
    .describe("ID of the session to stop"),
  artifactTypes: z
    .array(z.enum(["har", "cookies", "screenshot"]))
    .min(1, "At least one artifact type must be specified if provided")
    .optional()
    .describe(
      "Specific types of artifacts to collect (default: all enabled types)"
    ),
  takeScreenshot: z
    .boolean()
    .optional()
    .describe(
      "Take a final screenshot before stopping (default: true if screenshots enabled)"
    ),
  reason: z
    .string()
    .min(1, "Reason cannot be empty if provided")
    .max(200, "Reason cannot exceed 200 characters")
    .optional()
    .describe("Reason for stopping the session (for logging purposes)"),
});

// ========== Type Exports ==========

export type SessionStartParams = z.infer<typeof SessionStartSchema>;
export type SessionIdParams = z.infer<typeof SessionIdSchema>;
export type DebugForceDependencyParams = z.infer<
  typeof DebugForceDependencySchema
>;
export type DebugGetNodeDetailsParams = z.infer<
  typeof DebugGetNodeDetailsSchema
>;
export type ManualSessionStartParams = z.infer<typeof ManualSessionStartSchema>;
export type ManualSessionStopParams = z.infer<typeof ManualSessionStopSchema>;

// ========== Error Types ==========

export class HarvestError extends Error {
  public code: string;
  public data?: unknown;

  constructor(message: string, code = "HARVEST_ERROR", data?: unknown) {
    super(message);
    this.name = "HarvestError";
    this.code = code;
    this.data = data;
  }
}

export class SessionNotFoundError extends HarvestError {
  constructor(sessionId: string) {
    super(`Session ${sessionId} not found`, "SESSION_NOT_FOUND", { sessionId });
  }
}

export class NodeNotFoundError extends HarvestError {
  constructor(nodeId: string) {
    super(`Node ${nodeId} not found`, "NODE_NOT_FOUND", { nodeId });
  }
}

export class AnalysisNotCompleteError extends HarvestError {
  constructor(sessionId: string) {
    super(
      `Analysis for session ${sessionId} is not complete`,
      "ANALYSIS_NOT_COMPLETE",
      {
        sessionId,
      }
    );
  }
}

// ========== Browser Types Export ==========

export type {
  ActiveBrowser,
  Artifact,
  ArtifactCollection,
  BrowserAgent,
  BrowserAgentConfig,
  BrowserConnectorOptions,
  BrowserEngine,
  BrowserOptions,
  BrowserSessionInfo,
  FallbackConfig,
  ManualBrowserAgent,
  ManualSession,
  SessionConfig,
  SessionStopResult,
} from "../browser/types.js";
