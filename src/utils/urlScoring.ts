/**
 * URL Scoring Utilities
 *
 * Extracted from URLIdentificationAgent for use by debug tools and other components.
 * These utilities provide scoring and sorting functionality for URL analysis.
 */

import type { URLInfo } from "../types/index.js";

/**
 * Sort URLs by relevance based on comprehensive scoring
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
  totalScore += parameterScore * 3;

  // Factor 4: HTTP method appropriateness
  const methodScore = calculateMethodScore(urlInfo.method, prompt);
  totalScore += methodScore;

  // Factor 5: Response type preference
  const responseScore = calculateResponseTypeScore(urlInfo.responseType);
  totalScore += responseScore * 0.8;

  // Factor 6: Contextual prompt-URL matching
  const contextualScore = calculateContextualScore(urlInfo.url, prompt);
  totalScore += contextualScore * 2.5;

  return totalScore;
}

/**
 * Calculate contextual score based on prompt-URL semantic matching
 */
function calculateContextualScore(url: string, prompt?: string): number {
  if (!prompt) {
    return 0;
  }

  const urlLower = url.toLowerCase();
  const promptLower = prompt.toLowerCase();
  let score = 0;

  // Legal/Jurisprudence context scoring
  if (
    promptLower.includes("jurisprudencia") ||
    promptLower.includes("legal") ||
    promptLower.includes("tribunal") ||
    promptLower.includes("decisao") ||
    promptLower.includes("acordao") ||
    promptLower.includes("judge")
  ) {
    if (urlLower.includes("jurisprudencia")) {
      score += 15;
    }
    if (urlLower.includes("pesquisa")) {
      score += 20; // High boost for search in legal context
    }
    if (urlLower.includes("tribunal")) {
      score += 10;
    }
    if (urlLower.includes("acordao")) {
      score += 12;
    }
    if (urlLower.includes("decisao")) {
      score += 12;
    }
  }

  // Search-related context scoring
  if (
    promptLower.includes("search") ||
    promptLower.includes("find") ||
    promptLower.includes("query") ||
    promptLower.includes("fetch") ||
    promptLower.includes("buscar") ||
    promptLower.includes("pesquisar")
  ) {
    if (urlLower.includes("pesquisa") || urlLower.includes("search")) {
      score += 25;
    }
    if (urlLower.includes("query") || urlLower.includes("consulta")) {
      score += 15;
    }
    if (urlLower.includes("find") || urlLower.includes("busca")) {
      score += 12;
    }
  }

  // Filter/API integration context
  if (
    promptLower.includes("filter") ||
    promptLower.includes("parameter") ||
    promptLower.includes("api") ||
    promptLower.includes("integration")
  ) {
    // Boost URLs with many parameters for integration tasks
    const paramCount = (url.split("?")[1] || "")
      .split("&")
      .filter((p) => p.trim()).length;
    if (paramCount > 5) {
      score += 10;
    }
    if (paramCount > 10) {
      score += 15;
    }
  }

  // TypeScript/fetcher generation context
  if (
    promptLower.includes("typescript") ||
    promptLower.includes("fetcher") ||
    promptLower.includes("generate") ||
    promptLower.includes("client")
  ) {
    // Prefer REST API endpoints for code generation
    if (urlLower.includes("/api/")) {
      score += 10;
    }
    if (urlLower.includes("/no-auth/")) {
      score += 8; // Public APIs are easier to integrate
    }
  }

  return score;
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
    { pattern: /\/no-auth\//, score: 15 }, // Public API
    { pattern: /\/public\//, score: 12 }, // Public endpoint
    { pattern: /\/open\//, score: 10 }, // Open endpoint
    { pattern: /\/search/, score: 12 }, // Search endpoint
    { pattern: /\/pesquisa/, score: 20 }, // Portuguese search
    { pattern: /\/query/, score: 10 }, // Query endpoint
    { pattern: /\/find/, score: 8 }, // Find endpoint
    { pattern: /\/busca/, score: 15 }, // Portuguese search alternative
    { pattern: /\/consulta/, score: 12 }, // Portuguese query
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
 * Calculate parameter complexity score
 */
export function calculateParameterComplexityScore(url: string): number {
  const urlParts = url.split("?");
  if (urlParts.length < 2) {
    return 0; // No query parameters
  }

  const queryString = urlParts[1] || "";
  const params = queryString.split("&").filter((param) => param.trim());
  const paramCount = params.length;

  let score = 0;

  // Base score for having parameters
  if (paramCount > 0) {
    score += 5;
  }

  // Exponential scoring for more parameters (indicates complex endpoint)
  if (paramCount >= 3) {
    score += 8;
  }
  if (paramCount >= 5) {
    score += 12;
  }
  if (paramCount >= 8) {
    score += 18;
  }
  if (paramCount >= 12) {
    score += 25; // Very complex endpoint, likely main search/filter
  }

  // Bonus for specific parameter types that indicate search/filter endpoints
  const searchParams = [
    "query",
    "q",
    "search",
    "pesquisa",
    "busca",
    "find",
    "filter",
    "where",
    "orderby",
    "sort",
    "limit",
    "offset",
    "page",
    "size",
    "count",
    "latitude",
    "longitude",
    "sessionId",
    "format",
    "type",
    "category",
    "status",
    "date",
    "from",
    "to",
    "start",
    "end",
  ];

  let searchParamCount = 0;
  for (const param of params) {
    const paramName = param.split("=")[0]?.toLowerCase() || "";
    if (searchParams.includes(paramName)) {
      searchParamCount++;
    }
  }

  // Bonus for search-related parameters
  score += searchParamCount * 3;

  // Extra bonus if >50% of parameters are search-related
  if (searchParamCount / paramCount > 0.5) {
    score += 10;
  }

  return score;
}

/**
 * Calculate HTTP method score based on context
 */
export function calculateMethodScore(method: string, prompt?: string): number {
  const methodUpper = method.toUpperCase();
  const promptLower = prompt?.toLowerCase() || "";

  // Base method priorities
  const baseScores: Record<string, number> = {
    POST: 12, // Often used for search/query operations
    GET: 8, // Standard retrieval
    PUT: 4, // Update operations
    PATCH: 4, // Partial updates
    DELETE: 2, // Delete operations
    HEAD: 1, // Metadata only
    OPTIONS: 1, // CORS preflight
  };

  let score = baseScores[methodUpper] || 5;

  // Context-based adjustments
  if (
    promptLower.includes("search") ||
    promptLower.includes("query") ||
    promptLower.includes("find") ||
    promptLower.includes("pesquisa") ||
    promptLower.includes("buscar")
  ) {
    // POST is often used for complex search queries
    if (methodUpper === "POST") {
      score += 8;
    }
    // GET is also valid for simple searches
    if (methodUpper === "GET") {
      score += 5;
    }
  }

  if (
    promptLower.includes("create") ||
    promptLower.includes("add") ||
    promptLower.includes("insert") ||
    promptLower.includes("submit")
  ) {
    if (methodUpper === "POST") {
      score += 10;
    }
  }

  if (
    promptLower.includes("update") ||
    promptLower.includes("modify") ||
    promptLower.includes("edit")
  ) {
    if (methodUpper === "PUT" || methodUpper === "PATCH") {
      score += 8;
    }
  }

  if (promptLower.includes("delete") || promptLower.includes("remove")) {
    if (methodUpper === "DELETE") {
      score += 10;
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
    return 6; // XML is also structured data
  }
  if (typeLower.includes("text")) {
    return 3; // Plain text might be useful
  }
  if (typeLower.includes("html")) {
    return 1; // HTML is less likely to be an API endpoint
  }

  return 5; // Default score for unknown types
}

/**
 * Calculate keyword relevance score
 */
export function calculateKeywordRelevance(
  url: string,
  prompt?: string
): number {
  if (!prompt) {
    return 0;
  }

  const urlLower = url.toLowerCase();
  const promptLower = prompt.toLowerCase();
  let score = 0;

  // Extract meaningful words from prompt (exclude common words)
  const commonWords = [
    "the",
    "a",
    "an",
    "and",
    "or",
    "but",
    "in",
    "on",
    "at",
    "to",
    "for",
    "of",
    "with",
    "by",
    "from",
    "up",
    "about",
    "into",
    "through",
    "during",
    "before",
    "after",
    "above",
    "below",
    "between",
    "among",
    "is",
    "are",
    "was",
    "were",
    "be",
    "been",
    "being",
    "have",
    "has",
    "had",
    "do",
    "does",
    "did",
    "will",
    "would",
    "could",
    "should",
    "may",
    "might",
    "can",
    "must",
  ];

  const promptWords = promptLower
    .split(/\s+/)
    .map((word) => word.replace(/[^\w]/g, ""))
    .filter((word) => word.length > 2 && !commonWords.includes(word));

  // Check for direct keyword matches
  for (const word of promptWords) {
    if (urlLower.includes(word)) {
      score += 15; // High score for direct matches
    }
  }

  // Check for semantic matches (similar meaning)
  const semanticMappings: Record<string, string[]> = {
    search: ["pesquisa", "busca", "find", "query", "consulta"],
    login: ["auth", "authentication", "signin", "entrar"],
    user: ["usuario", "utilizador", "account", "conta"],
    document: ["documento", "doc", "file", "arquivo"],
    legal: ["juridico", "direito", "law", "tribunal", "jurisprudencia"],
    court: ["tribunal", "corte", "julgamento"],
    decision: ["decisao", "acordao", "sentenca", "ruling"],
    filter: ["filtro", "where", "criteria", "criterio"],
    data: ["dados", "information", "informacao"],
  };

  for (const [english, alternatives] of Object.entries(semanticMappings)) {
    if (promptWords.includes(english)) {
      for (const alt of alternatives) {
        if (urlLower.includes(alt)) {
          score += 12; // Good score for semantic matches
        }
      }
    }
    // Also check reverse mapping
    for (const alt of alternatives) {
      if (promptWords.includes(alt) && urlLower.includes(english)) {
        score += 12;
      }
    }
  }

  return score;
}
