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
      // Enhanced fallback: use the highest-scoring URL from heuristic analysis
      const fallbackUrl = sortedUrls[0]?.url;
      if (fallbackUrl && sortedUrls[0]) {
        logger.warn(
          {
            identifiedUrl,
            fallbackUrl,
            fallbackScore: calculateComprehensiveRelevanceScore(
              sortedUrls[0],
              session.prompt
            ),
            availableCount: harUrls.length,
          },
          "LLM identified non-existent URL, using highest-scoring heuristic candidate"
        );
        return fallbackUrl;
      }

      // If even the fallback fails, provide detailed error information
      const topCandidates = sortedUrls.slice(0, 3).map((url) => ({
        url: url.url,
        score: calculateComprehensiveRelevanceScore(url, session.prompt),
        method: url.method,
        paramCount: (url.url.split("?")[1] || "").split("&").filter((p) => p)
          .length,
      }));

      throw new HarvestError(
        `URL identification failed: LLM returned non-existent URL "${identifiedUrl}". Available top candidates based on heuristic analysis: ${topCandidates.map((c) => `${c.url} (score: ${c.score.toFixed(1)})`).join(", ")}`,
        "URL_NOT_FOUND_IN_HAR",
        {
          identifiedUrl,
          availableUrls: harUrls.map((u) => u.url),
          topCandidates,
          suggestedAction:
            "Use debug_set_master_node with one of the top candidates, or re-run analysis with autoFix=true",
        }
      );
    }

    return identifiedUrl;
  } catch (error) {
    if (error instanceof HarvestError) {
      throw error;
    }

    // Enhanced fallback strategy: if LLM fails, try to use the most likely URL with detailed logging
    const fallbackUrls = sortUrlsByRelevance(
      filterApiUrls(harUrls),
      session.prompt
    );

    if (fallbackUrls.length > 0 && fallbackUrls[0]) {
      const fallbackUrl = fallbackUrls[0].url;
      const fallbackScore = calculateComprehensiveRelevanceScore(
        fallbackUrls[0],
        session.prompt
      );

      // Provide detailed fallback information for debugging
      const fallbackContext = {
        chosenUrl: fallbackUrl,
        score: fallbackScore,
        reasoning: getUrlReasoningText(fallbackUrls[0], session.prompt),
        alternativesCount: fallbackUrls.length - 1,
        topAlternatives: fallbackUrls.slice(1, 4).map((url) => ({
          url: url.url,
          score: calculateComprehensiveRelevanceScore(url, session.prompt),
        })),
      };

      logger.warn(
        {
          fallbackUrl,
          fallbackContext,
          originalError:
            error instanceof Error ? error.message : "Unknown error",
        },
        "LLM call failed, using highest-scoring heuristic fallback"
      );

      return fallbackUrl;
    }

    // Create detailed error with suggestions if no fallback is available
    const availableUrls = harUrls.map((u) => u.url);
    const errorContext = {
      originalError: error,
      availableUrls,
      urlCount: harUrls.length,
      hasApiUrls: harUrls.some((u) => u.url.toLowerCase().includes("/api/")),
      suggestions: [
        "Check if HAR file contains valid API endpoints",
        "Verify that the HAR file was captured during the target workflow",
        "Consider using debug_list_all_requests to inspect available URLs",
        "Try manual URL selection with debug_set_master_node",
      ],
    };

    throw new HarvestError(
      `URL identification completely failed: ${error instanceof Error ? error.message : "Unknown error"}. No suitable fallback URLs found among ${harUrls.length} available URLs.`,
      "URL_IDENTIFICATION_FAILED",
      errorContext
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
 * Create the prompt for LLM analysis with enhanced semantic action matching and heuristic guidance
 */
function createPrompt(userPrompt: string, harUrls: URLInfo[]): string {
  const formattedUrls = formatURLsForPrompt(harUrls);
  const actionAnalysis = analyzePromptAction(userPrompt);
  const heuristicRanking = getHeuristicRanking(harUrls, userPrompt);

  return `${formattedUrls}

Task:
Find the URL that semantically matches the user's primary action described below:
"${userPrompt}"

Action Analysis:
${actionAnalysis}

Heuristic Analysis Top Candidates:
${heuristicRanking}

Enhanced Instructions:
- PRIORITIZE endpoints that semantically match the primary action described in the user prompt
- Look for URL path segments that directly relate to the action (e.g., "pesquisa" for search, "login" for authentication)
- Consider both English and non-English path segments (Portuguese, Spanish, etc.)
- For search/query actions, prefer URLs with MORE query parameters, especially those with search terms, filters, and pagination
- GET requests are appropriate for search/query/retrieval actions
- POST requests are appropriate for create/update/submit actions
- Focus on the PRIMARY workflow endpoint, not auxiliary actions (avoid "copy", "share", "export" unless specifically requested)
- If multiple URLs contain similar path segments, choose the one with the most comprehensive parameter set
- Pay attention to the heuristic ranking above - it considers parameter complexity and domain-specific patterns
- Return the exact URL as it appears in the list above that best matches the PRIMARY action intent

CRITICAL: If this is a search/query action, choose the URL with the most filtering and search parameters, not the simplest one.`;
}

/**
 * Generate heuristic ranking summary for LLM guidance
 */
function getHeuristicRanking(harUrls: URLInfo[], prompt?: string): string {
  const sortedUrls = sortUrlsByRelevance(harUrls, prompt);
  const topCandidates = sortedUrls.slice(0, 5); // Show top 5

  if (topCandidates.length === 0) {
    return "No strong candidates identified by heuristic analysis.";
  }

  const rankings = topCandidates
    .map((urlInfo, index) => {
      const score = calculateComprehensiveRelevanceScore(urlInfo, prompt);
      const paramCount = (urlInfo.url.split("?")[1] || "")
        .split("&")
        .filter((p) => p).length;

      return `${index + 1}. ${urlInfo.url} 
   - Score: ${score.toFixed(1)}
   - Parameters: ${paramCount}
   - Method: ${urlInfo.method}
   - Reasoning: ${getUrlReasoningText(urlInfo, prompt)}`;
    })
    .join("\n\n");

  return `Based on comprehensive scoring (keyword relevance, API patterns, parameter complexity):
${rankings}

The top-ranked URL typically represents the most complex and feature-rich endpoint, which is often the primary action URL for search/query operations.`;
}

/**
 * Generate reasoning text for why a URL was ranked highly
 */
function getUrlReasoningText(urlInfo: URLInfo, prompt?: string): string {
  const reasons: string[] = [];
  const url = urlInfo.url.toLowerCase();
  const promptLower = prompt?.toLowerCase() || "";

  // Check for API patterns
  if (url.includes("/api/")) {
    reasons.push("REST API endpoint");
  }
  if (url.includes("/pesquisa")) {
    reasons.push("Portuguese search endpoint");
  }
  if (url.includes("/search")) {
    reasons.push("Search endpoint");
  }

  // Check for parameter richness
  const paramCount = (urlInfo.url.split("?")[1] || "")
    .split("&")
    .filter((p) => p).length;
  if (paramCount > 5) {
    reasons.push(`Rich parameter set (${paramCount} params)`);
  }

  // Check for domain-specific terms
  if (promptLower.includes("search") || promptLower.includes("pesquisa")) {
    if (url.includes("pesquisa") || url.includes("search")) {
      reasons.push("Matches search intent");
    }
  }

  if (urlInfo.responseType.toLowerCase().includes("json")) {
    reasons.push("JSON response (API)");
  }

  return reasons.length > 0 ? reasons.join(", ") : "Standard endpoint";
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
 * Enhanced with API pattern recognition and parameter complexity analysis
 */
export function sortUrlsByRelevance(
  harUrls: URLInfo[],
  prompt?: string
): URLInfo[] {
  return [...harUrls].sort((a, b) => {
    // Calculate comprehensive relevance scores
    const aScore = calculateComprehensiveRelevanceScore(a, prompt);
    const bScore = calculateComprehensiveRelevanceScore(b, prompt);

    // Higher comprehensive score wins
    return bScore - aScore;
  });
}

/**
 * Calculate comprehensive relevance score including multiple factors
 */
function calculateComprehensiveRelevanceScore(
  urlInfo: URLInfo,
  prompt?: string
): number {
  let totalScore = 0;

  // Factor 1: Keyword relevance (highest weight)
  const keywordScore = calculateKeywordRelevance(urlInfo.url, prompt);
  totalScore += keywordScore * 3; // High weight multiplier

  // Factor 2: API pattern recognition
  const apiPatternScore = calculateApiPatternScore(urlInfo.url);
  totalScore += apiPatternScore * 2;

  // Factor 3: Parameter complexity (more parameters = likely main endpoint)
  const parameterScore = calculateParameterComplexityScore(urlInfo.url);
  totalScore += parameterScore * 1.5;

  // Factor 4: HTTP method appropriateness
  const methodScore = calculateMethodScore(urlInfo.method, prompt);
  totalScore += methodScore;

  // Factor 5: Response type preference
  const responseScore = calculateResponseTypeScore(urlInfo.responseType);
  totalScore += responseScore * 0.8;

  return totalScore;
}

/**
 * Calculate API pattern recognition score
 */
export function calculateApiPatternScore(url: string): number {
  const urlLower = url.toLowerCase();
  let score = 0;

  // API path patterns (higher score for more specific API patterns)
  const apiPatterns = [
    { pattern: /\/api\/v\d+\//, score: 15 }, // Versioned API
    { pattern: /\/api\/[^/]*\/\w+/, score: 12 }, // API with resource
    { pattern: /\/api\//, score: 8 }, // Basic API path
    { pattern: /\/rest\//, score: 10 }, // REST API
    { pattern: /\/graphql/, score: 8 }, // GraphQL
    { pattern: /\/rpc\//, score: 6 }, // RPC style
    { pattern: /\/service\//, score: 6 }, // Service endpoint
    { pattern: /\/v\d+\//, score: 5 }, // Versioned endpoint
  ];

  for (const { pattern, score: patternScore } of apiPatterns) {
    if (pattern.test(urlLower)) {
      score += patternScore;
      break; // Use highest matching pattern
    }
  }

  // Specific patterns for common endpoints
  const endpointPatterns = [
    { pattern: /\/no-auth\//, score: 10 }, // Public API
    { pattern: /\/public\//, score: 8 }, // Public endpoint
    { pattern: /\/search/, score: 12 }, // Search endpoint
    { pattern: /\/pesquisa/, score: 15 }, // Portuguese search (critical!)
    { pattern: /\/query/, score: 10 }, // Query endpoint
    { pattern: /\/find/, score: 8 }, // Find endpoint
  ];

  for (const { pattern, score: patternScore } of endpointPatterns) {
    if (pattern.test(urlLower)) {
      score += patternScore;
      // Don't break - can have multiple matches
    }
  }

  return score;
}

/**
 * Calculate parameter complexity score with enhanced detection
 */
export function calculateParameterComplexityScore(url: string): number {
  const urlParts = url.split("?");
  if (urlParts.length < 2) {
    return 0; // No query parameters
  }

  const queryString = urlParts[1] || "";
  const parameters = queryString.split("&").filter((param) => param.length > 0);

  // More parameters generally indicate a main action endpoint
  let score = Math.min(parameters.length * 2, 20); // Cap at 20 points

  // Enhanced parameter scoring with domain-specific patterns
  const parameterPatterns = {
    // High-value parameters for search/query endpoints
    search: {
      patterns: [
        "text",
        "texto",
        "query",
        "search",
        "term",
        "consulta",
        "pesquisa",
        "buscar",
      ],
      boost: 8,
    },
    // Pagination parameters
    pagination: {
      patterns: ["page", "size", "limit", "offset", "per_page"],
      boost: 3,
    },
    // Date filtering parameters
    dateFilter: {
      patterns: [
        "date",
        "inicio",
        "fim",
        "start",
        "end",
        "from",
        "to",
        "dataInicio",
        "dataFim",
      ],
      boost: 4,
    },
    // Legal domain specific
    legal: {
      patterns: [
        "tribunal",
        "tribunais",
        "relator",
        "acordao",
        "decisao",
        "processo",
        "colecao",
      ],
      boost: 6,
    },
    // Filter parameters
    filter: {
      patterns: ["filter", "filtro", "category", "type", "categoria"],
      boost: 3,
    },
  };

  for (const param of parameters) {
    const paramName = param.split("=")[0]?.toLowerCase() || "";
    const paramValue = param.split("=")[1] || "";

    // Check against enhanced pattern library
    for (const [, config] of Object.entries(parameterPatterns)) {
      if (config.patterns.some((pattern) => paramName.includes(pattern))) {
        score += config.boost;

        // Extra boost for non-empty values
        if (
          paramValue &&
          paramValue !== "0" &&
          paramValue !== "" &&
          paramValue !== "false"
        ) {
          score += 2;
        }
      }
    }

    // Boost for URL-encoded values (indicates user input)
    if (paramValue.includes("%")) {
      score += 3;
    }

    // Boost for complex values
    if (paramValue.length > 10) {
      score += 1;
    }
  }

  return score;
}

/**
 * Calculate HTTP method score based on prompt context
 */
export function calculateMethodScore(method: string, prompt?: string): number {
  const methodUpper = method.toUpperCase();
  const promptLower = prompt?.toLowerCase() || "";

  // Base method priorities
  const baseScores: Record<string, number> = {
    POST: 8,
    GET: 7,
    PUT: 6,
    PATCH: 5,
    DELETE: 4,
    OPTIONS: 2,
    HEAD: 1,
  };

  let score = baseScores[methodUpper] || 0;

  // Context-aware adjustments
  if (
    promptLower.includes("search") ||
    promptLower.includes("pesquisa") ||
    promptLower.includes("find") ||
    promptLower.includes("consulta")
  ) {
    if (methodUpper === "GET") {
      score += 8; // GET is often appropriate for search
    } else if (methodUpper === "POST") {
      score += 6; // POST also common for complex searches
    }
  }

  if (
    promptLower.includes("create") ||
    promptLower.includes("add") ||
    promptLower.includes("criar") ||
    promptLower.includes("novo")
  ) {
    if (methodUpper === "POST") {
      score += 10; // POST perfect for creation
    }
  }

  return score;
}

/**
 * Calculate response type score
 */
export function calculateResponseTypeScore(responseType: string): number {
  const typeLower = responseType.toLowerCase();

  if (typeLower.includes("json")) {
    return 10; // JSON responses are preferred for APIs
  }
  if (typeLower.includes("xml")) {
    return 6; // XML is still structured data
  }
  if (typeLower.includes("html")) {
    return 2; // HTML is less likely to be a pure API
  }
  return 4; // Unknown type, neutral score
}

/**
 * Calculate keyword relevance score for URL based on user prompt
 * Higher scores indicate better semantic match with the user's intent
 */
export function calculateKeywordRelevance(
  url: string,
  prompt?: string
): number {
  if (!prompt) {
    return 0;
  }

  let score = 0;
  const urlLower = url.toLowerCase();
  const promptLower = prompt.toLowerCase();

  // Multi-language action keywords with weighted scores (enhanced for international support)
  const actionKeywords = {
    // Search/Query actions (high weight for GET endpoints) - Enhanced multi-language
    search: 15, // English
    pesquisa: 15, // Portuguese - CRITICAL for Brazilian sites
    buscar: 15, // Spanish/Portuguese
    consulta: 15, // Portuguese/Spanish - CRITICAL for legal sites
    query: 12, // English
    find: 12, // English
    recherche: 12, // French
    suche: 12, // German
    cerca: 12, // Italian
    // Legal/Jurisprudence specific terms (high weight)
    jurisprudencia: 18, // Very high weight for legal sites
    decisao: 15, // Portuguese legal term
    acordao: 15, // Portuguese legal term
    sentenca: 15, // Portuguese legal term
    julgamento: 12, // Portuguese legal term
    tribunal: 12, // Legal term
    processo: 10, // Legal process
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
