import { getLLMClient } from "../core/LLMClient.js";
import type { FunctionDefinition } from "../core/providers/types.js";
import type {
  HarvestSession,
  ParsedHARData,
  RequestModel,
  URLInfo,
  WorkflowGroup,
} from "../types/index.js";
import { HarvestError } from "../types/index.js";
import { createComponentLogger } from "../utils/logger.js";

const logger = createComponentLogger("workflow-discovery-agent");

/**
 * Response from workflow discovery LLM function call
 */
export interface WorkflowDiscoveryResponse {
  workflows: Array<{
    id: string;
    name: string;
    description: string;
    category: string;
    priority: number;
    complexity: number;
    requiresUserInput: boolean;
    endpoints: Array<{
      url: string;
      method: string;
      role: "primary" | "secondary" | "supporting";
    }>;
  }>;
}

/**
 * Discover and group multiple workflows from HAR data instead of single URL identification
 * This replaces the single-master-action model with multi-workflow analysis
 */
export async function discoverWorkflows(
  session: HarvestSession
): Promise<Map<string, WorkflowGroup>> {
  try {
    logger.info("Starting workflow discovery analysis", {
      sessionId: session.id,
      totalRequests: session.harData.requests.length,
      totalUrls: session.harData.urls.length,
    });

    if (!session.harData.urls || session.harData.urls.length === 0) {
      logger.warn("No URLs found in HAR data for workflow discovery");
      return new Map();
    }

    // Analyze URL patterns and request characteristics
    const urlAnalysis = analyzeUrlPatterns(session.harData.urls);
    const requestAnalysis = analyzeRequestCharacteristics(
      session.harData.requests
    );

    // Try LLM workflow discovery first, fall back to static analysis if it fails
    try {
      const llmClient = getLLMClient();
      const functionDef = createWorkflowDiscoveryFunctionDefinition();
      const prompt = createWorkflowDiscoveryPrompt(
        session.harData,
        urlAnalysis,
        requestAnalysis
      );

      const response = await llmClient.callFunction<WorkflowDiscoveryResponse>(
        prompt,
        functionDef,
        "discover_workflows"
      );

      // Debug: Log all discovered workflows and their primary endpoints
      for (let i = 0; i < response.workflows.length; i++) {
        const workflow = response.workflows[i];
        if (workflow) {
          const primaryEndpoint = workflow.endpoints.find(
            (ep) => ep.role === "primary"
          );
          logger.info(
            `Workflow ${i + 1}: ${workflow.id} - PRIMARY: ${primaryEndpoint?.method || "N/A"} ${primaryEndpoint?.url || "N/A"}`
          );
        }
      }

      // Convert LLM response to WorkflowGroup objects
      const workflowGroups = new Map<string, WorkflowGroup>();

      for (const workflow of response.workflows) {
        // Find the primary endpoint for this workflow
        const primaryEndpoint = workflow.endpoints.find(
          (ep) => ep.role === "primary"
        );
        if (!primaryEndpoint) {
          logger.warn("No primary endpoint found for workflow", {
            workflowId: workflow.id,
          });
          continue;
        }

        // Find corresponding requests for each endpoint
        const workflowRequests = new Set<string>();
        for (const endpoint of workflow.endpoints) {
          const endpointBaseUrl = endpoint.url.split("?")[0];
          if (!endpointBaseUrl) {
            continue;
          }

          const matchingRequests = session.harData.requests.filter((req) => {
            if (
              !req.url ||
              req.method.toUpperCase() !== endpoint.method.toUpperCase()
            ) {
              return false;
            }
            // Extract base URL (without query parameters) for exact matching
            const reqBaseUrl = req.url.split("?")[0];
            return reqBaseUrl === endpointBaseUrl;
          });

          for (const req of matchingRequests) {
            // We'll use request URL as a temporary node ID - this will be replaced
            // when actual DAG nodes are created
            workflowRequests.add(`${req.method.toUpperCase()}:${req.url}`);
          }
        }

        const workflowGroup: WorkflowGroup = {
          id: workflow.id,
          name: workflow.name,
          description: workflow.description,
          category: workflow.category,
          priority: workflow.priority,
          complexity: workflow.complexity,
          requiresUserInput: workflow.requiresUserInput,
          masterNodeId: `${primaryEndpoint.method.toUpperCase()}:${primaryEndpoint.url}`, // Temporary - will be updated when DAG nodes created
          nodeIds: workflowRequests,
        };

        workflowGroups.set(workflow.id, workflowGroup);

        logger.debug("Created workflow group", {
          workflowId: workflow.id,
          name: workflow.name,
          endpointCount: workflow.endpoints.length,
          nodeCount: workflowRequests.size,
        });
      }

      logger.info("Workflow discovery completed via LLM", {
        sessionId: session.id,
        workflowCount: workflowGroups.size,
        workflows: Array.from(workflowGroups.keys()),
      });

      return workflowGroups;
    } catch (llmError) {
      logger.warn(
        "LLM workflow discovery failed, falling back to static analysis",
        {
          sessionId: session.id,
          error: llmError instanceof Error ? llmError.message : "Unknown error",
        }
      );

      // Fallback to static workflow discovery
      return discoverWorkflowsStatically(session, urlAnalysis, requestAnalysis);
    }
  } catch (error) {
    if (error instanceof HarvestError) {
      throw error;
    }

    throw new HarvestError(
      `Workflow discovery failed: ${error instanceof Error ? error.message : "Unknown error"}`,
      "WORKFLOW_DISCOVERY_FAILED",
      {
        sessionId: session.id,
        originalError: error,
      }
    );
  }
}

