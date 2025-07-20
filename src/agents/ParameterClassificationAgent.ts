import { getLLMClient, type LLMClient } from "../core/LLMClient.js";
import type { FunctionDefinition } from "../core/providers/types.js";
import type {
  ClassifiedParameter,
  HarvestSession,
  ParameterClassification,
  RequestModel,
} from "../types/index.js";
import { HarvestError } from "../types/index.js";
import { createComponentLogger } from "../utils/logger.js";

const logger = createComponentLogger("parameter-classification-agent");

/**
 * Domain-specific parameter patterns for enhanced classification
 */
const DOMAIN_PATTERN_LIBRARY = {
  // Session and authentication patterns
  session: {
    patterns: [
      /^(session|sess|sid)[-_]?id$/i,
      /^[a-f0-9]{8,32}$/i, // Hex session IDs
      /^session[-_]?[a-z0-9]+$/i,
      /^[a-z0-9]{16,}$/i, // Long alphanumeric sessions
    ],
    keywords: ["session", "sess", "sid", "sessionid"],
    weight: 15,
  },

  // API tokens and keys
  apiKey: {
    patterns: [
      /^(api[-_]?key|token|auth[-_]?token)$/i,
      /^[A-Z0-9]{20,}$/i, // Uppercase alphanumeric tokens
      /^[a-zA-Z0-9+/]{20,}={0,2}$/i, // Base64-like tokens
      /^pk_[a-zA-Z0-9]+$/i, // Stripe-style public keys
      /^sk_[a-zA-Z0-9]+$/i, // Stripe-style secret keys
    ],
    keywords: ["token", "key", "auth", "bearer", "juristkn"],
    weight: 20,
  },

  // CSRF and security tokens
  csrf: {
    patterns: [
      /^(csrf|xsrf)[-_]?token$/i,
      /^[a-f0-9]{16,}$/i, // Hex CSRF tokens
    ],
    keywords: ["csrf", "xsrf", "security"],
    weight: 18,
  },

  // Search and query parameters
  search: {
    patterns: [
      /^(text|query|search|term|keyword|q)$/i,
      /^(texto|consulta|pesquisa|buscar)$/i, // Portuguese
      /^.*[Ss]earch.*$/,
    ],
    keywords: [
      "search",
      "query",
      "text",
      "term",
      "texto",
      "pesquisa",
      "consulta",
    ],
    weight: 12,
  },

  // Pagination parameters
  pagination: {
    patterns: [
      /^(page|offset|limit|size|per[-_]?page)$/i,
      /^\d+$/i, // Pure numeric values
    ],
    keywords: ["page", "size", "limit", "offset", "per_page"],
    weight: 10,
  },

  // Date and time parameters
  dateTime: {
    patterns: [
      /^(date|time|start|end|from|to)[-_]?(inicio|fim|final)?$/i,
      /^\d{4}-\d{2}-\d{2}$/i, // ISO date format
      /^\d{10,13}$/i, // Unix timestamps
    ],
    keywords: [
      "date",
      "time",
      "start",
      "end",
      "from",
      "to",
      "inicio",
      "fim",
      "final",
    ],
    weight: 8,
  },

  // Geographic coordinates
  location: {
    patterns: [
      /^(lat|lng|latitude|longitude)$/i,
      /^[+-]?\d+\.?\d*$/i, // Decimal coordinates
    ],
    keywords: ["lat", "lng", "latitude", "longitude"],
    weight: 15,
  },

  // Legal domain specific (for jurisprudence systems)
  legal: {
    patterns: [
      /^(tribunal|acordao|decisao|processo|relator)[-_]?.*$/i,
      /^(case|court|judge|decision)[-_]?.*$/i,
    ],
    keywords: [
      "tribunal",
      "acordao",
      "decisao",
      "processo",
      "relator",
      "legal",
      "jurisprudencia",
    ],
    weight: 12,
  },

  // Filter parameters
  filter: {
    patterns: [/^(filter|filtro)[-_]?.*$/i, /^.*[-_]?(filter|filtro)$/i],
    keywords: ["filter", "filtro", "category", "type"],
    weight: 8,
  },
};

