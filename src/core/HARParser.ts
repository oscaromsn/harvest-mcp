import { readFile } from "node:fs/promises";
import type {
  Har,
  Header as HarHeader,
  PostData as HarPostData,
  QueryString as HarQueryString,
  Request as HarRequest,
  Response as HarResponse,
} from "har-format";
import { Request } from "../models/Request.js";
import type {
  ParsedHARData,
  RequestModel,
  ResponseData,
  URLInfo,
} from "../types/index.js";

// Keywords to exclude from requests (analytics, tracking, etc.)
const EXCLUDED_KEYWORDS = [
  "google",
  "taboola",
  "datadog",
  "sentry",
  "facebook",
  "twitter",
  "linkedin",
  "amplitude",
  "mixpanel",
  "segment",
  "heap",
  "hotjar",
  "fullstory",
  "pendo",
  "optimizely",
  "adobe",
  "analytics",
  "tracking",
  "telemetry",
  "clarity",
  "matomo",
  "plausible",
];

// Headers to exclude from request processing
const EXCLUDED_HEADER_KEYWORDS = [
  "cookie",
  "sec-",
  "accept",
  "user-agent",
  "referer",
  "relic",
  "sentry",
  "datadog",
  "amplitude",
  "mixpanel",
  "segment",
  "heap",
  "hotjar",
  "fullstory",
  "pendo",
  "optimizely",
  "adobe",
  "analytics",
  "tracking",
  "telemetry",
  "clarity",
  "matomo",
  "plausible",
];

/**
 * Check if a request is an API request based on URL patterns and headers
 */
function isApiRequest(request: HarRequest, response: HarResponse): boolean {
  return (
    request.url.includes("/api/") ||
    request.url.includes("/v1/") ||
    request.url.includes("/v2/") ||
    response?.headers?.some(
      (h: HarHeader) =>
        h.name?.toLowerCase() === "content-type" &&
        h.value?.includes("application/json")
    )
  );
}

/**
 * Check if a request is a modifying operation (POST, PUT, DELETE, PATCH)
 */
function isModifyingRequest(request: HarRequest): boolean {
  return ["POST", "PUT", "DELETE", "PATCH"].includes(
    request.method?.toUpperCase() || ""
  );
}

interface HARStats {
  totalEntries: number;
  relevantEntries: number;
  apiRequests: number;
  postRequests: number;
  responsesWithContent: number;
}

/**
 * Assess quality based on captured statistics
 */
function assessQuality(
  stats: HARStats
): "excellent" | "good" | "poor" | "empty" {
  if (stats.relevantEntries === 0) {
    return "empty";
  }
  if (stats.apiRequests >= 3 || stats.postRequests >= 2) {
    return "excellent";
  }
  if (stats.relevantEntries >= 5 || stats.apiRequests >= 1) {
    return "good";
  }
  return "poor";
}

/**
 * Add quality-specific recommendations
 */
function addQualityRecommendations(
  quality: string,
  _stats: HARStats,
  issues: string[],
  recommendations: string[]
): void {
  if (quality === "empty") {
    issues.push(
      "No relevant network requests found (only tracking/analytics requests)"
    );
    recommendations.push(
      "Try interacting more with the website's main functionality"
    );
    recommendations.push(
      "Look for forms to submit, buttons to click, or data to load"
    );
  } else if (quality === "poor") {
    issues.push("Very few meaningful requests captured");
    recommendations.push(
      "Try to capture more interactions like form submissions or data loading"
    );
    recommendations.push(
      "Ensure you complete the full workflow you want to automate"
    );
  }
}

/**
 * Add specific recommendations based on request analysis
 */
function addSpecificRecommendations(
  stats: HARStats,
  quality: string,
  recommendations: string[]
): void {
  if (stats.apiRequests === 0 && quality !== "empty") {
    recommendations.push(
      "No API requests detected - try looking for data loading or AJAX calls"
    );
  }

  if (stats.postRequests === 0 && quality !== "empty") {
    recommendations.push(
      "No POST requests found - try submitting forms or creating/updating data"
    );
  }

  if (stats.responsesWithContent === 0 && quality !== "empty") {
    recommendations.push(
      "No response content captured - check if responses contain meaningful data"
    );
  }
}

/**
 * Validate HAR file content quality and provide actionable feedback
 */