/**
 * Static workflow discovery that doesn't require LLM calls
 * Used as fallback when LLM services are unavailable (e.g., during testing or API quota issues)
 */
function discoverWorkflowsStatically(
  session: HarvestSession,
  _urlAnalysis: ReturnType<typeof analyzeUrlPatterns>,
  _requestAnalysis: ReturnType<typeof analyzeRequestCharacteristics>
): Map<string, WorkflowGroup> {
  logger.info("Performing static workflow discovery", {
    sessionId: session.id,
    totalUrls: session.harData.urls.length,
  });

  const workflowGroups = new Map<string, WorkflowGroup>();

  // Create frequency map to identify primary endpoints
  const frequencyMap = new Map<string, number>();
  for (const request of session.harData.requests) {
    if (!request.url) continue;

    const baseUrl = request.url.split("?")[0];
    const key = `${request.method.toUpperCase()} ${baseUrl}`;
    frequencyMap.set(key, (frequencyMap.get(key) || 0) + 1);
  }

  // Sort endpoints by frequency to identify the most important ones
  // const sortedEndpoints = Array.from(frequencyMap.entries())
  //   .sort(([, a], [, b]) => b - a);

  // Group URLs by functional categories
  const functionalGroups = new Map<string, URLInfo[]>();

  for (const urlInfo of session.harData.urls) {
    const category = categorizeEndpoint(urlInfo.url);
    if (!functionalGroups.has(category)) {
      functionalGroups.set(category, []);
    }
    functionalGroups.get(category)?.push(urlInfo);
  }

  // Create workflows from functional groups
  let workflowCounter = 1;
  for (const [category, urls] of functionalGroups.entries()) {
    if (urls.length === 0) continue;

    // Find the primary endpoint for this category (highest frequency, simplest path)
    const categoryEndpoints = urls.map((url) => ({
      url,
      key: `${url.method.toUpperCase()} ${url.url.split("?")[0]}`,
      frequency:
        frequencyMap.get(
          `${url.method.toUpperCase()} ${url.url.split("?")[0]}`
        ) || 0,
    }));

    // Sort by frequency (desc) then by path simplicity (asc)
    const primaryEndpoint = categoryEndpoints.sort((a, b) => {
      if (a.frequency !== b.frequency) {
        return b.frequency - a.frequency;
      }
      // Prefer simpler paths (fewer segments)
      const aSegments = a.url.url.split("/").length;
      const bSegments = b.url.url.split("/").length;
      return aSegments - bSegments;
    })[0];

    if (!primaryEndpoint) continue;

    // Collect all requests for this workflow
    const workflowRequests = new Set<string>();
    for (const url of urls) {
      const matchingRequests = session.harData.requests.filter((req) => {
        if (!req.url) return false;
        const reqBaseUrl = req.url.split("?")[0];
        const urlBaseUrl = url.url.split("?")[0];
        return (
          reqBaseUrl === urlBaseUrl &&
          req.method.toUpperCase() === url.method.toUpperCase()
        );
      });

      for (const req of matchingRequests) {
        workflowRequests.add(`${req.method.toUpperCase()}:${req.url}`);
      }
    }

    const workflowId = `${category}-workflow-${workflowCounter}`;
    const workflowName = formatCategoryName(category);

    const workflowGroup: WorkflowGroup = {
      id: workflowId,
      name: workflowName,
      description: `Static workflow for ${category} operations`,
      category: mapCategoryToEnum(category),
      priority: calculateStaticPriority(category, primaryEndpoint.frequency),
      complexity: Math.min(Math.max(Math.ceil(urls.length / 2), 1), 10),
      requiresUserInput: doesCategoryRequireInput(category),
      masterNodeId: `${primaryEndpoint.url.method.toUpperCase()}:${primaryEndpoint.url.url}`,
      nodeIds: workflowRequests,
    };

    workflowGroups.set(workflowId, workflowGroup);
    workflowCounter++;

    logger.debug("Created static workflow group", {
      workflowId,
      category,
      endpointCount: urls.length,
      nodeCount: workflowRequests.size,
      primaryEndpoint: `${primaryEndpoint.url.method} ${primaryEndpoint.url.url}`,
      frequency: primaryEndpoint.frequency,
    });
  }

  logger.info("Static workflow discovery completed", {
    sessionId: session.id,
    workflowCount: workflowGroups.size,
    workflows: Array.from(workflowGroups.keys()),
  });

  return workflowGroups;
}

