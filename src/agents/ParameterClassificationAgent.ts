import { getLLMClient } from "../core/LLMClient.js";
import type { FunctionDefinition } from "../core/providers/types.js";
import {
  type ClassifiedParameter,
  HarvestError,
  type ParameterClassification,
  type RequestModel,
} from "../types/index.js";
import { createComponentLogger } from "../utils/logger.js";

const logger = createComponentLogger("parameter-classification-agent");

/**
 * LLM Response for parameter classification
 */
interface ParameterClassificationResponse {
  classifications: Array<{
    parameter: string;
    classification: ParameterClassification;
    confidence: number;
    reasoning: string;
  }>;
}

/**
 * Heuristic analysis result
 */
export interface HeuristicAnalysis {
  parameter: string;
  classification: ParameterClassification;
  confidence: number;
  reasoning: string;
  metadata: {
    occurrenceCount: number;
    totalRequests: number;
    consistencyScore: number;
    parameterPattern: string;
    domainContext?: string;
  };
}

/**
 * Pattern recognition library for common parameter types
 */
const PARAMETER_PATTERNS = {
  sessionTokens: {
    namePatterns: [
      /sessionId/i,
      /session_id/i,
      /sess/i,
      /tkn$/i,
      /token$/i,
      /juristkn/i,
      /auth_token/i,
      /access_token/i,
    ],
    valuePatterns: [
      /^[a-zA-Z0-9_-]{8,}$/,
      /^_[a-z0-9]{6,}$/,
      /^[a-f0-9]{16,}$/,
    ],
    defaultClassification: "sessionConstant" as const,
    context: "session",
  },
  csrfTokens: {
    namePatterns: [/csrf/i, /xsrf/i, /authenticity/i, /nonce/i, /_token$/i],
    valuePatterns: [/^[a-f0-9]{32,}$/, /^[A-Za-z0-9+/]{20,}={0,2}$/],
    defaultClassification: "sessionConstant" as const,
    context: "auth",
  },
  userInput: {
    namePatterns: [
      /query/i,
      /search/i,
      /term/i,
      /keyword/i,
      /filter/i,
      /pesquisa/i,
      /buscar/i,
      /consulta/i,
    ],
    valuePatterns: [],
    contextHints: ["varies_by_request", "user_provided"],
    defaultClassification: "userInput" as const,
    context: "user",
  },
  pagination: {
    namePatterns: [
      /page/i,
      /offset/i,
      /limit/i,
      /size/i,
      /count/i,
      /start/i,
      /end/i,
      /from/i,
      /to/i,
    ],
    valuePatterns: [],
    defaultClassification: "userInput" as const,
    context: "pagination",
  },
  staticConstants: {
    namePatterns: [
      /version/i,
      /api_version/i,
      /format/i,
      /type/i,
      /language/i,
      /locale/i,
      /timezone/i,
    ],
    valuePatterns: [],
    defaultClassification: "staticConstant" as const,
    context: "config",
  },
};

/**
 * Classify parameters using both heuristic analysis and LLM refinement
 */
