import { getLLMClient } from "../core/LLMClient.js";
import type { FunctionDefinition } from "../core/providers/types.js";
import type {
  CookieData,
  CookieDependency,
  CookieSearchResult,
  DependencyResult,
  ParsedHARData,
  RequestDependency,
  RequestModel,
  SimplestRequestResponse,
} from "../types/index.js";
import { HarvestError } from "../types/index.js";

/**
 * Find dependencies for dynamic parts across cookies and requests
 */
export async function findDependencies(
  dynamicParts: string[],
  harData: ParsedHARData,
  cookieData: CookieData = {}
): Promise<DependencyResult> {
  if (!dynamicParts || dynamicParts.length === 0) {
    return createEmptyDependencyResult();
  }

  try {
    // First, check for cookie dependencies (priority over requests)
    const cookieResult = findCookieDependencies(dynamicParts, cookieData);

    // Process request dependencies for remaining parts
    const { requestDependencies, notFoundParts } =
      await processRequestDependencies(
        cookieResult.remaining,
        harData.requests
      );

    return {
      cookieDependencies: cookieResult.found,
      requestDependencies,
      notFoundParts,
    };
  } catch (error) {
    if (error instanceof HarvestError) {
      throw error;
    }

    throw new HarvestError(
      `Dependency finding failed: ${error instanceof Error ? error.message : "Unknown error"}`,
      "DEPENDENCY_FINDING_FAILED",
      { originalError: error }
    );
  }
}

/**
 * Create empty dependency result for early returns
 */
function createEmptyDependencyResult(): DependencyResult {
  return {
    cookieDependencies: [],
    requestDependencies: [],
    notFoundParts: [],
  };
}

/**
 * Process request dependencies for remaining dynamic parts
 */
async function processRequestDependencies(
  remainingParts: string[],
  requests: RequestModel[]
): Promise<{
  requestDependencies: RequestDependency[];
  notFoundParts: string[];
}> {
  if (remainingParts.length === 0) {
    return { requestDependencies: [], notFoundParts: [] };
  }

  const requestResult = findRequestDependencies(remainingParts, requests);
  const groupedDependencies = groupDependenciesByPart(requestResult);
  const requestDependencies =
    await selectOptimalDependencies(groupedDependencies);
  const notFoundParts = findUnresolvedParts(
    remainingParts,
    requestDependencies
  );

  return { requestDependencies, notFoundParts };
}

/**
 * Group request dependencies by dynamic part
 */
function groupDependenciesByPart(
  dependencies: RequestDependency[]
): Map<string, RequestDependency[]> {
  const groupedByPart = new Map<string, RequestDependency[]>();

  for (const dep of dependencies) {
    if (!groupedByPart.has(dep.dynamicPart)) {
      groupedByPart.set(dep.dynamicPart, []);
    }
    groupedByPart.get(dep.dynamicPart)?.push(dep);
  }

  return groupedByPart;
}

/**
 * Select optimal dependencies from grouped dependencies
 */
async function selectOptimalDependencies(
  groupedDependencies: Map<string, RequestDependency[]>
): Promise<RequestDependency[]> {
  const selectedDependencies: RequestDependency[] = [];

  for (const [, dependencies] of groupedDependencies) {
    const selectedDep = await selectOptimalDependency(dependencies);
    if (selectedDep) {
      selectedDependencies.push(selectedDep);
    }
  }

  return selectedDependencies;
}

/**
 * Select optimal dependency from a group of dependencies for the same dynamic part
 */
async function selectOptimalDependency(
  dependencies: RequestDependency[]
): Promise<RequestDependency | null> {
  if (dependencies.length === 0) {
    return null;
  }

  if (dependencies.length === 1 && dependencies[0]) {
    return dependencies[0];
  }

  // Multiple dependencies - use LLM to select simplest
  const requests = dependencies.map((dep) => dep.sourceRequest);
  try {
    const simplestRequest = await selectSimplestRequest(requests);
    return (
      dependencies.find((dep) => dep.sourceRequest === simplestRequest) || null
    );
  } catch (_error) {
    // If LLM selection fails, use the first one
    return dependencies[0] || null;
  }
}