export function validateHARContent(harData: Har): {
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
  };
} {
  const issues: string[] = [];
  const recommendations: string[] = [];
  const entries = harData.log?.entries || [];

  const stats = {
    totalEntries: entries.length,
    relevantEntries: 0,
    apiRequests: 0,
    postRequests: 0,
    responsesWithContent: 0,
  };

  // Basic structure validation
  if (!harData.log) {
    issues.push("HAR file is missing 'log' property");
    return {
      isValid: false,
      quality: "empty",
      issues,
      recommendations: [
        "Please ensure you're exporting a valid HAR file from browser dev tools",
      ],
      stats,
    };
  }

  if (entries.length === 0) {
    issues.push("HAR file contains no network requests");
    recommendations.push(
      "Ensure you interact with the website to generate network traffic before exporting HAR"
    );
    recommendations.push(
      "Check that network recording was enabled in browser dev tools"
    );
    return {
      isValid: false,
      quality: "empty",
      issues,
      recommendations,
      stats,
    };
  }

  // Analyze request quality
  for (const entry of entries) {
    const request = entry.request;
    const response = entry.response;

    if (!request?.url) {
      continue;
    }

    // Skip excluded requests for quality analysis
    if (shouldExcludeRequest(request.url)) {
      continue;
    }

    stats.relevantEntries++;

    // Check for API-like requests
    if (isApiRequest(request, response)) {
      stats.apiRequests++;
    }

    // Check for POST/PUT/DELETE requests (more likely to be meaningful)
    if (isModifyingRequest(request)) {
      stats.postRequests++;
    }

    // Check for responses with meaningful content
    if (response?.content?.text && response.content.text.length > 0) {
      stats.responsesWithContent++;
    }
  }

  // Quality assessment
  const quality = assessQuality(stats);

  // Add quality-specific recommendations
  addQualityRecommendations(quality, stats, issues, recommendations);

  // Add specific recommendations based on findings
  addSpecificRecommendations(stats, quality, recommendations);

  return {
    isValid: stats.relevantEntries > 0,
    quality,
    issues,
    recommendations,
    stats,
  };
}

/**
 * Parse a HAR file and extract relevant request data with validation
 */
export async function parseHARFile(harPath: string): Promise<
  ParsedHARData & {
    validation: ReturnType<typeof validateHARContent>;
  }
> {
  try {
    const harContent = await readFile(harPath, "utf-8");
    const harData = JSON.parse(harContent) as Har;

    // Validate HAR content quality
    const validation = validateHARContent(harData);

    if (!harData.log || !harData.log.entries) {
      throw new Error("Invalid HAR file format: missing log.entries");
    }

    const entries = harData.log.entries;
    const requests: RequestModel[] = [];
    const urls: URLInfo[] = [];

    for (const entry of entries) {
      const request = entry.request;
      const response = entry.response;

      if (!request || !request.url) {
        continue;
      }

      // Filter out excluded requests
      if (shouldExcludeRequest(request.url)) {
        continue;
      }

      // Parse request with timestamp from entry
      const requestModel = formatRequest(request);

      // Add timestamp from entry
      if (entry.startedDateTime) {
        requestModel.timestamp = new Date(entry.startedDateTime);
      }

      // Add response data if available
      if (response) {
        requestModel.response = formatResponse(response);
      }

      requests.push(requestModel);

      // Extract URL info
      urls.push({
        method: request.method || "GET",
        url: request.url,
        requestType: getRequestType(request),
        responseType: getResponseType(response),
      });
    }

    // Filter and sort requests
    const filteredRequests = filterRequests(requests);

    return {
      requests: filteredRequests,
      urls: extractURLs(urls),
      validation,
    };
  } catch (error) {
    throw new Error(
      `Failed to parse HAR file: ${error instanceof Error ? error.message : "Unknown error"}`
    );
  }
}

/**
 * Parse and filter request headers
 */
function parseRequestHeaders(
  harHeaders: HarHeader[] | undefined
): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const header of harHeaders || []) {
    const headerName = header.name?.toLowerCase() || "";
    const shouldExclude = EXCLUDED_HEADER_KEYWORDS.some((keyword) =>
      headerName.includes(keyword.toLowerCase())
    );

    if (!shouldExclude && header.name && header.value) {
      headers[header.name] = header.value;
    }
  }
  return headers;
}

/**
 * Parse query string parameters
 */
function parseQueryParams(
  queryString: HarQueryString[] | undefined
): Record<string, string> {
  const queryParams: Record<string, string> = {};
  for (const param of queryString || []) {
    if (param.name && param.value !== undefined) {
      queryParams[param.name] = param.value;
    }
  }
  return queryParams;
}

/**
 * Parse request body from postData
 */
function parseRequestBody(postData: HarPostData | undefined): unknown {
  if (!postData) {
    return undefined;
  }

  if (postData.text) {
    try {
      return JSON.parse(postData.text);
    } catch {
      return postData.text;
    }
  }

  if (postData.params) {
    const formData: Record<string, string> = {};
    for (const param of postData.params) {
      if (param.name && param.value !== undefined) {
        formData[param.name] = param.value;
      }
    }
    return formData;
  }

  return undefined;
}

/**
 * Format a HAR request into our RequestModel
 */