export async function classifyParameters(
  dynamicParts: string[],
  allRequests: RequestModel[],
  sessionId: string
): Promise<ClassifiedParameter[]> {
  if (dynamicParts.length === 0) {
    return [];
  }

  try {
    logger.info(
      `Classifying ${dynamicParts.length} parameters for session ${sessionId}`
    );

    const classifications: ClassifiedParameter[] = [];

    // Phase 0: Domain detection for enhanced patterns
    const detectedDomain = detectDomain(allRequests);
    logger.info(`Detected domain: ${detectedDomain}`);

    // Phase 1: Heuristic analysis for all parameters
    let heuristicResults = dynamicParts.map((param) =>
      analyzeParameterHeuristically(param, allRequests)
    );

    // Apply domain-specific patterns if domain detected
    if (detectedDomain !== "unknown") {
      const domainClassifications = applyDomainPatterns(
        dynamicParts,
        detectedDomain,
        allRequests
      );

      // Merge domain patterns with heuristic results (domain patterns take precedence)
      heuristicResults = heuristicResults.map((heuristic) => {
        const domainMatch = domainClassifications.find(
          (dc) => dc.value === heuristic.parameter
        );
        if (domainMatch && domainMatch.confidence > heuristic.confidence) {
          return {
            ...heuristic,
            classification: domainMatch.classification,
            confidence: domainMatch.confidence,
            reasoning:
              domainMatch.metadata.domainContext || heuristic.reasoning,
          };
        }
        return heuristic;
      });
    }

    // Phase 2: Identify which parameters need LLM refinement (low confidence)
    const needsLLMRefinement = heuristicResults.filter(
      (result) => result.confidence < 0.8
    );
    const highConfidenceResults = heuristicResults.filter(
      (result) => result.confidence >= 0.8
    );

    // Phase 3: LLM refinement for ambiguous cases with graceful fallback
    let llmRefinedResults: HeuristicAnalysis[] = [];
    if (needsLLMRefinement.length > 0) {
      try {
        logger.info(
          `Sending ${needsLLMRefinement.length} parameters to LLM for refinement`
        );
        llmRefinedResults = await refineWithLLM(
          needsLLMRefinement,
          allRequests
        );
      } catch (llmError) {
        logger.warn(
          { error: llmError },
          "LLM refinement failed, using graceful fallback"
        );

        // Graceful fallback: use enhanced heuristics
        const fallbackParams = needsLLMRefinement.map((r) => r.parameter);
        const fallbackResults = gracefulClassificationFallback(
          fallbackParams,
          allRequests
        );

        llmRefinedResults = fallbackResults.map((fb) => ({
          parameter: fb.value,
          classification: fb.classification,
          confidence: fb.confidence,
          reasoning: fb.metadata.domainContext || "Fallback classification",
          metadata: fb.metadata,
        }));
      }
    }

    // Phase 4: Combine all results
    const allResults = [...highConfidenceResults, ...llmRefinedResults];

    // Phase 5: Convert to ClassifiedParameter format
    for (const result of allResults) {
      classifications.push({
        name: extractParameterName(result.parameter),
        value: result.parameter,
        classification: result.classification,
        confidence: result.confidence,
        source: result.confidence >= 0.8 ? "heuristic" : "llm",
        metadata: result.metadata,
      });
    }

    logger.info(
      `Classified ${classifications.length} parameters:`,
      classifications.reduce(
        (acc, c) => {
          acc[c.classification] = (acc[c.classification] || 0) + 1;
          return acc;
        },
        {} as Record<string, number>
      )
    );

    return classifications;
  } catch (error) {
    if (error instanceof HarvestError) {
      throw error;
    }

    throw new HarvestError(
      `Parameter classification failed: ${error instanceof Error ? error.message : "Unknown error"}`,
      "PARAMETER_CLASSIFICATION_FAILED",
      { originalError: error, sessionId, parameterCount: dynamicParts.length }
    );
  }
}

/**
 * Analyze a parameter using heuristic rules
 */
export function analyzeParameterHeuristically(
  parameter: string,
  allRequests: RequestModel[]
): HeuristicAnalysis {
  // Count occurrences across all requests
  const occurrenceCount = countParameterOccurrences(parameter, allRequests);
  const totalRequests = allRequests.length;
  const consistencyScore =
    totalRequests > 0 ? occurrenceCount / totalRequests : 0;

  // Extract parameter name (handle both "name=value" and "value" formats)
  const paramName = extractParameterName(parameter);

  // Initialize analysis result
  let classification: ParameterClassification = "dynamic";
  let confidence = 0.3; // Default low confidence
  let reasoning = "No specific pattern detected";
  let domainContext: string | undefined;

  // Pattern matching analysis
  for (const [patternType, config] of Object.entries(PARAMETER_PATTERNS)) {
    const nameMatches = config.namePatterns?.some((pattern) =>
      pattern.test(paramName)
    );
    const valueMatches = config.valuePatterns?.some((pattern: RegExp) =>
      pattern.test(parameter)
    );

    if (nameMatches || valueMatches) {
      classification = config.defaultClassification;
      domainContext = config.context;

      // Calculate confidence based on pattern strength and consistency
      if (nameMatches && valueMatches) {
        confidence = 0.95; // Both name and value match
        reasoning = `Strong pattern match: name matches ${patternType} pattern and value format is consistent`;
      } else if (nameMatches) {
        confidence = 0.85; // Name matches
        reasoning = `Parameter name matches ${patternType} pattern`;
      } else if (valueMatches) {
        confidence = 0.75; // Value format matches
        reasoning = `Parameter value matches ${patternType} format`;
      }

      // Boost confidence for high consistency
      if (consistencyScore > 0.9) {
        confidence = Math.min(confidence + 0.1, 1.0);
        reasoning += ` (high consistency: ${Math.round(consistencyScore * 100)}%)`;
      }

      break; // Use first matching pattern
    }
  }

  // Special analysis for session constants based on consistency
  if (classification === "dynamic" && consistencyScore > 0.9) {
    classification = "sessionConstant";
    confidence = 0.85;
    reasoning = `High consistency (${Math.round(consistencyScore * 100)}%) suggests session-scoped constant`;
    domainContext = "session";
  }

  // Special analysis for values that appear to be user input (low consistency)
  if (classification === "dynamic" && consistencyScore < 0.3) {
    classification = "userInput";
    confidence = 0.7;
    reasoning = `Low consistency (${Math.round(consistencyScore * 100)}%) suggests user input`;
    domainContext = "user";
  }

  return {
    parameter,
    classification,
    confidence,
    reasoning,
    metadata: {
      occurrenceCount,
      totalRequests,
      consistencyScore,
      parameterPattern: generateParameterPattern(parameter),
      ...(domainContext && { domainContext }),
    },
  };
}