/**
 * Categorize an endpoint based on URL patterns
 */
function categorizeEndpoint(url: string): string {
  const lowerUrl = url.toLowerCase();

  // Search/query operations
  if (lowerUrl.includes("/pesquisa") || lowerUrl.includes("/search")) {
    return "search";
  }

  // Document operations
  if (
    lowerUrl.includes("/documento") ||
    lowerUrl.includes("/document") ||
    lowerUrl.includes("/copiar") ||
    lowerUrl.includes("/copy") ||
    lowerUrl.includes("/citar") ||
    lowerUrl.includes("/cite")
  ) {
    return "document_operations";
  }

  // Authentication
  if (
    lowerUrl.includes("/auth") ||
    lowerUrl.includes("/login") ||
    lowerUrl.includes("/token") ||
    lowerUrl.includes("/session")
  ) {
    return "authentication";
  }

  // User management
  if (
    lowerUrl.includes("/user") ||
    lowerUrl.includes("/usuario") ||
    lowerUrl.includes("/account") ||
    lowerUrl.includes("/conta")
  ) {
    return "user_management";
  }

  // Data export
  if (
    lowerUrl.includes("/export") ||
    lowerUrl.includes("/download") ||
    lowerUrl.includes("/pdf") ||
    lowerUrl.includes("/excel")
  ) {
    return "data_export";
  }

  // CRUD operations
  if (
    lowerUrl.includes("/create") ||
    lowerUrl.includes("/update") ||
    lowerUrl.includes("/delete") ||
    lowerUrl.includes("/edit")
  ) {
    return "crud";
  }

  return "other";
}

/**
 * Format category name for display
 */
function formatCategoryName(category: string): string {
  const categoryNames: Record<string, string> = {
    search: "Search Operations",
    document_operations: "Document Operations",
    authentication: "Authentication",
    user_management: "User Management",
    data_export: "Data Export",
    crud: "CRUD Operations",
    other: "General Operations",
  };

  return categoryNames[category] || "Unknown Operations";
}

/**
 * Map internal category to schema enum
 */
function mapCategoryToEnum(category: string): string {
  const categoryMapping: Record<string, string> = {
    search: "search",
    document_operations: "document_operations",
    authentication: "authentication",
    user_management: "user_management",
    data_export: "data_export",
    crud: "crud",
    other: "other",
  };

  return categoryMapping[category] || "other";
}

/**
 * Calculate priority for static workflows
 */
function calculateStaticPriority(category: string, frequency: number): number {
  // Base priority by category
  const basePriorities: Record<string, number> = {
    search: 9, // Search is usually the primary function
    authentication: 8, // Auth is critical
    document_operations: 7, // Document ops are important
    crud: 6, // CRUD operations
    data_export: 5, // Export functionality
    user_management: 4, // User management
    other: 3, // Everything else
  };

  const basePriority = basePriorities[category] || 3;

  // Boost priority based on frequency (more requests = more important)
  const frequencyBoost = Math.min(Math.floor(frequency / 5), 1); // Max +1 boost

  return Math.min(basePriority + frequencyBoost, 10);
}

