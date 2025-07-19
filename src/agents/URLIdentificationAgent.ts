import { getLLMClient, type LLMClient } from "../core/LLMClient.js";
import type { FunctionDefinition } from "../core/providers/types.js";
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
  harUrls: URLInfo[],
  llmClient?: LLMClient
): Promise<string> {
  if (!harUrls || harUrls.length === 0) {
    throw new HarvestError(
      "No URLs available for analysis",
      "NO_URLS_AVAILABLE"
    );
  }

  try {
    const client = llmClient || getLLMClient();

    // Pre-filter and sort URLs to increase chances of getting a good result
    const filteredUrls = filterApiUrls(harUrls);
    const sortedUrls = sortUrlsByRelevance(
      filteredUrls.length > 0 ? filteredUrls : harUrls,
      session.prompt
    );

    // If we only have one URL, return it without LLM call
    if (sortedUrls.length === 1 && sortedUrls[0]) {
      return sortedUrls[0].url;
    }

    const functionDef = createFunctionDefinition(session.prompt);
    const prompt = createPrompt(session.prompt, sortedUrls);

    const response = await client.callFunction<URLIdentificationResponse>(
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
    const sortedUrls = sortUrlsByRelevance(
      filterApiUrls(harUrls),
      session.prompt
    );
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
 * Create the prompt for LLM analysis with enhanced semantic action matching
 */
function createPrompt(userPrompt: string, harUrls: URLInfo[]): string {
  const formattedUrls = formatURLsForPrompt(harUrls);
  const actionAnalysis = analyzePromptAction(userPrompt);

  return `${formattedUrls}

Task:
Find the URL that semantically matches the user's primary action described below:
"${userPrompt}"

Action Analysis:
${actionAnalysis}

Instructions:
- PRIORITIZE endpoints that semantically match the primary action described in the user prompt
- Look for URL path segments that directly relate to the action (e.g., "pesquisa" for search, "login" for authentication)
- Consider both English and non-English path segments (Portuguese, Spanish, etc.)
- GET requests are appropriate for search/query/retrieval actions
- POST requests are appropriate for create/update/submit actions
- Focus on the PRIMARY workflow endpoint, not auxiliary actions (avoid "copy", "share", "export" unless specifically requested)
- If the prompt mentions searching/querying/finding, prefer endpoints with search-related path segments
- Return the exact URL as it appears in the list above that best matches the PRIMARY action intent`;
}

/**
 * Analyze the user prompt to identify the primary action and provide guidance for URL selection
 */
function analyzePromptAction(prompt: string): string {
  const promptLower = prompt.toLowerCase();
  const analysis: string[] = [];

  // Detect primary action type
  if (
    promptLower.includes("search") ||
    promptLower.includes("pesquisa") ||
    promptLower.includes("buscar") ||
    promptLower.includes("find") ||
    promptLower.includes("query") ||
    promptLower.includes("consulta")
  ) {
    analysis.push(
      "Primary action: SEARCH/QUERY - Look for endpoints with search-related paths like '/pesquisa', '/search', '/query'"
    );
  } else if (
    promptLower.includes("login") ||
    promptLower.includes("auth") ||
    promptLower.includes("sign in") ||
    promptLower.includes("entrar")
  ) {
    analysis.push(
      "Primary action: AUTHENTICATION - Look for endpoints with auth-related paths like '/login', '/auth', '/signin'"
    );
  } else if (
    promptLower.includes("create") ||
    promptLower.includes("criar") ||
    promptLower.includes("add") ||
    promptLower.includes("novo") ||
    promptLower.includes("submit") ||
    promptLower.includes("enviar")
  ) {
    analysis.push(
      "Primary action: CREATE/SUBMIT - Look for POST endpoints that create or submit data"
    );
  } else if (
    promptLower.includes("update") ||
    promptLower.includes("atualizar") ||
    promptLower.includes("edit") ||
    promptLower.includes("modify")
  ) {
    analysis.push(
      "Primary action: UPDATE - Look for PUT/PATCH endpoints that modify existing data"
    );
  } else if (
    promptLower.includes("delete") ||
    promptLower.includes("deletar") ||
    promptLower.includes("remove") ||
    promptLower.includes("remover")
  ) {
    analysis.push(
      "Primary action: DELETE - Look for DELETE endpoints that remove data"
    );
  } else {
    analysis.push(
      "Primary action: GENERAL - Analyze the prompt for the most important workflow step"
    );
  }

  // Extract key domain terms
  const domainTerms = [];
  const keywordPatterns = [
    "jurisprudencia",
    "legal",
    "tribunal",
    "processo",
    "decisao",
    "acordao",
    "document",
    "file",
    "data",
    "user",
    "account",
    "profile",
    "order",
    "product",
  ];

  for (const term of keywordPatterns) {
    if (promptLower.includes(term)) {
      domainTerms.push(term);
    }
  }

  if (domainTerms.length > 0) {
    analysis.push(
      `Domain context: ${domainTerms.join(", ")} - Look for URLs containing these domain-specific terms`
    );
  }

  // Add specific guidance
  analysis.push(
    "IMPORTANT: Choose the endpoint that represents the MAIN action, not secondary operations like copying or exporting results"
  );

  return analysis.join("\n");
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
 * Sort URLs by relevance for action identification with prompt-aware keyword scoring
 */
export function sortUrlsByRelevance(
  harUrls: URLInfo[],
  prompt?: string
): URLInfo[] {
  return [...harUrls].sort((a, b) => {
    // Calculate keyword relevance scores based on prompt
    const aKeywordScore = calculateKeywordRelevance(a.url, prompt);
    const bKeywordScore = calculateKeywordRelevance(b.url, prompt);

    // Keyword relevance takes highest priority
    if (aKeywordScore !== bKeywordScore) {
      return bKeywordScore - aKeywordScore; // Higher score first
    }

    // Method priority (now more balanced for search endpoints)
    const methodPriority: Record<string, number> = {
      POST: 1,
      PUT: 2,
      PATCH: 3,
      DELETE: 4,
      GET: 3, // Elevated GET priority for search/query endpoints
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

/**
 * Calculate keyword relevance score for URL based on user prompt
 * Higher scores indicate better semantic match with the user's intent
 */
function calculateKeywordRelevance(url: string, prompt?: string): number {
  if (!prompt) {
    return 0;
  }

  let score = 0;
  const urlLower = url.toLowerCase();
  const promptLower = prompt.toLowerCase();

  // Multi-language action keywords with weighted scores
  const actionKeywords = {
    // Search/Query actions (high weight for GET endpoints)
    search: 10,
    pesquisa: 10,
    buscar: 10,
    consulta: 10,
    query: 10,
    find: 10,
    // CRUD operations
    create: 8,
    criar: 8,
    novo: 8,
    new: 8,
    add: 8,
    update: 8,
    atualizar: 8,
    modify: 8,
    edit: 8,
    delete: 8,
    deletar: 8,
    remove: 8,
    remover: 8,
    // Data retrieval
    get: 6,
    obter: 6,
    fetch: 6,
    retrieve: 6,
    list: 6,
    listar: 6,
    // Document/content actions
    copy: 7,
    copiar: 7,
    download: 7,
    export: 7,
    print: 7,
    view: 5,
    visualizar: 5,
    show: 5,
    display: 5,
    // Authentication/session
    login: 6,
    auth: 6,
    authenticate: 6,
    session: 4,
  };

  // Application-specific keywords (moderate weight)
  const domainKeywords = {
    jurisprudencia: 8,
    decision: 6,
    document: 6,
    documento: 6,
    citation: 6,
    citacao: 6,
    legal: 5,
    tribunal: 7,
    processo: 6,
    case: 6,
    judgment: 6,
    acordao: 7,
  };

  // Check for action keywords in both prompt and URL
  for (const [keyword, weight] of Object.entries(actionKeywords)) {
    if (promptLower.includes(keyword) && urlLower.includes(keyword)) {
      score += weight * 2; // Bonus for matching in both prompt and URL
    } else if (promptLower.includes(keyword)) {
      // Look for semantic matches in URL path segments
      const urlSegments = url.split("/").map((seg) => seg.toLowerCase());
      if (
        urlSegments.some(
          (seg) => seg.includes(keyword) || keyword.includes(seg)
        )
      ) {
        score += weight;
      }
    }
  }

  // Check for domain-specific keywords
  for (const [keyword, weight] of Object.entries(domainKeywords)) {
    if (promptLower.includes(keyword) && urlLower.includes(keyword)) {
      score += weight;
    }
  }

  // Bonus for exact path segment matches with prompt keywords
  const urlPathSegments = url.split("/").filter((seg) => seg.length > 2);
  const promptWords = promptLower
    .split(/\s+/)
    .filter((word) => word.length > 2);

  for (const segment of urlPathSegments) {
    for (const word of promptWords) {
      if (
        segment.toLowerCase() === word ||
        segment.toLowerCase().includes(word)
      ) {
        score += 5;
      }
    }
  }

  // Penalty for auxiliary/secondary actions (lower priority)
  const secondaryActions = ["copiar", "copy", "duplicate", "share", "export"];
  for (const action of secondaryActions) {
    if (urlLower.includes(action) && !promptLower.includes(action)) {
      score -= 3; // Reduce priority for auxiliary actions not mentioned in prompt
    }
  }

  return score;
}