/**
 * Refine parameter classification using LLM for ambiguous cases
 */
async function refineWithLLM(
  ambiguousResults: HeuristicAnalysis[],
  allRequests: RequestModel[]
): Promise<HeuristicAnalysis[]> {
  const llmClient = getLLMClient();
  const functionDef = createClassificationFunctionDefinition();
  const prompt = createClassificationPrompt(ambiguousResults, allRequests);

  const response =
    await llmClient.callFunction<ParameterClassificationResponse>(
      prompt,
      functionDef,
      "classify_parameters"
    );

  // Merge LLM results with heuristic analysis
  const refinedResults: HeuristicAnalysis[] = [];

  for (const result of ambiguousResults) {
    const llmClassification = response.classifications.find(
      (c) => c.parameter === result.parameter
    );

    if (llmClassification) {
      refinedResults.push({
        ...result,
        classification: llmClassification.classification,
        confidence: Math.max(llmClassification.confidence, 0.5), // Minimum confidence for LLM
        reasoning: `LLM analysis: ${llmClassification.reasoning}`,
      });
    } else {
      // Fallback if LLM doesn't classify this parameter
      refinedResults.push(result);
    }
  }

  return refinedResults;
}

/**
 * Create the OpenAI function definition for parameter classification
 */
function createClassificationFunctionDefinition(): FunctionDefinition {
  return {
    name: "classify_parameters",
    description:
      "Classify parameters based on their usage patterns and characteristics",
    parameters: {
      type: "object",
      properties: {
        classifications: {
          type: "array",
          items: {
            type: "object",
            properties: {
              parameter: {
                type: "string",
                description: "The parameter value to classify",
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
                description: "The classification type for this parameter",
              },
              confidence: {
                type: "number",
                description: "Confidence score for this classification (0-1)",
              },
              reasoning: {
                type: "string",
                description: "Brief explanation for this classification",
              },
            },
          },
        },
      },
      required: ["classifications"],
    },
  };
}

/**
 * Create the prompt for LLM parameter classification
 */
function createClassificationPrompt(
  ambiguousResults: HeuristicAnalysis[],
  allRequests: RequestModel[]
): string {
  const parameterAnalysis = ambiguousResults
    .map((result) => {
      return `Parameter: "${result.parameter}"
  - Occurs in ${result.metadata.occurrenceCount}/${result.metadata.totalRequests} requests (${Math.round(result.metadata.consistencyScore * 100)}% consistency)
  - Heuristic suggestion: ${result.classification} (confidence: ${result.confidence})
  - Reasoning: ${result.reasoning}`;
    })
    .join("\n\n");

  return `Analyze these parameters and classify them based on their usage patterns:

${parameterAnalysis}

Request Context:
- Total requests analyzed: ${allRequests.length}
- API appears to be: ${inferAPIType(allRequests)}

Classification Guidelines:
- **dynamic**: Value must be resolved from a previous API response
- **sessionConstant**: Session-scoped constant (session tokens, CSRF tokens, user IDs)
- **userInput**: User-provided parameter that varies per request (search terms, filters)
- **staticConstant**: Hardcoded application constant (API version, format)
- **optional**: Can be omitted without breaking functionality

Focus on:
1. Consistency patterns (high consistency = likely sessionConstant)
2. Parameter names and value formats
3. Whether the value would logically come from user input vs system generation
4. Common web application patterns (session management, search, pagination)

For each parameter, provide your classification with confidence and reasoning.`;
}

/**
 * Helper functions
 */