/**
 * LLM response schema for parameter classification
 */
interface ParameterClassificationResponse {
  classified_parameters: Array<{
    parameter_name: string;
    parameter_value: string;
    classification: ParameterClassification;
    confidence: number;
    reasoning: string;
    domain_context?: string;
  }>;
}

/**
 * Classify parameters in a request using hybrid approach
 */
export async function classifyParameters(
  request: RequestModel,
  session: HarvestSession,
  llmClient?: LLMClient
): Promise<ClassifiedParameter[]> {
  try {
    const client = llmClient || getLLMClient();

    // Extract all parameters from the request
    const allParameters = extractAllParameters(request);

    if (allParameters.length === 0) {
      logger.debug("No parameters found in request", { url: request.url });
      return [];
    }

    // Phase 1: Heuristic analysis
    const heuristicResults = analyzeParametersHeuristically(
      allParameters,
      request,
      session
    );

    // Phase 2: Consistency analysis across session
    const consistencyResults = analyzeParameterConsistency(
      allParameters,
      session
    );

    // Merge heuristic and consistency results
    const preliminaryResults = mergeAnalysisResults(
      heuristicResults,
      consistencyResults
    );

    // Phase 3: LLM refinement for uncertain cases
    const uncertainParameters = preliminaryResults.filter(
      (p) => p.confidence < 0.8
    );

    let llmResults: ClassifiedParameter[] = [];
    if (uncertainParameters.length > 0) {
      llmResults = await refineClassificationWithLLM(
        uncertainParameters,
        request,
        session,
        client
      );
    }

    // Combine all results
    const finalResults = combineClassificationResults(
      preliminaryResults,
      llmResults
    );

    logger.info("Parameter classification complete", {
      totalParameters: allParameters.length,
      heuristicClassified: heuristicResults.length,
      llmRefined: llmResults.length,
      finalClassified: finalResults.length,
    });

    return finalResults;
  } catch (error) {
    if (error instanceof HarvestError) {
      throw error;
    }

    throw new HarvestError(
      `Parameter classification failed: ${error instanceof Error ? error.message : "Unknown error"}`,
      "PARAMETER_CLASSIFICATION_FAILED",
      { originalError: error, requestUrl: request.url }
    );
  }
}

/**
 * Extract all parameters from a request (URL params, body params, headers)
 */
function extractAllParameters(request: RequestModel): Array<{
  name: string;
  value: string;
  location: "url" | "body" | "header";
}> {
  const parameters: Array<{
    name: string;
    value: string;
    location: "url" | "body" | "header";
  }> = [];

  // Extract URL parameters
  if (request.queryParams) {
    for (const [name, value] of Object.entries(request.queryParams)) {
      parameters.push({ name, value, location: "url" });
    }
  }

  // Extract body parameters (if JSON)
  if (request.body && typeof request.body === "object") {
    for (const [name, value] of Object.entries(request.body)) {
      if (typeof value === "string" || typeof value === "number") {
        parameters.push({ name, value: String(value), location: "body" });
      }
    }
  }

  // Extract relevant headers (skip standard browser headers)
  const relevantHeaders = [
    "authorization",
    "x-api-key",
    "x-auth-token",
    "cookie",
  ];
  for (const [name, value] of Object.entries(request.headers)) {
    if (relevantHeaders.some((header) => name.toLowerCase().includes(header))) {
      parameters.push({ name, value, location: "header" });
    }
  }

  return parameters;
}

/**
 * Analyze parameters using heuristic patterns
 */
