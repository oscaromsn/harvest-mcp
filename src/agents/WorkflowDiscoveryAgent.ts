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

    // Use LLM to identify logical workflow groupings
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

        const matchingRequests = session.harData.requests.filter(
          (req) =>
            req.url?.includes(endpointBaseUrl) &&
            req.method.toUpperCase() === endpoint.method.toUpperCase()
        );

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

    logger.info("Workflow discovery completed", {
      sessionId: session.id,
      workflowCount: workflowGroups.size,
      workflows: Array.from(workflowGroups.keys()),
    });

    return workflowGroups;
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

  return `Analyze the following API endpoints and identify distinct logical workflows.

## API Endpoints (${harData.urls.length} total)
${urlList}

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
- **Primary endpoints**: The main action endpoint users would call (e.g., search endpoint in a search workflow)
- **Secondary endpoints**: Supporting endpoints called as part of the workflow (e.g., autocomplete in search)
- **Supporting endpoints**: Utility endpoints (e.g., getting configuration, static data)

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
 * Update workflow groups with actual DAG node IDs after nodes are created
 * This should be called after DAG nodes have been created
 */

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