function countParameterOccurrences(
  parameter: string,
  requests: RequestModel[]
): number {
  let count = 0;
  for (const request of requests) {
    // Check in URL query parameters
    if (request.url.includes(parameter)) {
      count++;
    }

    // Check in request body
    if (
      request.body &&
      typeof request.body === "string" &&
      request.body.includes(parameter)
    ) {
      count++;
    }

    // Check in headers
    for (const headerValue of Object.values(request.headers)) {
      if (headerValue.includes(parameter)) {
        count++;
      }
    }
  }
  return count;
}

function extractParameterName(parameter: string): string {
  // Handle "name=value" format
  if (parameter.includes("=")) {
    return parameter.split("=")[0] || parameter;
  }

  // Handle URL encoded parameters
  if (parameter.includes("%")) {
    try {
      return decodeURIComponent(parameter);
    } catch {
      return parameter;
    }
  }

  return parameter;
}

function generateParameterPattern(parameter: string): string {
  // Generate a simple regex pattern for the parameter value
  const alphanumeric = /^[a-zA-Z0-9]+$/.test(parameter);
  const hasSpecialChars = /[_-]/.test(parameter);

  if (alphanumeric && !hasSpecialChars) {
    return `^[a-zA-Z0-9]{${parameter.length}}$`;
  }
  if (hasSpecialChars) {
    return `^[a-zA-Z0-9_-]{${Math.max(parameter.length - 2, 1)},${parameter.length + 2}}$`;
  }
  return `^.{${Math.max(parameter.length - 2, 1)},${parameter.length + 2}}$`;
}

function inferAPIType(requests: RequestModel[]): string {
  const urls = requests.map((r) => r.url.toLowerCase());

  if (
    urls.some((url) => url.includes("jurisprudencia") || url.includes("legal"))
  ) {
    return "Legal/Jurisprudence API";
  }
  if (urls.some((url) => url.includes("search") || url.includes("pesquisa"))) {
    return "Search API";
  }
  if (urls.some((url) => url.includes("/api/"))) {
    return "REST API";
  }
  return "Web Application API";
}

/**
 * Manual parameter classification override
 */
export function overrideParameterClassification(
  parameters: ClassifiedParameter[],
  parameterValue: string,
  newClassification: ParameterClassification,
  reasoning?: string
): ClassifiedParameter[] {
  return parameters.map((param) => {
    if (param.value === parameterValue) {
      return {
        ...param,
        classification: newClassification,
        confidence: 1.0,
        source: "manual",
        metadata: {
          ...param.metadata,
          domainContext: reasoning || `Manually set to ${newClassification}`,
        },
      };
    }
    return param;
  });
}

/**
 * Pattern library for common parameter types across different domains
 */
export const DOMAIN_PATTERN_LIBRARY = {
  legal: {
    patterns: {
      sessionTokens: [
        /sessionId/i,
        /session_id/i,
        /juristkn/i,
        /tribunalToken/i,
        /authToken/i,
      ],
      userInputs: [
        /termo/i, // Portuguese: term
        /pesquisa/i, // Portuguese: search
        /consulta/i, // Portuguese: query
        /filtro/i, // Portuguese: filter
        /processo/i, // Portuguese: process
        /numero/i, // Portuguese: number
        /data/i, // Portuguese: date
      ],
      staticConstants: [
        /versao/i, // Portuguese: version
        /formato/i, // Portuguese: format
        /tribunal/i, // Portuguese: court
        /instancia/i, // Portuguese: instance
      ],
    },
    classification: "legal" as const,
  },
  ecommerce: {
    patterns: {
      sessionTokens: [/cartId/i, /sessionId/i, /userToken/i, /checkoutId/i],
      userInputs: [
        /search/i,
        /query/i,
        /filter/i,
        /category/i,
        /price/i,
        /quantity/i,
      ],
      staticConstants: [/apiVersion/i, /currency/i, /locale/i, /store/i],
    },
    classification: "ecommerce" as const,
  },
  api: {
    patterns: {
      sessionTokens: [
        /accessToken/i,
        /refreshToken/i,
        /sessionKey/i,
        /apiKey/i,
      ],
      userInputs: [/id/i, /limit/i, /offset/i, /page/i, /size/i],
      staticConstants: [/version/i, /format/i, /endpoint/i],
    },
    classification: "api" as const,
  },
} as const;

/**
 * Apply domain-specific patterns for better classification
 */