/**
 * Find parts that were not resolved by any dependencies
 */
function findUnresolvedParts(
  remainingParts: string[],
  resolvedDependencies: RequestDependency[]
): string[] {
  const resolvedParts = resolvedDependencies.map((dep) => dep.dynamicPart);
  return remainingParts.filter((part) => !resolvedParts.includes(part));
}

/**
 * Find cookie dependencies for dynamic parts
 */
export function findCookieDependencies(
  dynamicParts: string[],
  cookieData: CookieData
): CookieSearchResult {
  const found: CookieDependency[] = [];
  const remaining: string[] = [];

  for (const part of dynamicParts) {
    const cookieKey = findKeyByStringInValue(cookieData, part);

    if (cookieKey) {
      found.push({
        type: "cookie",
        cookieKey,
        dynamicPart: part,
      });
    } else {
      remaining.push(part);
    }
  }

  return { found, remaining };
}

/**
 * Find request dependencies for dynamic parts
 */
export function findRequestDependencies(
  dynamicParts: string[],
  requests: RequestModel[]
): RequestDependency[] {
  const dependencies: RequestDependency[] = [];

  for (const part of dynamicParts) {
    for (const request of requests) {
      // Skip JavaScript files and HTML responses
      if (isJavaScriptOrHtml(request)) {
        continue;
      }

      // Check if the part exists in the response text OR response headers
      const responseText = request.response?.text || "";
      const responseHeaders = request.response?.headers || {};
      const responseHeadersText = Object.entries(responseHeaders)
        .map(([name, value]) => `${name}: ${value}`)
        .join("\n");
      const curlString = request.toString();

      // Check conditions:
      // 1. Part is in response text/headers but not in request
      // 2. URL-decoded part is in request
      const foundInResponseText = responseText
        .toLowerCase()
        .includes(part.toLowerCase());
      const foundInResponseHeaders = responseHeadersText
        .toLowerCase()
        .includes(part.toLowerCase());
      const foundInRequest = curlString
        .toLowerCase()
        .includes(part.toLowerCase());

      if (
        ((foundInResponseText || foundInResponseHeaders) && !foundInRequest) ||
        (curlString.includes(decodeURIComponent(part)) &&
          !curlString.includes(part))
      ) {
        dependencies.push({
          type: "request",
          sourceRequest: request,
          dynamicPart: part,
        });
      }
    }
  }

  return dependencies;
}

/**
 * Select the simplest request from a list using LLM analysis
 */
export async function selectSimplestRequest(
  requests: RequestModel[]
): Promise<RequestModel> {
  if (!requests || requests.length === 0) {
    throw new HarvestError(
      "No requests provided for selection",
      "NO_REQUESTS_PROVIDED"
    );
  }

  if (requests.length === 1) {
    const firstRequest = requests[0];
    if (!firstRequest) {
      throw new Error("Request array contains undefined element");
    }
    return firstRequest;
  }

  try {
    const llmClient = getLLMClient();
    const functionDef = createSimplestRequestFunctionDefinition();
    const prompt = createSimplestRequestPrompt(requests);

    const response = await llmClient.callFunction<SimplestRequestResponse>(
      prompt,
      functionDef,
      "get_simplest_curl_index"
    );

    const index = response.index;

    // Validate index
    if (typeof index !== "number" || index < 0 || index >= requests.length) {
      throw new HarvestError(
        `Invalid index ${index} for request list of length ${requests.length}`,
        "INVALID_REQUEST_INDEX"
      );
    }

    const selectedRequest = requests[index];
    if (!selectedRequest) {
      throw new Error(`Request at index ${index} is undefined`);
    }
    return selectedRequest;
  } catch (error) {
    if (error instanceof HarvestError) {
      throw error;
    }

    throw new HarvestError(
      `Simplest request selection failed: ${error instanceof Error ? error.message : "Unknown error"}`,
      "SIMPLEST_REQUEST_SELECTION_FAILED",
      { originalError: error }
    );
  }
}