/**
 * Check if category typically requires user input
 */
function doesCategoryRequireInput(category: string): boolean {
  const inputRequiredCategories = ["search", "crud", "authentication"];
  return inputRequiredCategories.includes(category);
}

/**
 * Analyze URL patterns to identify functional groupings
 */
function analyzeUrlPatterns(urls: URLInfo[]): {
  pathGroups: Map<string, URLInfo[]>;
  methodDistribution: Record<string, number>;
  apiEndpoints: URLInfo[];
  functionalCategories: string[];
} {
  const pathGroups = new Map<string, URLInfo[]>();
  const methodDistribution: Record<string, number> = {};
  const apiEndpoints: URLInfo[] = [];
  const functionalCategories: string[] = [];

  for (const urlInfo of urls) {
    // Group by base path patterns
    const url = new URL(urlInfo.url);
    const pathSegments = url.pathname
      .split("/")
      .filter((segment) => segment.length > 0);

    // Create base path (first 1-2 segments)
    const basePath = pathSegments.slice(0, 2).join("/");
    if (!pathGroups.has(basePath)) {
      pathGroups.set(basePath, []);
    }
    pathGroups.get(basePath)?.push(urlInfo);

    // Track method distribution
    methodDistribution[urlInfo.method] =
      (methodDistribution[urlInfo.method] || 0) + 1;

    // Identify API endpoints
    if (
      urlInfo.url.includes("/api/") ||
      urlInfo.responseType.includes("json")
    ) {
      apiEndpoints.push(urlInfo);
    }

    // Extract functional categories from URL patterns
    const functionalKeywords = [
      "search",
      "pesquisa",
      "consulta",
      "query",
      "document",
      "documento",
      "file",
      "arquivo",
      "user",
      "usuario",
      "account",
      "conta",
      "auth",
      "login",
      "logout",
      "token",
      "create",
      "update",
      "delete",
      "edit",
      "list",
      "index",
      "browse",
      "view",
      "export",
      "download",
      "upload",
      "copy",
      "copiar",
      "cite",
      "citar",
    ];

    for (const keyword of functionalKeywords) {
      if (urlInfo.url.toLowerCase().includes(keyword)) {
        if (!functionalCategories.includes(keyword)) {
          functionalCategories.push(keyword);
        }
      }
    }
  }

  return {
    pathGroups,
    methodDistribution,
    apiEndpoints,
    functionalCategories,
  };
}

/**
 * Analyze request characteristics to understand workflow complexity
 */
function analyzeRequestCharacteristics(requests: RequestModel[]): {
  parameterComplexity: Map<string, number>;
  authenticationPatterns: string[];
  requestTypes: Record<string, number>;
  temporalPatterns: Array<{ url: string; timestamp: Date; sequence: number }>;
} {
  const parameterComplexity = new Map<string, number>();
  const authenticationPatterns: string[] = [];
  const requestTypes: Record<string, number> = {};
  const temporalPatterns: Array<{
    url: string;
    timestamp: Date;
    sequence: number;
  }> = [];

  for (let i = 0; i < requests.length; i++) {
    const request = requests[i];
    if (!request) {
      continue;
    }

    // Analyze parameter complexity
    const url = new URL(request.url);
    const paramCount =
      url.searchParams.size + Object.keys(request.queryParams || {}).length;
    const baseUrl = `${url.origin}${url.pathname}`;
    parameterComplexity.set(
      baseUrl,
      Math.max(parameterComplexity.get(baseUrl) || 0, paramCount)
    );

    // Identify authentication patterns
    const authHeaders = [
      "authorization",
      "cookie",
      "x-api-key",
      "x-auth-token",
    ];
    for (const [headerName, headerValue] of Object.entries(request.headers)) {
      if (authHeaders.some((auth) => headerName.toLowerCase().includes(auth))) {
        const pattern = `${headerName}:${headerValue.substring(0, 20)}...`;
        if (!authenticationPatterns.includes(pattern)) {
          authenticationPatterns.push(pattern);
        }
      }
    }

    // Track request types
    const contentType =
      request.headers["content-type"] ||
      request.headers["Content-Type"] ||
      "unknown";
    const requestType = contentType.includes("json")
      ? "json"
      : contentType.includes("form")
        ? "form"
        : request.method.toLowerCase();
    requestTypes[requestType] = (requestTypes[requestType] || 0) + 1;

    // Build temporal patterns
    if (request.timestamp) {
      temporalPatterns.push({
        url: baseUrl,
        timestamp: request.timestamp,
        sequence: i,
      });
    }
  }

  return {
    parameterComplexity,
    authenticationPatterns,
    requestTypes,
    temporalPatterns: temporalPatterns.sort(
      (a, b) => a.timestamp.getTime() - b.timestamp.getTime()
    ),
  };
}