function analyzeParametersHeuristically(
  parameters: Array<{ name: string; value: string; location: string }>,
  _request: RequestModel,
  _session: HarvestSession
): ClassifiedParameter[] {
  const results: ClassifiedParameter[] = [];

  for (const param of parameters) {
    const analysis = classifyParameterHeuristically(
      param.name,
      param.value,
      param.location
    );

    results.push({
      name: param.name,
      value: param.value,
      classification: analysis.classification,
      confidence: analysis.confidence,
      source: "heuristic",
      metadata: {
        occurrenceCount: 1, // Will be updated in consistency analysis
        totalRequests: 1,
        consistencyScore: 1.0,
        parameterPattern: analysis.pattern,
        domainContext: analysis.domainContext || "unknown",
      },
    });
  }

  return results;
}

/**
 * Classify a single parameter using heuristic patterns
 */
function classifyParameterHeuristically(
  name: string,
  value: string,
  location: string
): {
  classification: ParameterClassification;
  confidence: number;
  pattern: string;
  domainContext?: string;
} {
  const nameLower = name.toLowerCase();
  const valueStr = String(value);

  // Check against domain patterns
  for (const [domain, config] of Object.entries(DOMAIN_PATTERN_LIBRARY)) {
    // Check name patterns
    for (const pattern of config.patterns) {
      if (pattern.test(nameLower) || pattern.test(valueStr)) {
        return classifyByDomain(domain, config.weight);
      }
    }

    // Check keywords
    for (const keyword of config.keywords) {
      if (nameLower.includes(keyword)) {
        return classifyByDomain(domain, config.weight);
      }
    }
  }

  // Static analysis based on location and common patterns
  if (location === "header") {
    if (
      nameLower.includes("auth") ||
      nameLower.includes("token") ||
      nameLower.includes("key")
    ) {
      return {
        classification: "sessionConstant",
        confidence: 0.8,
        pattern: "auth_header",
        domainContext: "authentication",
      };
    }
  }

  if (location === "url") {
    // Common pagination parameters
    if (["page", "size", "limit", "offset"].includes(nameLower)) {
      return {
        classification: "userInput",
        confidence: 0.9,
        pattern: "pagination",
        domainContext: "pagination",
      };
    }

    // Search-like parameters
    if (["q", "query", "search", "text", "texto", "term"].includes(nameLower)) {
      return {
        classification: "userInput",
        confidence: 0.95,
        pattern: "search_query",
        domainContext: "search",
      };
    }

    // Static coordinates or configuration
    if (
      (nameLower === "latitude" && valueStr === "0") ||
      (nameLower === "longitude" && valueStr === "0")
    ) {
      return {
        classification: "staticConstant",
        confidence: 0.9,
        pattern: "static_coordinate",
        domainContext: "location",
      };
    }
  }

  // Value-based analysis for unknown parameter names
  if (isSessionLikeValue(valueStr)) {
    return {
      classification: "sessionConstant",
      confidence: 0.7,
      pattern: "session_value",
      domainContext: "session",
    };
  }

  if (isDateLikeValue(valueStr)) {
    return {
      classification: "userInput",
      confidence: 0.8,
      pattern: "date_value",
      domainContext: "datetime",
    };
  }

  // Default classification for unknown parameters
  return {
    classification: "userInput",
    confidence: 0.4,
    pattern: "unknown",
    domainContext: "unknown",
  };
}

/**
 * Map domain to classification
 */
function classifyByDomain(
  domain: string,
  weight: number
): {
  classification: ParameterClassification;
  confidence: number;
  pattern: string;
  domainContext: string;
} {
  const confidence = Math.min(weight / 20, 0.95); // Convert weight to confidence

  switch (domain) {
    case "session":
    case "apiKey":
    case "csrf":
      return {
        classification: "sessionConstant",
        confidence,
        pattern: domain,
        domainContext: domain,
      };

    case "search":
    case "pagination":
    case "dateTime":
    case "legal":
    case "filter":
      return {
        classification: "userInput",
        confidence,
        pattern: domain,
        domainContext: domain,
      };

    case "location":
      // Special case: static coordinates are often constants
      return {
        classification: "staticConstant",
        confidence,
        pattern: domain,
        domainContext: domain,
      };

    default:
      return {
        classification: "userInput",
        confidence: 0.5,
        pattern: domain,
        domainContext: domain,
      };
  }
}