/**
 * Create function definition for simplest request selection
 */
export function createSimplestRequestFunctionDefinition(): FunctionDefinition {
  return {
    name: "get_simplest_curl_index",
    description: "Find the index of the simplest cURL command from a list",
    parameters: {
      type: "object",
      properties: {
        index: {
          type: "integer",
          description: "The index of the simplest cURL command in the list",
        },
      },
      required: ["index"],
    },
  };
}

/**
 * Create prompt for simplest request selection
 */
export function createSimplestRequestPrompt(requests: RequestModel[]): string {
  const serializedRequests = requests.map((req) => req.toString());

  return `${JSON.stringify(serializedRequests)}

Task:
Given the above list of cURL commands, find the index of the curl that has the least number of dependencies and variables.
The index should be 0-based (i.e., the first item has index 0).

Consider:
- Requests with fewer headers are simpler
- GET requests are often simpler than POST requests
- Requests with smaller payloads are simpler
- Requests to endpoints that look like they provide basic data are simpler`;
}

/**
 * Find key by searching for string in cookie values (ports find_key_by_string_in_value)
 */
export function findKeyByStringInValue(
  cookieData: CookieData,
  searchString: string
): string | null {
  for (const [key, cookieInfo] of Object.entries(cookieData)) {
    if (cookieInfo.value?.includes(searchString)) {
      return key;
    }
  }
  return null;
}

/**
 * Check if a request is for JavaScript file or HTML response
 */
export function isJavaScriptOrHtml(request: RequestModel): boolean {
  // Check URL for JavaScript files
  if (request.url.endsWith(".js")) {
    return true;
  }

  // Check response content type for HTML
  const contentType =
    request.response?.headers?.["Content-Type"] ||
    request.response?.headers?.["content-type"] ||
    "";

  if (
    contentType.includes("text/html") ||
    contentType.includes("application/javascript")
  ) {
    return true;
  }

  return false;
}

/**
 * Create dependency edges in DAG format for MCP integration
 */
export function createDependencyEdges(
  consumerNodeId: string,
  dependencies: DependencyResult
): Array<{
  from: string;
  to: string;
  type: "cookie" | "request" | "not_found";
}> {
  const edges: Array<{
    from: string;
    to: string;
    type: "cookie" | "request" | "not_found";
  }> = [];

  // Cookie dependencies
  for (const cookieDep of dependencies.cookieDependencies) {
    edges.push({
      from: consumerNodeId,
      to: `cookie_${cookieDep.cookieKey}`,
      type: "cookie",
    });
  }

  // Request dependencies
  for (const requestDep of dependencies.requestDependencies) {
    edges.push({
      from: consumerNodeId,
      to: `request_${requestDep.sourceRequest.url}`,
      type: "request",
    });
  }

  // Not found parts
  for (const notFoundPart of dependencies.notFoundParts) {
    edges.push({
      from: consumerNodeId,
      to: `not_found_${notFoundPart}`,
      type: "not_found",
    });
  }

  return edges;
}

/**
 * Validate dynamic parts before processing
 */
export function validateDynamicParts(dynamicParts: string[]): {
  valid: string[];
  invalid: string[];
  reasons: Record<string, string>;
} {
  const valid: string[] = [];
  const invalid: string[] = [];
  const reasons: Record<string, string> = {};

  for (const part of dynamicParts) {
    if (!part || typeof part !== "string") {
      invalid.push(part);
      reasons[part] = "Invalid type or empty";
      continue;
    }

    if (part.length < 3) {
      invalid.push(part);
      reasons[part] = "Too short to be meaningful";
      continue;
    }

    // Check for obvious static values
    const staticPatterns = [
      "application/json",
      "text/html",
      "utf-8",
      "true",
      "false",
      "null",
    ];

    if (staticPatterns.includes(part.toLowerCase())) {
      invalid.push(part);
      reasons[part] = "Common static value";
      continue;
    }

    valid.push(part);
  }

  return { valid, invalid, reasons };
}
