import { getLLMClient } from "../core/LLMClient.js";
import type { FunctionDefinition } from "../core/providers/types.js";
import type {
  BootstrapParameterSource,
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
import { createComponentLogger } from "../utils/logger.js";

const logger = createComponentLogger("dependency-agent");

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
 * Find bootstrap dependencies for session-constant dynamic parts
 * This function analyzes the initial HTML page loads to find session parameters
 */
export async function findBootstrapDependencies(
  dynamicParts: string[],
  harData: ParsedHARData
): Promise<Map<string, BootstrapParameterSource>> {
  const bootstrapSources = new Map<string, BootstrapParameterSource>();

  if (!dynamicParts || dynamicParts.length === 0) {
    return bootstrapSources;
  }

  try {
    // Find the initial HTML page load (usually the first request to the main domain)
    const initialHtmlRequests = findInitialHtmlRequests(harData.requests);

    for (const htmlRequest of initialHtmlRequests) {
      for (const part of dynamicParts) {
        if (bootstrapSources.has(part)) {
          continue; // Already found source for this parameter
        }

        // Check for bootstrap source in this HTML request
        const source = await analyzeBootstrapSource(part, htmlRequest);
        if (source) {
          bootstrapSources.set(part, source);
        }
      }
    }

    // Fallback: For session constants that appear consistently across requests
    // but have no detectable bootstrap source, create synthetic bootstrap sources
    // This handles mid-session HAR captures where initial page loads aren't included
    const unresolved = dynamicParts.filter(
      (part) => !bootstrapSources.has(part)
    );
    if (unresolved.length > 0) {
      const syntheticSources = createSyntheticBootstrapSources(
        unresolved,
        harData
      );
      for (const [part, source] of syntheticSources) {
        bootstrapSources.set(part, source);
      }
    }

    return bootstrapSources;
  } catch (error) {
    throw new HarvestError(
      `Bootstrap dependency finding failed: ${error instanceof Error ? error.message : "Unknown error"}`,
      "BOOTSTRAP_DEPENDENCY_FINDING_FAILED",
      { originalError: error }
    );
  }
}

/**
 * Create synthetic bootstrap sources for session constants that appear consistently
 * but have no detectable initial source (mid-session HAR captures)
 */
function createSyntheticBootstrapSources(
  unresolvedParts: string[],
  harData: ParsedHARData
): Map<string, BootstrapParameterSource> {
  const syntheticSources = new Map<string, BootstrapParameterSource>();

  for (const part of unresolvedParts) {
    // Check if this parameter appears consistently across requests (likely session constant)
    const occurrences = harData.requests.filter((req) => {
      return (
        req.url.includes(part) ||
        (req.queryParams && Object.values(req.queryParams).includes(part)) ||
        (req.body && typeof req.body === "string" && req.body.includes(part))
      );
    });

    // If parameter appears in 3+ requests consistently, treat as session constant
    if (occurrences.length >= 3) {
      // Find the earliest request that uses this parameter
      const earliestRequest = occurrences.reduce((earliest, current) => {
        const earliestTime = earliest.timestamp?.getTime() || 0;
        const currentTime = current.timestamp?.getTime() || 0;
        return currentTime < earliestTime ? current : earliest;
      });

      // Create synthetic bootstrap source pointing to a hypothetical initial page
      const baseUrl = new URL(earliestRequest.url).origin;
      syntheticSources.set(part, {
        type: "initial-page-html",
        sourceUrl: baseUrl,
        extractionDetails: {
          pattern:
            "// Synthetic bootstrap - session constant established before HAR capture",
          syntheticSource: true, // Mark as synthetic for transparency
        },
      });

      logger.debug("Created synthetic bootstrap source for session constant", {
        parameter: part,
        source: "synthetic",
      });
    }
  }

  return syntheticSources;
}

/**
 * Find initial HTML page loads that could establish session state
 */
function findInitialHtmlRequests(requests: RequestModel[]): RequestModel[] {
  return requests
    .filter((request) => {
      // Look for HTML responses
      const contentType =
        request.response?.headers?.["content-type"] ||
        request.response?.headers?.["Content-Type"] ||
        "";

      // Check if it's an HTML response
      if (!contentType.includes("text/html")) {
        return false;
      }

      // Prioritize main page loads (GET requests to root or main paths)
      if (request.method.toUpperCase() === "GET") {
        const url = new URL(request.url);
        const path = url.pathname;

        // Main page indicators
        return (
          path === "/" ||
          path === "" ||
          path.endsWith("/") ||
          !path.includes(".") // No file extension
        );
      }

      return false;
    })
    .slice(0, 3); // Limit to first 3 HTML requests for performance
}

/**
 * Analyze a single HTML request to find bootstrap source for a parameter
 */
async function analyzeBootstrapSource(
  parameter: string,
  htmlRequest: RequestModel
): Promise<BootstrapParameterSource | null> {
  try {
    // Check response body for inline JavaScript containing the parameter
    const responseText = htmlRequest.response?.text || "";
    if (responseText && searchInHtmlContent(responseText, parameter)) {
      return {
        type: "initial-page-html",
        sourceUrl: htmlRequest.url,
        extractionDetails: {
          pattern: generateExtractionPattern(parameter, responseText),
        },
      };
    }

    // Check Set-Cookie headers
    const setCookieSource = analyzeSetCookieHeaders(parameter, htmlRequest);
    if (setCookieSource) {
      return setCookieSource;
    }

    return null;
  } catch (error) {
    // Log error but don't fail the entire analysis
    logger.error("Error analyzing bootstrap source", {
      parameter,
      error: error instanceof Error ? error.message : "Unknown error",
    });
    return null;
  }
}

/**
 * Search for parameter value in HTML content (script tags, inline JS, etc.)
 */
function searchInHtmlContent(htmlContent: string, parameter: string): boolean {
  // Simple string search first
  if (htmlContent.includes(parameter)) {
    return true;
  }

  // Look specifically in script tags
  const scriptTagRegex = /<script[^>]*>([\s\S]*?)<\/script>/gi;
  let match: RegExpExecArray | null = scriptTagRegex.exec(htmlContent);

  while (match !== null) {
    const scriptContent = match[1];
    if (scriptContent?.includes(parameter)) {
      return true;
    }
    match = scriptTagRegex.exec(htmlContent);
  }

  return false;
}

/**
 * Advanced HTML analysis to find the best extraction pattern for a parameter
 */
function analyzeParameterInHTML(
  parameter: string,
  htmlContent: string
): {
  pattern?: string;
  confidence: number;
  context: string;
  location: "script" | "meta" | "input" | "data-attribute" | "inline" | "none";
} {
  let bestPattern: string | undefined;
  let confidence = 0;
  let context = "none";
  let location:
    | "script"
    | "meta"
    | "input"
    | "data-attribute"
    | "inline"
    | "none" = "none";

  // 1. Check in script tags (highest confidence)
  const scriptAnalysis = analyzeInScriptTags(parameter, htmlContent);
  if (scriptAnalysis.found && scriptAnalysis.confidence > confidence) {
    bestPattern = scriptAnalysis.pattern;
    confidence = scriptAnalysis.confidence;
    context = scriptAnalysis.context;
    location = "script";
  }

  // 2. Check in meta tags
  const metaAnalysis = analyzeInMetaTags(parameter, htmlContent);
  if (metaAnalysis.found && metaAnalysis.confidence > confidence) {
    bestPattern = metaAnalysis.pattern;
    confidence = metaAnalysis.confidence;
    context = metaAnalysis.context;
    location = "meta";
  }

  // 3. Check in input hidden fields
  const inputAnalysis = analyzeInInputFields(parameter, htmlContent);
  if (inputAnalysis.found && inputAnalysis.confidence > confidence) {
    bestPattern = inputAnalysis.pattern;
    confidence = inputAnalysis.confidence;
    context = inputAnalysis.context;
    location = "input";
  }

  // 4. Check in data attributes
  const dataAnalysis = analyzeInDataAttributes(parameter, htmlContent);
  if (dataAnalysis.found && dataAnalysis.confidence > confidence) {
    bestPattern = dataAnalysis.pattern;
    confidence = dataAnalysis.confidence;
    context = dataAnalysis.context;
    location = "data-attribute";
  }

  // 5. Check inline (direct text)
  const inlineAnalysis = analyzeInlineContent(parameter, htmlContent);
  if (inlineAnalysis.found && inlineAnalysis.confidence > confidence) {
    bestPattern = inlineAnalysis.pattern;
    confidence = inlineAnalysis.confidence;
    context = inlineAnalysis.context;
    location = "inline";
  }

  return {
    ...(bestPattern && { pattern: bestPattern }),
    confidence,
    context,
    location,
  };
}

/**
 * Analyze parameter extraction within script tags
 */
function analyzeInScriptTags(
  parameter: string,
  htmlContent: string
): {
  found: boolean;
  pattern?: string;
  confidence: number;
  context: string;
} {
  const scriptTagRegex = /<script[^>]*>([\s\S]*?)<\/script>/gi;
  const escapedParam = escapeRegex(parameter);

  let match: RegExpExecArray | null;
  while ((match = scriptTagRegex.exec(htmlContent)) !== null) {
    const scriptContent = match[1] || "";

    // Check for various JavaScript patterns
    const patterns = [
      // Variable assignment: var sessionId = "value"
      {
        regex: new RegExp(
          `(?:var|let|const)\\s+(${escapedParam})\\s*=\\s*["']([^"']+)["']`,
          "i"
        ),
        pattern: `(?:var|let|const)\\s+(${escapedParam})\\s*=\\s*["']([^"']+)["']`,
        confidence: 0.9,
        context: "variable_declaration",
      },
      // Object property: window.sessionId = "value"
      {
        regex: new RegExp(
          `(?:window|global|this)\\.(${escapedParam})\\s*=\\s*["']([^"']+)["']`,
          "i"
        ),
        pattern: `(?:window|global|this)\\.(${escapedParam})\\s*=\\s*["']([^"']+)["']`,
        confidence: 0.85,
        context: "global_assignment",
      },
      // JSON configuration: "sessionId": "value"
      {
        regex: new RegExp(
          `["'](${escapedParam})["']\\s*:\\s*["']([^"']+)["']`,
          "i"
        ),
        pattern: `["'](${escapedParam})["']\\s*:\\s*["']([^"']+)["']`,
        confidence: 0.8,
        context: "json_config",
      },
      // Direct assignment: sessionId = "value"
      {
        regex: new RegExp(`\\b(${escapedParam})\\s*=\\s*["']([^"']+)["']`, "i"),
        pattern: `\\b(${escapedParam})\\s*=\\s*["']([^"']+)["']`,
        confidence: 0.75,
        context: "direct_assignment",
      },
    ];

    for (const { regex, pattern, confidence, context } of patterns) {
      if (regex.test(scriptContent)) {
        return {
          found: true,
          pattern,
          confidence,
          context: `script_${context}`,
        };
      }
    }
  }

  return { found: false, confidence: 0, context: "none" };
}

/**
 * Analyze parameter extraction from meta tags
 */
function analyzeInMetaTags(
  parameter: string,
  htmlContent: string
): {
  found: boolean;
  pattern?: string;
  confidence: number;
  context: string;
} {
  const escapedParam = escapeRegex(parameter);

  // Meta tag patterns
  const patterns = [
    {
      regex: new RegExp(
        `<meta[^>]*name\\s*=\\s*["']${escapedParam}["'][^>]*content\\s*=\\s*["']([^"']+)["'][^>]*>`,
        "i"
      ),
      pattern: `<meta[^>]*name\\s*=\\s*["']${escapedParam}["'][^>]*content\\s*=\\s*["']([^"']+)["'][^>]*>`,
      confidence: 0.9,
    },
    {
      regex: new RegExp(
        `<meta[^>]*content\\s*=\\s*["']([^"']+)["'][^>]*name\\s*=\\s*["']${escapedParam}["'][^>]*>`,
        "i"
      ),
      pattern: `<meta[^>]*content\\s*=\\s*["']([^"']+)["'][^>]*name\\s*=\\s*["']${escapedParam}["'][^>]*>`,
      confidence: 0.9,
    },
  ];

  for (const { regex, pattern, confidence } of patterns) {
    if (regex.test(htmlContent)) {
      return {
        found: true,
        pattern,
        confidence,
        context: "meta_tag",
      };
    }
  }

  return { found: false, confidence: 0, context: "none" };
}

/**
 * Analyze parameter extraction from input hidden fields
 */
function analyzeInInputFields(
  parameter: string,
  htmlContent: string
): {
  found: boolean;
  pattern?: string;
  confidence: number;
  context: string;
} {
  const escapedParam = escapeRegex(parameter);

  const patterns = [
    {
      regex: new RegExp(
        `<input[^>]*name\\s*=\\s*["']${escapedParam}["'][^>]*value\\s*=\\s*["']([^"']+)["'][^>]*>`,
        "i"
      ),
      pattern: `<input[^>]*name\\s*=\\s*["']${escapedParam}["'][^>]*value\\s*=\\s*["']([^"']+)["'][^>]*>`,
      confidence: 0.85,
    },
    {
      regex: new RegExp(
        `<input[^>]*value\\s*=\\s*["']([^"']+)["'][^>]*name\\s*=\\s*["']${escapedParam}["'][^>]*>`,
        "i"
      ),
      pattern: `<input[^>]*value\\s*=\\s*["']([^"']+)["'][^>]*name\\s*=\\s*["']${escapedParam}["'][^>]*>`,
      confidence: 0.85,
    },
  ];

  for (const { regex, pattern, confidence } of patterns) {
    if (regex.test(htmlContent)) {
      return {
        found: true,
        pattern,
        confidence,
        context: "input_field",
      };
    }
  }

  return { found: false, confidence: 0, context: "none" };
}

/**
 * Analyze parameter extraction from data attributes
 */
function analyzeInDataAttributes(
  parameter: string,
  htmlContent: string
): {
  found: boolean;
  pattern?: string;
  confidence: number;
  context: string;
} {
  // Convert camelCase to kebab-case for data attributes
  const dataAttrName = parameter.toLowerCase().replace(/([A-Z])/g, "-$1");
  const escapedDataAttr = escapeRegex(dataAttrName);

  const pattern = `data-${escapedDataAttr}\\s*=\\s*["']([^"']+)["']`;
  const regex = new RegExp(pattern, "i");

  if (regex.test(htmlContent)) {
    return {
      found: true,
      pattern,
      confidence: 0.7,
      context: "data_attribute",
    };
  }

  return { found: false, confidence: 0, context: "none" };
}

/**
 * Analyze parameter extraction from inline content
 */
function analyzeInlineContent(
  parameter: string,
  htmlContent: string
): {
  found: boolean;
  pattern?: string;
  confidence: number;
  context: string;
} {
  const escapedParam = escapeRegex(parameter);

  // Look for the parameter value in various inline contexts
  const patterns = [
    {
      regex: new RegExp(`\\b${escapedParam}\\s*[=:]\\s*["']([^"']+)["']`, "i"),
      pattern: `\\b${escapedParam}\\s*[=:]\\s*["']([^"']+)["']`,
      confidence: 0.6,
    },
    {
      regex: new RegExp(
        `["']${escapedParam}["']\\s*[=:]\\s*["']([^"']+)["']`,
        "i"
      ),
      pattern: `["']${escapedParam}["']\\s*[=:]\\s*["']([^"']+)["']`,
      confidence: 0.5,
    },
  ];

  for (const { regex, pattern, confidence } of patterns) {
    if (regex.test(htmlContent)) {
      return {
        found: true,
        pattern,
        confidence,
        context: "inline_content",
      };
    }
  }

  return { found: false, confidence: 0, context: "none" };
}

/**
 * Generate regex pattern to extract parameter from HTML content
 */
function generateExtractionPattern(
  parameter: string,
  htmlContent: string
): string {
  // Enhanced pattern generation with multiple strategies
  const extractionResult = analyzeParameterInHTML(parameter, htmlContent);

  if (extractionResult.pattern) {
    return extractionResult.pattern;
  }

  // Fallback to improved generic pattern generation
  const escapedParam = escapeRegex(parameter);

  // Look for common JavaScript variable assignment patterns
  const patterns = [
    // Direct assignment: sessionId = "value" or sessionId: "value"
    `(?:${escapedParam})\\s*[=:]\\s*["']([^"']+)["']`,
    // Window/global assignment: window.sessionId = "value"
    `(?:window\\.|global\\.|this\\.)(?:${escapedParam})\\s*=\\s*["']([^"']+)["']`,
    // Variable declaration: var/let/const sessionId = "value"
    `(?:var|let|const)\\s+(?:${escapedParam})\\s*=\\s*["']([^"']+)["']`,
    // JSON property: "sessionId":"value"
    `["'](?:${escapedParam})["']\\s*:\\s*["']([^"']+)["']`,
    // Data attribute: data-session-id="value"
    `data-${parameter.toLowerCase().replace(/([A-Z])/g, "-$1")}\\s*=\\s*["']([^"']+)["']`,
    // Meta tag: <meta name="sessionId" content="value">
    `<meta[^>]*name\\s*=\\s*["']${escapedParam}["'][^>]*content\\s*=\\s*["']([^"']+)["']`,
    // Input hidden field: <input type="hidden" name="sessionId" value="value">
    `<input[^>]*name\\s*=\\s*["']${escapedParam}["'][^>]*value\\s*=\\s*["']([^"']+)["']`,
    // Legacy sessionId/session_id patterns
    `(?:sessionId|session_id)\\s*[=:]\\s*["']([^"']+)["']`,
    `window\\.(?:sessionId|session_id)\\s*=\\s*["']([^"']+)["']`,
    `(?:var|let|const)\\s+(?:sessionId|session_id)\\s*=\\s*["']([^"']+)["']`,
    `["'](?:sessionId|session_id)["']\\s*:\\s*["']([^"']+)["']`,
    // For tokens like juristkn, API keys, etc.
    `(?:token|tkn|juristkn|apikey|api_key)\\s*[=:]\\s*["']([^"']+)["']`,
    // Generic pattern for the exact parameter value
    `["']?${escapedParam}["']?`,
  ];

  // Try to find which pattern matches in the content
  for (const pattern of patterns) {
    const regex = new RegExp(pattern, "i");
    if (regex.test(htmlContent)) {
      return pattern;
    }
  }

  // Fallback: just look for the literal value
  return escapedParam;
}

/**
 * Escape special regex characters
 */
function escapeRegex(string: string): string {
  return string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Analyze Set-Cookie headers for bootstrap parameters
 */
function analyzeSetCookieHeaders(
  parameter: string,
  htmlRequest: RequestModel
): BootstrapParameterSource | null {
  const responseHeaders = htmlRequest.response?.headers || {};

  // Look for Set-Cookie headers
  for (const [headerName, headerValue] of Object.entries(responseHeaders)) {
    if (headerName.toLowerCase() === "set-cookie") {
      // Parse cookie to see if it contains our parameter
      const cookieParts = headerValue.split(";")[0]?.split("=");
      if (cookieParts && cookieParts.length >= 2) {
        const [cookieName, cookieValue] = cookieParts;

        // Check if cookie value contains our parameter
        if (cookieValue?.includes(parameter)) {
          const extractionDetails: {
            pattern: string;
            cookieName?: string;
            jsonPath?: string;
          } = {
            pattern: `${cookieName}=([^;]+)`,
          };

          if (cookieName) {
            extractionDetails.cookieName = cookieName.trim();
          }

          return {
            type: "initial-page-cookie",
            sourceUrl: htmlRequest.url,
            extractionDetails,
          };
        }

        // Check if cookie name matches parameter patterns
        if (cookieName && isSessionParameterName(cookieName, parameter)) {
          const extractionDetails: {
            pattern: string;
            cookieName?: string;
            jsonPath?: string;
          } = {
            pattern: `${cookieName}=([^;]+)`,
          };

          if (cookieName) {
            extractionDetails.cookieName = cookieName.trim();
          }

          return {
            type: "initial-page-cookie",
            sourceUrl: htmlRequest.url,
            extractionDetails,
          };
        }
      }
    }
  }

  return null;
}

/**
 * Check if a cookie name likely corresponds to a session parameter
 */
function isSessionParameterName(
  cookieName: string,
  parameter: string
): boolean {
  const lowerCookieName = cookieName.toLowerCase();
  const lowerParameter = parameter.toLowerCase();

  // Direct match
  if (lowerCookieName === lowerParameter) {
    return true;
  }

  // Common session parameter patterns
  const sessionPatterns = [
    "session",
    "sess",
    "token",
    "auth",
    "csrf",
    "xsrf",
    "jwt",
  ];

  return sessionPatterns.some(
    (pattern) =>
      lowerCookieName.includes(pattern) && lowerParameter.includes(pattern)
  );
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

      // Enhanced search with JSON-aware parsing and Set-Cookie analysis
      const responseText = request.response?.text || "";
      const responseHeaders = request.response?.headers || {};
      const curlString = request.toString();

      // JSON-aware search in response
      const foundInResponseText = searchInResponseText(responseText, part);

      // Enhanced header search including Set-Cookie analysis
      const foundInResponseHeaders = searchInResponseHeaders(
        responseHeaders,
        part
      );

      // Standard request search
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

/**
 * Enhanced search in response text with JSON awareness
 */
function searchInResponseText(
  responseText: string,
  searchValue: string
): boolean {
  // First try simple string search
  if (responseText.toLowerCase().includes(searchValue.toLowerCase())) {
    return true;
  }

  // Try JSON-aware search for better accuracy
  try {
    const jsonObj = JSON.parse(responseText);
    return deepSearchJsonValue(jsonObj, searchValue);
  } catch {
    // If not valid JSON, fall back to string search (already done above)
    return false;
  }
}

/**
 * Recursively search for a value in a JSON object
 */
function deepSearchJsonValue(obj: unknown, searchValue: string): boolean {
  if (obj === null || obj === undefined) {
    return false;
  }

  // Direct string comparison for primitive values
  if (typeof obj === "string") {
    return (
      obj.toLowerCase().includes(searchValue.toLowerCase()) ||
      obj === searchValue
    );
  }

  if (typeof obj === "number" || typeof obj === "boolean") {
    return obj.toString() === searchValue;
  }

  // Recursive search for arrays
  if (Array.isArray(obj)) {
    return obj.some((item) => deepSearchJsonValue(item, searchValue));
  }

  // Recursive search for objects
  if (typeof obj === "object") {
    return Object.values(obj).some((value) =>
      deepSearchJsonValue(value, searchValue)
    );
  }

  return false;
}

/**
 * Enhanced search in response headers with Set-Cookie analysis
 */
function searchInResponseHeaders(
  responseHeaders: Record<string, string>,
  searchValue: string
): boolean {
  // Standard header search
  const responseHeadersText = Object.entries(responseHeaders)
    .map(([name, value]) => `${name}: ${value}`)
    .join("\n");

  if (responseHeadersText.toLowerCase().includes(searchValue.toLowerCase())) {
    return true;
  }

  // Special handling for Set-Cookie headers
  const setCookieHeaders = Object.entries(responseHeaders)
    .filter(([name]) => name.toLowerCase() === "set-cookie")
    .map(([, value]) => value);

  for (const cookieHeader of setCookieHeaders) {
    if (searchInCookieHeader(cookieHeader, searchValue)) {
      return true;
    }
  }

  return false;
}

/**
 * Search within a Set-Cookie header value
 */
function searchInCookieHeader(
  cookieHeader: string,
  searchValue: string
): boolean {
  // Parse cookie components: name=value; attribute=value; ...
  const parts = cookieHeader.split(";").map((part) => part.trim());

  for (const part of parts) {
    const [name, value] = part.split("=").map((p) => p.trim());

    // Check cookie name and value
    if (
      name?.toLowerCase().includes(searchValue.toLowerCase()) ||
      value?.toLowerCase().includes(searchValue.toLowerCase())
    ) {
      return true;
    }

    // Check for exact value match (useful for tokens)
    if (name === searchValue || value === searchValue) {
      return true;
    }
  }

  return false;
}