export function formatRequest(harRequest: HarRequest): RequestModel {
  const method = harRequest.method || "GET";
  const url = harRequest.url || "";
  const headers = parseRequestHeaders(harRequest.headers);
  const queryParams = parseQueryParams(harRequest.queryString);
  const body = parseRequestBody(harRequest.postData);

  return new Request(
    method as string,
    url as string,
    headers,
    Object.keys(queryParams).length > 0 ? queryParams : undefined,
    body
  );
}

/**
 * Format a HAR response into our ResponseData
 */
export function formatResponse(harResponse: HarResponse): ResponseData {
  const status = harResponse.status || 0;
  const statusText = harResponse.statusText || "";

  // Parse response headers
  const headers: Record<string, string> = {};
  for (const header of harResponse.headers || []) {
    if (header.name && header.value) {
      headers[header.name] = header.value;
    }
  }

  // Parse response content
  let text: string | undefined = undefined;
  let json: unknown = undefined;

  if (harResponse.content?.text) {
    text = harResponse.content.text;

    // Try to parse as JSON if content type suggests it
    const contentType =
      headers["content-type"] || headers["Content-Type"] || "";
    if (
      contentType.includes("application/json") ||
      contentType.includes("text/json")
    ) {
      try {
        json = JSON.parse(text);
      } catch {
        // If JSON parsing fails, keep as text
      }
    }
  }

  const result: ResponseData = {
    status,
    statusText,
    headers,
  };

  if (text !== undefined) {
    result.text = text;
  }

  if (json !== undefined) {
    result.json = json;
  }

  return result;
}

/**
 * Filter requests to remove irrelevant ones
 */
export function filterRequests(requests: RequestModel[]): RequestModel[] {
  return requests.filter((request) => {
    // Filter by URL
    if (shouldExcludeRequest(request.url)) {
      return false;
    }

    // Filter by method (keep most HTTP methods, exclude OPTIONS preflight)
    if (request.method === "OPTIONS") {
      return false;
    }

    // Filter by content type (exclude images, stylesheets, etc.)
    const contentType =
      request.headers["content-type"] || request.headers["Content-Type"] || "";
    if (
      contentType.includes("image/") ||
      contentType.includes("text/css") ||
      contentType.includes("application/javascript") ||
      contentType.includes("font/")
    ) {
      return false;
    }

    return true;
  });
}

/**
 * Extract and clean URL information
 */
export function extractURLs(urlInfos: URLInfo[]): URLInfo[] {
  // Remove duplicates and sort by relevance
  const uniqueUrls = new Map<string, URLInfo>();

  for (const urlInfo of urlInfos) {
    const key = `${urlInfo.method}:${urlInfo.url}`;
    if (!uniqueUrls.has(key)) {
      uniqueUrls.set(key, urlInfo);
    }
  }

  return Array.from(uniqueUrls.values())
    .filter((urlInfo) => !shouldExcludeRequest(urlInfo.url))
    .sort((a, b) => {
      // Prioritize API endpoints
      const aIsApi = a.url.includes("/api/") || a.responseType.includes("json");
      const bIsApi = b.url.includes("/api/") || b.responseType.includes("json");

      if (aIsApi && !bIsApi) {
        return -1;
      }
      if (!aIsApi && bIsApi) {
        return 1;
      }

      // Then prioritize POST/PUT/DELETE over GET
      const methodPriority = { POST: 0, PUT: 1, DELETE: 2, GET: 3 };
      const aPriority =
        methodPriority[a.method as keyof typeof methodPriority] ?? 4;
      const bPriority =
        methodPriority[b.method as keyof typeof methodPriority] ?? 4;

      return aPriority - bPriority;
    });
}

/**
 * Check if a request should be excluded based on URL
 */
function shouldExcludeRequest(url: string): boolean {
  const lowerUrl = url.toLowerCase();

  return EXCLUDED_KEYWORDS.some((keyword) =>
    lowerUrl.includes(keyword.toLowerCase())
  );
}

/**
 * Determine request type from request data
 */
function getRequestType(request: HarRequest): string {
  if (request.postData) {
    const contentType =
      (request.headers as Array<{ name: string; value: string }>)?.find(
        (h) => h.name?.toLowerCase() === "content-type"
      )?.value || "";

    if (contentType.includes("application/json")) {
      return "JSON";
    }
    if (contentType.includes("application/x-www-form-urlencoded")) {
      return "Form";
    }
    return "Data";
  }

  return "Query";
}

/**
 * Determine response type from response data
 */
function getResponseType(response: HarResponse | null): string {
  if (!response) {
    return "Unknown";
  }

  const contentType =
    (response.headers as Array<{ name: string; value: string }>)?.find(
      (h) => h.name?.toLowerCase() === "content-type"
    )?.value || "";

  if (contentType.includes("application/json")) {
    return "JSON";
  }
  if (contentType.includes("text/html")) {
    return "HTML";
  }
  if (contentType.includes("text/")) {
    return "Text";
  }
  return "Binary";
}