/**
 * Check if a value looks like a session identifier
 */
function isSessionLikeValue(value: string): boolean {
  const sessionPatterns = [
    /^[a-f0-9]{8,32}$/i, // Hex values
    /^[a-zA-Z0-9]{16,}$/i, // Long alphanumeric
    /^sess_[a-zA-Z0-9]+$/i, // Session prefixed
  ];

  return sessionPatterns.some((pattern) => pattern.test(value));
}

/**
 * Check if a value looks like a date/time
 */
function isDateLikeValue(value: string): boolean {
  const datePatterns = [
    /^\d{4}-\d{2}-\d{2}$/i, // ISO date
    /^\d{10,13}$/i, // Unix timestamp
    /^\d{2}\/\d{2}\/\d{4}$/i, // US date format
  ];

  return datePatterns.some((pattern) => pattern.test(value));
}

/**
 * Analyze parameter consistency across all requests in the session
 */
function analyzeParameterConsistency(
  parameters: Array<{ name: string; value: string; location: string }>,
  _session: HarvestSession
): Map<
  string,
  { occurrenceCount: number; totalRequests: number; consistencyScore: number }
> {
  const consistencyMap = new Map<
    string,
    { occurrenceCount: number; totalRequests: number; consistencyScore: number }
  >();

  // For now, return basic consistency data
  // In a full implementation, this would analyze all requests in the session
  for (const param of parameters) {
    consistencyMap.set(param.name, {
      occurrenceCount: 1,
      totalRequests: 1,
      consistencyScore: 1.0,
    });
  }

  return consistencyMap;
}

/**
 * Merge heuristic and consistency analysis results
 */
function mergeAnalysisResults(
  heuristicResults: ClassifiedParameter[],
  consistencyResults: Map<
    string,
    { occurrenceCount: number; totalRequests: number; consistencyScore: number }
  >
): ClassifiedParameter[] {
  return heuristicResults.map((result) => {
    const consistency = consistencyResults.get(result.name);
    if (consistency) {
      result.metadata.occurrenceCount = consistency.occurrenceCount;
      result.metadata.totalRequests = consistency.totalRequests;
      result.metadata.consistencyScore = consistency.consistencyScore;

      // Adjust confidence based on consistency
      if (consistency.consistencyScore < 0.5) {
        result.confidence *= 0.8; // Reduce confidence for inconsistent parameters
      }
    }
    return result;
  });
}

/**
 * Refine classification using LLM for uncertain parameters
 */
async function refineClassificationWithLLM(
  uncertainParameters: ClassifiedParameter[],
  request: RequestModel,
  session: HarvestSession,
  client: LLMClient
): Promise<ClassifiedParameter[]> {
  if (uncertainParameters.length === 0) {
    return [];
  }

  const functionDef = createLLMFunctionDefinition();
  const prompt = createLLMPrompt(uncertainParameters, request, session);

  const response = await client.callFunction<ParameterClassificationResponse>(
    prompt,
    functionDef,
    "classify_parameters"
  );

  return (response.classified_parameters || []).map((param) => ({
    name: param.parameter_name,
    value: param.parameter_value,
    classification: param.classification,
    confidence: Math.min(param.confidence, 0.95),
    source: "llm" as const,
    metadata: {
      occurrenceCount: 1,
      totalRequests: 1,
      consistencyScore: 1.0,
      parameterPattern: `llm_${param.classification}`,
      domainContext: param.domain_context || "llm_analysis",
    },
  }));
}

/**
 * Create LLM function definition for parameter classification
 */
