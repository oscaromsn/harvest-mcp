import type { FunctionDefinition } from "openai/resources/shared";
import { getLLMClient } from "../core/LLMClient.js";
import type {
  HarvestSession,
  URLIdentificationResponse,
  URLInfo,
} from "../types/index.js";
import { HarvestError } from "../types/index.js";
import { createComponentLogger } from "../utils/logger.js";

const logger = createComponentLogger("url-identification-agent");

/**
 * Identify the URL responsible for a specific action using LLM analysis
 */
export async function identifyEndUrl(
  session: HarvestSession,
  harUrls: URLInfo[]
): Promise<string> {
  if (!harUrls || harUrls.length === 0) {
    throw new HarvestError(
      "No URLs available for analysis",
      "NO_URLS_AVAILABLE"
    );
  }

  try {
    const llmClient = getLLMClient();

    // Pre-filter and sort URLs to increase chances of getting a good result
    const filteredUrls = filterApiUrls(harUrls);
    const sortedUrls = sortUrlsByRelevance(
      filteredUrls.length > 0 ? filteredUrls : harUrls
    );

    // If we only have one URL, return it without LLM call
    if (sortedUrls.length === 1 && sortedUrls[0]) {
      return sortedUrls[0].url;
    }

    const functionDef = createFunctionDefinition(session.prompt);
    const prompt = createPrompt(session.prompt, sortedUrls);

    const response = await llmClient.callFunction<URLIdentificationResponse>(
      prompt,
      functionDef,
      "identify_end_url"
    );

    const identifiedUrl = response.url;

    // Validate that the identified URL exists in the HAR data
    const urlExists = harUrls.some((urlInfo) => urlInfo.url === identifiedUrl);
    if (!urlExists) {
      // Fallback: return the first API URL if identification failed
      const fallbackUrl = sortedUrls[0]?.url;
      if (fallbackUrl) {
        logger.warn(
          { identifiedUrl, fallbackUrl },
          "LLM identified non-existent URL, using fallback"
        );
        return fallbackUrl;
      }

      throw new HarvestError(
        `Identified URL ${identifiedUrl} not found in HAR data`,
        "URL_NOT_FOUND_IN_HAR",
        { identifiedUrl, availableUrls: harUrls.map((u) => u.url) }
      );
    }

    return identifiedUrl;
  } catch (error) {
    if (error instanceof HarvestError) {
      throw error;
    }

    // Fallback strategy: if LLM fails, try to use the most likely URL
    const sortedUrls = sortUrlsByRelevance(filterApiUrls(harUrls));
    if (sortedUrls.length > 0 && sortedUrls[0]) {
      const fallbackUrl = sortedUrls[0].url;
      logger.warn({ fallbackUrl }, "LLM call failed, using fallback URL");
      return fallbackUrl;
    }

    throw new HarvestError(
      `URL identification failed: ${error instanceof Error ? error.message : "Unknown error"}`,
      "URL_IDENTIFICATION_FAILED",
      { originalError: error }
    );
  }
}

/**
 * Create the OpenAI function definition for URL identification
 */
export function createFunctionDefinition(prompt: string): FunctionDefinition {
  return {
    name: "identify_end_url",
    description: "Identify the URL responsible for a specific action",
    parameters: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: `The URL responsible for ${prompt}`,
        },
      },
      required: ["url"],
    },
  };
}

/**
 * Create the prompt for LLM analysis
 */
function createPrompt(userPrompt: string, harUrls: URLInfo[]): string {
  const formattedUrls = formatURLsForPrompt(harUrls);

  return `${formattedUrls}

Task:
Given the above list of URLs, request types, and response formats, find the URL responsible for the action below:
${userPrompt}

Instructions:
- Analyze each URL and determine which one is most likely responsible for the specified action
- Consider the HTTP method (POST for actions, GET for data retrieval)
- Prioritize API endpoints over static resources
- Look for meaningful path segments that relate to the action
- Return the exact URL as it appears in the list above`;
}

/**
 * Format URLs for LLM consumption
 */
export function formatURLsForPrompt(harUrls: URLInfo[]): string {
  if (harUrls.length === 0) {
    return "No URLs available for analysis.";
  }

  const formatted = harUrls
    .map((urlInfo, index) => {
      return `${index + 1}. ${urlInfo.method} ${urlInfo.url} (Request: ${urlInfo.requestType}, Response: ${urlInfo.responseType})`;
    })
    .join("\n");

  return `Available URLs from HAR file:\n${formatted}`;
}

/**
 * Validate a URL against the available HAR URLs
 */
export function validateUrl(url: string, harUrls: URLInfo[]): boolean {
  return harUrls.some((urlInfo) => urlInfo.url === url);
}

/**
 * Get URLs filtered by criteria (e.g., only API endpoints)
 */
export function filterApiUrls(harUrls: URLInfo[]): URLInfo[] {
  return harUrls.filter((urlInfo) => {
    const url = urlInfo.url.toLowerCase();

    // Prioritize API endpoints
    if (url.includes("/api/") || url.includes("/v1/") || url.includes("/v2/")) {
      return true;
    }

    // Include JSON responses
    if (urlInfo.responseType.toLowerCase().includes("json")) {
      return true;
    }

    // Include POST/PUT/DELETE methods (more likely to be actions)
    if (
      ["POST", "PUT", "DELETE", "PATCH"].includes(urlInfo.method.toUpperCase())
    ) {
      return true;
    }

    // Exclude static resources
    const staticExtensions = [
      ".js",
      ".css",
      ".png",
      ".jpg",
      ".jpeg",
      ".gif",
      ".svg",
      ".ico",
      ".woff",
      ".woff2",
    ];
    if (staticExtensions.some((ext) => url.endsWith(ext))) {
      return false;
    }

    return true;
  });
}

/**
 * Sort URLs by relevance for action identification
 */
export function sortUrlsByRelevance(harUrls: URLInfo[]): URLInfo[] {
  return [...harUrls].sort((a, b) => {
    // Prioritize POST/PUT/DELETE over GET
    const methodPriority: Record<string, number> = {
      POST: 1,
      PUT: 2,
      PATCH: 3,
      DELETE: 4,
      GET: 5,
      OPTIONS: 6,
      HEAD: 7,
    };

    const aPriority = methodPriority[a.method.toUpperCase()] || 10;
    const bPriority = methodPriority[b.method.toUpperCase()] || 10;

    if (aPriority !== bPriority) {
      return aPriority - bPriority;
    }

    // Prioritize API paths
    const aIsApi = a.url.includes("/api/");
    const bIsApi = b.url.includes("/api/");

    if (aIsApi && !bIsApi) {
      return -1;
    }
    if (!aIsApi && bIsApi) {
      return 1;
    }

    // Prioritize JSON responses
    const aIsJson = a.responseType.toLowerCase().includes("json");
    const bIsJson = b.responseType.toLowerCase().includes("json");

    if (aIsJson && !bIsJson) {
      return -1;
    }
    if (!aIsJson && bIsJson) {
      return 1;
    }

    return 0;
  });
}