/**
 * Create LLM function definition for workflow discovery
 */
function createWorkflowDiscoveryFunctionDefinition(): FunctionDefinition {
  return {
    name: "discover_workflows",
    description:
      "Analyze API endpoints and identify distinct logical workflows",
    parameters: {
      type: "object",
      properties: {
        workflows: {
          type: "array",
          description: "List of discovered workflows",
          items: {
            type: "object",
            properties: {
              id: {
                type: "string",
                description:
                  "Unique workflow identifier (kebab-case, e.g., 'search-legal-decisions')",
              },
              name: {
                type: "string",
                description:
                  "Human-readable workflow name (e.g., 'Search Legal Decisions')",
              },
              description: {
                type: "string",
                description: "Brief description of workflow purpose",
              },
              category: {
                type: "string",
                description: "Functional category",
                enum: [
                  "search",
                  "document_operations",
                  "user_management",
                  "authentication",
                  "crud",
                  "data_export",
                  "other",
                ],
              },
              priority: {
                type: "integer",
                description:
                  "Priority level (1-10, where 10 is highest priority)",
              },
              complexity: {
                type: "integer",
                description:
                  "Complexity score (1-10, based on parameters and dependencies)",
              },
              requiresUserInput: {
                type: "boolean",
                description: "Whether workflow requires user input parameters",
              },
              endpoints: {
                type: "array",
                description: "API endpoints that comprise this workflow",
                items: {
                  type: "object",
                  properties: {
                    url: {
                      type: "string",
                      description:
                        "API endpoint URL (without query parameters)",
                    },
                    method: {
                      type: "string",
                      description: "HTTP method",
                      enum: ["GET", "POST", "PUT", "DELETE", "PATCH"],
                    },
                    role: {
                      type: "string",
                      description: "Role of this endpoint in the workflow",
                      enum: ["primary", "secondary", "supporting"],
                    },
                  },
                },
              },
            },
          },
        },
      },
      required: ["workflows"],
    },
  };
}

/**
 * Create prompt for LLM workflow discovery
 */