function createLLMFunctionDefinition(): FunctionDefinition {
  return {
    name: "classify_parameters",
    description:
      "Classify HTTP request parameters into appropriate categories for code generation",
    parameters: {
      type: "object",
      properties: {
        classified_parameters: {
          type: "array",
          items: {
            type: "object",
            properties: {
              parameter_name: {
                type: "string",
                description: "The parameter name",
              },
              parameter_value: {
                type: "string",
                description: "The parameter value",
              },
              classification: {
                type: "string",
                enum: [
                  "dynamic",
                  "sessionConstant",
                  "userInput",
                  "staticConstant",
                  "optional",
                ],
                description: "Classification type",
              },
              confidence: {
                type: "number",
                description: "Confidence in classification (0-1)",
              },
              reasoning: {
                type: "string",
                description: "Brief explanation of classification reasoning",
              },
              domain_context: {
                type: "string",
                description: "Domain context (auth, pagination, search, etc.)",
              },
            },
            // Note: required field is removed as it's not supported in this schema format
          },
        },
      },
      required: ["classified_parameters"],
    },
  };
}

/**
 * Create LLM prompt for parameter classification
 */
function createLLMPrompt(
  uncertainParameters: ClassifiedParameter[],
  request: RequestModel,
  session: HarvestSession
): string {
  const parameterList = uncertainParameters
    .map(
      (p) =>
        `- ${p.name}: "${p.value}" (current: ${p.classification}, confidence: ${p.confidence})`
    )
    .join("\n");

  return `Request: ${request.method} ${request.url}
User Prompt: ${session.prompt}

Parameters to classify:
${parameterList}

Classification Guidelines:
- dynamic: Value must be resolved from a previous API response (e.g., extracted IDs, tokens from login)
- sessionConstant: Session-scoped constant that doesn't change during the session (e.g., sessionId, CSRF tokens, API keys)
- userInput: User-provided parameter that should be configurable (e.g., search terms, page numbers, dates)
- staticConstant: Hardcoded application constant (e.g., latitude=0, longitude=0, fixed API versions)
- optional: Parameter can be omitted without breaking functionality

Context:
- This is a ${getDomainContext(request.url)} application
- Focus on generating practical, usable API client code
- Session constants should be handled automatically
- User inputs should be exposed as function parameters
- Static constants can be hardcoded

Classify each parameter with high confidence and provide clear reasoning.`;
}

/**
 * Get domain context from URL for better classification
 */
function getDomainContext(url: string): string {
  const urlLower = url.toLowerCase();

  if (
    urlLower.includes("jurisprudencia") ||
    urlLower.includes("legal") ||
    urlLower.includes("tribunal")
  ) {
    return "legal/jurisprudence";
  }
  if (
    urlLower.includes("ecommerce") ||
    urlLower.includes("shop") ||
    urlLower.includes("cart")
  ) {
    return "e-commerce";
  }
  if (urlLower.includes("api")) {
    return "REST API";
  }

  return "web application";
}

/**
 * Combine heuristic and LLM classification results
 */
function combineClassificationResults(
  preliminaryResults: ClassifiedParameter[],
  llmResults: ClassifiedParameter[]
): ClassifiedParameter[] {
  const combined = [...preliminaryResults];

  // Replace preliminary results with LLM results where available
  for (const llmResult of llmResults) {
    const index = combined.findIndex((p) => p.name === llmResult.name);
    if (index >= 0) {
      combined[index] = llmResult;
    }
  }

  return combined;
}

/**
 * Validate classified parameters and provide diagnostic information
 */
export function validateClassifiedParameters(
  parameters: ClassifiedParameter[]
): {
  valid: ClassifiedParameter[];
  invalid: ClassifiedParameter[];
  warnings: string[];
} {
  const valid: ClassifiedParameter[] = [];
  const invalid: ClassifiedParameter[] = [];
  const warnings: string[] = [];

  for (const param of parameters) {
    if (!param.name || !param.value || !param.classification) {
      invalid.push(param);
      continue;
    }

    if (param.confidence < 0.3) {
      warnings.push(
        `Low confidence classification for parameter "${param.name}": ${param.confidence}`
      );
    }

    if (param.classification === "dynamic" && param.confidence < 0.7) {
      warnings.push(
        `Uncertain dynamic classification for "${param.name}" - may cause workflow issues`
      );
    }

    valid.push(param);
  }

  return { valid, invalid, warnings };
}