export function applyDomainPatterns(
  parameters: string[],
  domain: keyof typeof DOMAIN_PATTERN_LIBRARY,
  allRequests: RequestModel[]
): ClassifiedParameter[] {
  const domainPatterns = DOMAIN_PATTERN_LIBRARY[domain];
  const classifications: ClassifiedParameter[] = [];

  for (const param of parameters) {
    let classification: ParameterClassification = "dynamic";
    let confidence = 0.5;
    let reasoning = "No domain pattern match";

    // Check session tokens
    for (const pattern of domainPatterns.patterns.sessionTokens) {
      if (pattern.test(param)) {
        classification = "sessionConstant";
        confidence = 0.9;
        reasoning = `Matches ${domain} session token pattern`;
        break;
      }
    }

    // Check user inputs
    if (classification === "dynamic") {
      for (const pattern of domainPatterns.patterns.userInputs) {
        if (pattern.test(param)) {
          classification = "userInput";
          confidence = 0.85;
          reasoning = `Matches ${domain} user input pattern`;
          break;
        }
      }
    }

    // Check static constants
    if (classification === "dynamic") {
      for (const pattern of domainPatterns.patterns.staticConstants) {
        if (pattern.test(param)) {
          classification = "staticConstant";
          confidence = 0.8;
          reasoning = `Matches ${domain} static constant pattern`;
          break;
        }
      }
    }

    classifications.push({
      name: extractParameterName(param),
      value: param,
      classification,
      confidence,
      source: "heuristic",
      metadata: {
        occurrenceCount: countParameterOccurrences(param, allRequests),
        totalRequests: allRequests.length,
        consistencyScore: 1.0,
        parameterPattern: generateParameterPattern(param),
        domainContext: `${domain}: ${reasoning}`,
      },
    });
  }

  return classifications;
}

/**
 * Detect domain based on URL patterns and request characteristics
 */
export function detectDomain(
  requests: RequestModel[]
): keyof typeof DOMAIN_PATTERN_LIBRARY | "unknown" {
  const urls = requests.map((r) => r.url.toLowerCase()).join(" ");

  // Legal domain detection
  if (
    urls.includes("jurisprudencia") ||
    urls.includes("tribunal") ||
    urls.includes("jus.br") ||
    urls.includes("legal") ||
    urls.includes("processo")
  ) {
    return "legal";
  }

  // E-commerce domain detection
  if (
    urls.includes("shop") ||
    urls.includes("cart") ||
    urls.includes("checkout") ||
    urls.includes("product") ||
    urls.includes("order")
  ) {
    return "ecommerce";
  }

  // API domain detection
  if (
    urls.includes("/api/") ||
    urls.includes("/v1/") ||
    urls.includes("/v2/") ||
    urls.includes("graphql")
  ) {
    return "api";
  }

  return "unknown";
}

/**
 * Graceful fallback when parameter classification fails
 */
export function gracefulClassificationFallback(
  parameters: string[],
  allRequests: RequestModel[]
): ClassifiedParameter[] {
  return parameters.map((param) => {
    // Simple heuristics as fallback
    let classification: ParameterClassification = "dynamic";
    let confidence = 0.3;
    let reasoning = "Fallback classification";

    // Very high consistency suggests session constant
    const occurrences = countParameterOccurrences(param, allRequests);
    const consistency =
      allRequests.length > 0 ? occurrences / allRequests.length : 0;

    if (consistency > 0.95) {
      classification = "sessionConstant";
      confidence = 0.7;
      reasoning = "High consistency suggests session constant";
    } else if (consistency < 0.2) {
      classification = "userInput";
      confidence = 0.6;
      reasoning = "Low consistency suggests user input";
    }

    // Simple name patterns
    if (
      param.toLowerCase().includes("token") ||
      param.toLowerCase().includes("session")
    ) {
      classification = "sessionConstant";
      confidence = 0.8;
      reasoning = "Contains token/session keyword";
    }

    if (
      param.toLowerCase().includes("search") ||
      param.toLowerCase().includes("query")
    ) {
      classification = "userInput";
      confidence = 0.75;
      reasoning = "Contains search/query keyword";
    }

    return {
      name: extractParameterName(param),
      value: param,
      classification,
      confidence,
      source: "heuristic",
      metadata: {
        occurrenceCount: occurrences,
        totalRequests: allRequests.length,
        consistencyScore: consistency,
        parameterPattern: generateParameterPattern(param),
        domainContext: `Fallback: ${reasoning}`,
      },
    };
  });
}