function createWorkflowDiscoveryPrompt(
  harData: ParsedHARData,
  urlAnalysis: ReturnType<typeof analyzeUrlPatterns>,
  requestAnalysis: ReturnType<typeof analyzeRequestCharacteristics>
): string {
  const urlList = harData.urls
    .map((url) => `${url.method} ${url.url}`)
    .join("\n");
  const pathGroups = Array.from(urlAnalysis.pathGroups.entries())
    .map(([path, urls]) => `${path}: ${urls.length} endpoints`)
    .join("\n");

  // Create frequency analysis by grouping requests by method and base URL
  const frequencyMap = new Map<string, number>();
  for (const request of harData.requests) {
    if (!request.url) {
      continue;
    }

    // Extract base URL without query parameters
    const baseUrl = request.url.split("?")[0];
    const key = `${request.method.toUpperCase()} ${baseUrl}`;
    frequencyMap.set(key, (frequencyMap.get(key) || 0) + 1);
  }

  // Sort by frequency (descending) and show top endpoints
  const frequencyAnalysis = Array.from(frequencyMap.entries())
    .sort(([, a], [, b]) => b - a)
    .slice(0, 15)
    .map(([endpoint, count]) => `${endpoint} (${count} requests)`)
    .join("\n");

  return `Analyze the following API endpoints and identify distinct logical workflows.

## API Endpoints (${harData.urls.length} total)
${urlList}

## CRITICAL: Request Frequency Analysis (PRIMARY ENDPOINT INDICATOR)
The following shows actual request frequency - higher frequency usually indicates primary endpoints:
${frequencyAnalysis}

## Path Groupings
${pathGroups}

## Functional Categories Detected
${urlAnalysis.functionalCategories.join(", ")}

## Request Statistics
- Method distribution: ${JSON.stringify(urlAnalysis.methodDistribution)}
- API endpoints: ${urlAnalysis.apiEndpoints.length}
- Parameter complexity: ${Array.from(
    requestAnalysis.parameterComplexity.entries()
  )
    .map(([url, count]) => `${url} (${count} params)`)
    .slice(0, 5)
    .join(", ")}

## Task
Identify distinct logical workflows from these endpoints. Consider:

1. **Functional Grouping**: Group endpoints that work together to accomplish a specific task
2. **User Journey**: Consider the sequence users would follow to complete different objectives
3. **Parameter Dependencies**: Endpoints that share common parameters likely belong together
4. **Business Logic**: Consider the real-world business processes these endpoints support

## Guidelines
- **Search workflows**: Include search, autocomplete, filtering, and result operations
- **Document workflows**: Include viewing, downloading, copying, citing document operations  
- **CRUD workflows**: Group create/read/update/delete operations on the same resource
- **Authentication workflows**: Group login, token refresh, session management

## Endpoint Role Classification (CRITICAL)
- **Primary endpoints**: The main action endpoint users would call to accomplish the workflow's core objective
  * Example: /api/pesquisa or /api/search (core search functionality)
  * Example: /api/create-order (main order creation)
  * These endpoints typically accept the most parameters and drive the workflow
- **Secondary endpoints**: Supporting endpoints called as part of the workflow  
  * Example: /api/pesquisa/copiarInteiroTeor (copy full text after search)
  * Example: /api/pesquisa/citarDecisao (cite decision after search) 
- **Supporting endpoints**: Utility endpoints for configuration, metadata, etc.

## CRITICAL: Primary Endpoint Selection Rules (MUST FOLLOW)
**The primary endpoint is the MAIN ACTION endpoint that drives the workflow - not a secondary action!**

1. **MANDATORY FIRST CHECK**: Use ONLY the frequency analysis above to determine primary endpoints
   - The endpoint with the HIGHEST request count is almost always the primary endpoint
   - Frequency analysis is the most reliable indicator of endpoint importance
   
2. **Base paths ONLY**: Primary endpoints should be base paths WITHOUT sub-actions
   - ✅ CORRECT: "/api/pesquisa" (base search endpoint)  
   - ❌ WRONG: "/api/pesquisa/copiarInteiroTeor" (secondary copy action)
   - ✅ CORRECT: "/api/orders" (base orders endpoint)
   - ❌ WRONG: "/api/orders/download" (secondary download action)
   
3. **Method preference**: GET for search/read operations, POST for create/submit operations
4. **Path simplicity**: Avoid sub-paths containing action words like /copy, /cite, /download, /export, /citar
5. **Parameter complexity**: Primary endpoints typically accept the most varied parameter combinations
6. **User workflow**: Primary endpoints are what users call FIRST to start the workflow

**CONCRETE EXAMPLE FROM THIS HAR FILE:**
Looking at the frequency analysis, you should see "GET /api/no-auth/pesquisa" with 25+ requests, which makes it the CLEAR primary endpoint. Any sub-paths like "/copiarInteiroTeor" or "/citarDecisao" are secondary actions that happen AFTER the main search.

**SELECTION ALGORITHM:**
1. Find the endpoint with highest frequency from the analysis above
2. Verify it's a base path (not a sub-action)  
3. That's your primary endpoint - DO NOT choose lower-frequency endpoints

Prioritize workflows by:
- User impact (search/core functionality = high priority)
- Frequency of use (main workflows = high priority)  
- Business value (revenue-generating actions = high priority)

Set complexity based on:
- Number of parameters required
- Dependencies between requests
- Authentication requirements
- Data processing complexity`;
}

/**
 * Get the most important workflow from discovered workflows
 * Used as fallback when user doesn't specify which workflow to process
 */
export function getPrimaryWorkflow(
  workflowGroups: Map<string, WorkflowGroup>
): WorkflowGroup | null {
  if (workflowGroups.size === 0) {
    return null;
  }

  // Sort by priority (descending) then by complexity (ascending, simpler first for same priority)
  const sortedWorkflows = Array.from(workflowGroups.values()).sort((a, b) => {
    if (a.priority !== b.priority) {
      return b.priority - a.priority; // Higher priority first
    }
    return a.complexity - b.complexity; // Lower complexity first for same priority
  });

  return sortedWorkflows[0] || null;
}
