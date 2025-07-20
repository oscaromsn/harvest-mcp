import { getLLMClient } from "../core/LLMClient.js";
import type { FunctionDefinition } from "../core/providers/types.js";
import type {
  AuthenticationEndpoint,
  AuthenticationType,
  RequestAuthenticationInfo,
  RequestModel,
  TokenInfo,
} from "../types/index.js";
import { HarvestError } from "../types/index.js";
import { createComponentLogger } from "../utils/logger.js";

const logger = createComponentLogger("authentication-agent");

/**
 * LLM response for authentication analysis
 */
export interface AuthenticationAnalysisResponse {
  authentication_required: boolean;
  authentication_type: string;
  authentication_details: {
    tokens_found: Array<{
      type: string;
      location: string;
      name: string;
      value: string;
      description?: string;
    }>;
    auth_headers: Array<{
      name: string;
      value: string;
      purpose: string;
    }>;
    auth_cookies: Array<{
      name: string;
      value: string;
      purpose: string;
    }>;
    auth_parameters: Array<{
      name: string;
      value: string;
      location: string;
      purpose: string;
    }>;
  };
  security_concerns: string[];
  recommendations: string[];
}

/**
 * LLM response for authentication flow analysis
 */
export interface AuthenticationFlowResponse {
  flow_type: string;
  complexity: string;
  endpoints: Array<{
    url: string;
    method: string;
    purpose: string;
    generates_token: boolean;
    requires_token: boolean;
  }>;
  token_lifecycle: {
    generation_method: string;
    expiration_handling: string;
    refresh_mechanism: string;
  };
  implementation_guidance: string[];
}

/**
 * Authentication Agent - LLM-powered authentication analysis
 */
export namespace AuthenticationAgent {
  /**
   * Analyze a single request for authentication patterns using LLM
   */
  export async function analyzeRequest(
    request: RequestModel,
    requestId: string
  ): Promise<RequestAuthenticationInfo> {
    try {
      logger.debug(
        `Analyzing authentication for request ${requestId}: ${request.method} ${request.url}`
      );

      const llmClient = getLLMClient();
      const functionDef = createRequestAnalysisFunctionDefinition();
      const prompt = createRequestAnalysisPrompt(request);

      const response =
        await llmClient.callFunction<AuthenticationAnalysisResponse>(
          prompt,
          functionDef,
          "analyze_authentication"
        );

      // Convert LLM response to RequestAuthenticationInfo
      const authInfo = convertLLMResponseToAuthInfo(
        response,
        request,
        requestId
      );

      logger.debug(
        `Authentication analysis complete for ${requestId}: ${authInfo.authenticationType}`
      );
      return authInfo;
    } catch (error) {
      logger.error(
        `Authentication analysis failed for request ${requestId}:`,
        error
      );

      // Fallback to basic analysis if LLM fails
      return fallbackRequestAnalysis(request, requestId);
    }
  }

  /**
   * Analyze authentication flow across multiple requests using LLM
   */
  export async function analyzeAuthenticationFlow(
    requests: RequestModel[]
  ): Promise<{
    flowType: string;
    complexity: "simple" | "moderate" | "complex";
    authEndpoints: AuthenticationEndpoint[];
    implementationGuidance: string[];
  }> {
    try {
      logger.info(
        `Analyzing authentication flow across ${requests.length} requests`
      );

      const llmClient = getLLMClient();
      const functionDef = createFlowAnalysisFunctionDefinition();
      const prompt = createFlowAnalysisPrompt(requests);

      const response = await llmClient.callFunction<AuthenticationFlowResponse>(
        prompt,
        functionDef,
        "analyze_auth_flow"
      );

      // Convert LLM response to structured format
      const authEndpoints: AuthenticationEndpoint[] = response.endpoints.map(
        (endpoint) => ({
          url: endpoint.url,
          method: endpoint.method,
          purpose: endpoint.purpose as AuthenticationEndpoint["purpose"],
          responseContainsToken: endpoint.generates_token,
        })
      );

      const complexity = mapComplexity(response.complexity);

      logger.info(
        `Authentication flow analysis complete: ${response.flow_type} (${complexity})`
      );

      return {
        flowType: response.flow_type,
        complexity,
        authEndpoints,
        implementationGuidance: response.implementation_guidance,
      };
    } catch (error) {
      logger.error("Authentication flow analysis failed:", error);
      throw new HarvestError(
        `Authentication flow analysis failed: ${error instanceof Error ? error.message : "Unknown error"}`,
        "AUTHENTICATION_FLOW_ANALYSIS_FAILED",
        { originalError: error }
      );
    }
  }

  /**
   * Analyze authentication errors and provide remediation suggestions
   */
  export async function analyzeAuthenticationErrors(
    failedRequests: RequestModel[]
  ): Promise<{
    errorPatterns: string[];
    remediationSteps: string[];
    codeGenImpact: string[];
  }> {
    if (failedRequests.length === 0) {
      return {
        errorPatterns: [],
        remediationSteps: [],
        codeGenImpact: [],
      };
    }

    try {
      logger.info(`Analyzing ${failedRequests.length} authentication failures`);

      const llmClient = getLLMClient();
      const functionDef = createErrorAnalysisFunctionDefinition();
      const prompt = createErrorAnalysisPrompt(failedRequests);

      const response = await llmClient.callFunction<{
        error_patterns: string[];
        remediation_steps: string[];
        code_generation_impact: string[];
      }>(prompt, functionDef, "analyze_auth_errors");

      return {
        errorPatterns: response.error_patterns,
        remediationSteps: response.remediation_steps,
        codeGenImpact: response.code_generation_impact,
      };
    } catch (error) {
      logger.error("Authentication error analysis failed:", error);
      throw new HarvestError(
        `Authentication error analysis failed: ${error instanceof Error ? error.message : "Unknown error"}`,
        "AUTHENTICATION_ERROR_ANALYSIS_FAILED",
        { originalError: error }
      );
    }
  }

  /**
   * Generate authentication implementation recommendations
   */
  export async function generateImplementationRecommendations(
    authType: AuthenticationType,
    tokens: TokenInfo[],
    hasErrors: boolean
  ): Promise<{
    setupSteps: string[];
    codePatterns: string[];
    securityConsiderations: string[];
    testingGuidance: string[];
  }> {
    try {
      logger.info(`Generating implementation recommendations for ${authType}`);

      const llmClient = getLLMClient();
      const functionDef = createImplementationFunctionDefinition();
      const prompt = createImplementationPrompt(authType, tokens, hasErrors);

      const response = await llmClient.callFunction<{
        setup_steps: string[];
        code_patterns: string[];
        security_considerations: string[];
        testing_guidance: string[];
      }>(prompt, functionDef, "generate_implementation_recommendations");

      return {
        setupSteps: response.setup_steps,
        codePatterns: response.code_patterns,
        securityConsiderations: response.security_considerations,
        testingGuidance: response.testing_guidance,
      };
    } catch (error) {
      logger.error("Implementation recommendation generation failed:", error);
      throw new HarvestError(
        `Implementation recommendation generation failed: ${error instanceof Error ? error.message : "Unknown error"}`,
        "IMPLEMENTATION_RECOMMENDATION_FAILED",
        { originalError: error }
      );
    }
  }

  // Function definition creators

  function createRequestAnalysisFunctionDefinition(): FunctionDefinition {
    return {
      name: "analyze_authentication",
      description:
        "Analyze a single HTTP request to identify authentication requirements and extract authentication data.",
      parameters: {
        type: "object",
        properties: {
          authentication_required: {
            type: "boolean",
            description:
              "Whether this request requires authentication to succeed",
          },
          authentication_type: {
            type: "string",
            enum: [
              "bearer_token",
              "api_key",
              "basic_auth",
              "session_cookie",
              "oauth",
              "custom_header",
              "url_parameter",
              "none",
            ],
            description: "The type of authentication mechanism used",
          },
          authentication_details: {
            type: "object",
            properties: {
              tokens_found: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    type: {
                      type: "string",
                      description:
                        "Type of token (bearer, api_key, session, csrf, custom)",
                    },
                    location: {
                      type: "string",
                      description:
                        "Where the token is located (header, cookie, url_param, body)",
                    },
                    name: {
                      type: "string",
                      description:
                        "Name of the header/cookie/parameter containing the token",
                    },
                    value: {
                      type: "string",
                      description: "The actual token value",
                    },
                    description: {
                      type: "string",
                      description: "Purpose or description of this token",
                    },
                  },
                },
                description: "Authentication tokens found in the request",
              },
              auth_headers: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    name: { type: "string", description: "Header name" },
                    value: { type: "string", description: "Header value" },
                    purpose: {
                      type: "string",
                      description: "Purpose of this authentication header",
                    },
                  },
                },
                description: "Authentication-related headers",
              },
              auth_cookies: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    name: { type: "string", description: "Cookie name" },
                    value: { type: "string", description: "Cookie value" },
                    purpose: {
                      type: "string",
                      description: "Purpose of this authentication cookie",
                    },
                  },
                },
                description: "Authentication-related cookies",
              },
              auth_parameters: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    name: { type: "string", description: "Parameter name" },
                    value: { type: "string", description: "Parameter value" },
                    location: {
                      type: "string",
                      description: "Parameter location (url, body)",
                    },
                    purpose: {
                      type: "string",
                      description: "Purpose of this authentication parameter",
                    },
                  },
                },
                description: "Authentication-related parameters",
              },
            },
          },
          security_concerns: {
            type: "array",
            items: { type: "string" },
            description:
              "Security concerns identified with this authentication approach",
          },
          recommendations: {
            type: "array",
            items: { type: "string" },
            description:
              "Recommendations for improving authentication security or implementation",
          },
        },
        required: [
          "authentication_required",
          "authentication_type",
          "authentication_details",
          "security_concerns",
          "recommendations",
        ],
      },
    };
  }

  function createFlowAnalysisFunctionDefinition(): FunctionDefinition {
    return {
      name: "analyze_auth_flow",
      description:
        "Analyze authentication flow patterns across multiple HTTP requests to understand the complete authentication workflow.",
      parameters: {
        type: "object",
        properties: {
          flow_type: {
            type: "string",
            description:
              "Type of authentication flow (e.g., 'Token-based', 'Session-based', 'OAuth', 'API Key', 'Mixed')",
          },
          complexity: {
            type: "string",
            enum: ["simple", "moderate", "complex"],
            description: "Complexity level of the authentication flow",
          },
          endpoints: {
            type: "array",
            items: {
              type: "object",
              properties: {
                url: { type: "string", description: "Endpoint URL" },
                method: { type: "string", description: "HTTP method" },
                purpose: {
                  type: "string",
                  description:
                    "Purpose of this endpoint (login, refresh, logout, validate)",
                },
                generates_token: {
                  type: "boolean",
                  description:
                    "Whether this endpoint generates authentication tokens",
                },
                requires_token: {
                  type: "boolean",
                  description:
                    "Whether this endpoint requires authentication tokens",
                },
              },
            },
            description: "Authentication-related endpoints identified",
          },
          token_lifecycle: {
            type: "object",
            properties: {
              generation_method: {
                type: "string",
                description: "How tokens are generated",
              },
              expiration_handling: {
                type: "string",
                description: "How token expiration is handled",
              },
              refresh_mechanism: {
                type: "string",
                description: "How tokens are refreshed",
              },
            },
          },
          implementation_guidance: {
            type: "array",
            items: { type: "string" },
            description:
              "Step-by-step guidance for implementing this authentication flow",
          },
        },
        required: [
          "flow_type",
          "complexity",
          "endpoints",
          "token_lifecycle",
          "implementation_guidance",
        ],
      },
    };
  }

  function createErrorAnalysisFunctionDefinition(): FunctionDefinition {
    return {
      name: "analyze_auth_errors",
      description:
        "Analyze authentication error patterns to provide remediation guidance.",
      parameters: {
        type: "object",
        properties: {
          error_patterns: {
            type: "array",
            items: { type: "string" },
            description:
              "Common error patterns identified in failed authentication requests",
          },
          remediation_steps: {
            type: "array",
            items: { type: "string" },
            description:
              "Step-by-step remediation steps to fix authentication issues",
          },
          code_generation_impact: {
            type: "array",
            items: { type: "string" },
            description:
              "How these authentication errors will impact code generation",
          },
        },
        required: [
          "error_patterns",
          "remediation_steps",
          "code_generation_impact",
        ],
      },
    };
  }

  function createImplementationFunctionDefinition(): FunctionDefinition {
    return {
      name: "generate_implementation_recommendations",
      description:
        "Generate specific implementation recommendations for authentication patterns.",
      parameters: {
        type: "object",
        properties: {
          setup_steps: {
            type: "array",
            items: { type: "string" },
            description:
              "Step-by-step setup instructions for implementing this authentication type",
          },
          code_patterns: {
            type: "array",
            items: { type: "string" },
            description:
              "Code patterns and snippets for implementing authentication",
          },
          security_considerations: {
            type: "array",
            items: { type: "string" },
            description: "Security considerations and best practices",
          },
          testing_guidance: {
            type: "array",
            items: { type: "string" },
            description: "Testing strategies and validation approaches",
          },
        },
        required: [
          "setup_steps",
          "code_patterns",
          "security_considerations",
          "testing_guidance",
        ],
      },
    };
  }

  // Prompt creators

  function createRequestAnalysisPrompt(request: RequestModel): string {
    const curlCommand = request.toString();
    const responseInfo = request.response
      ? `\nResponse Status: ${request.response.status}\nResponse Headers: ${JSON.stringify(request.response.headers, null, 2)}`
      : "";

    return `Analyze this HTTP request for authentication patterns:

${curlCommand}${responseInfo}

Task: Identify all authentication mechanisms, tokens, and security-related elements in this request. Pay special attention to:

1. Authorization headers (Bearer tokens, Basic auth, etc.)
2. API keys in headers or parameters
3. Session cookies and CSRF tokens
4. Authentication parameters in URL or body
5. Custom authentication headers
6. Response status codes indicating authentication issues (401, 403)

Focus on extracting the actual token values and understanding their purpose. Identify any security concerns or recommendations for implementation.`;
  }

  function createFlowAnalysisPrompt(requests: RequestModel[]): string {
    const requestSummaries = requests
      .slice(0, 20)
      .map((req, index) => {
        const responseStatus = req.response?.status
          ? ` (${req.response.status})`
          : "";
        return `${index + 1}. ${req.method} ${req.url}${responseStatus}`;
      })
      .join("\n");

    const authHeaders = requests.flatMap((req) =>
      Object.entries(req.headers).filter(
        ([name]) =>
          name.toLowerCase().includes("auth") ||
          name.toLowerCase().includes("token") ||
          name.toLowerCase() === "cookie"
      )
    );

    return `Analyze the authentication flow across these HTTP requests:

Requests:
${requestSummaries}

Authentication Headers Found:
${authHeaders.map(([name, value]) => `${name}: ${value.substring(0, 50)}...`).join("\n")}

Task: Understand the complete authentication workflow by analyzing:

1. Which endpoints are for authentication (login, refresh, logout)
2. How tokens are generated and used
3. Token lifecycle and refresh mechanisms
4. Overall flow complexity and patterns
5. Implementation requirements for code generation

Provide practical guidance for implementing this authentication flow in generated code.`;
  }

  function createErrorAnalysisPrompt(failedRequests: RequestModel[]): string {
    const errorSummaries = failedRequests
      .map((req, index) => {
        const status = req.response?.status || "unknown";
        const statusText = req.response?.statusText || "";
        const wwwAuth =
          req.response?.headers?.["www-authenticate"] ||
          req.response?.headers?.["WWW-Authenticate"] ||
          "";

        return `${index + 1}. ${req.method} ${req.url}
   Status: ${status} ${statusText}
   WWW-Authenticate: ${wwwAuth}
   Headers: ${Object.keys(req.headers).join(", ")}`;
      })
      .join("\n\n");

    return `Analyze these authentication failures to identify patterns and provide remediation:

Failed Requests:
${errorSummaries}

Task: Identify common authentication error patterns and provide specific remediation steps. Consider:

1. Missing or invalid authentication tokens
2. Expired credentials
3. Incorrect authentication methods
4. Missing required headers or parameters
5. Token format or encoding issues

Provide actionable remediation steps and explain how these errors will impact code generation.`;
  }

  function createImplementationPrompt(
    authType: AuthenticationType,
    tokens: TokenInfo[],
    hasErrors: boolean
  ): string {
    const tokenSummary = tokens
      .map(
        (token) =>
          `- ${token.type} token in ${token.location} (${token.name}): ${token.value.substring(0, 20)}...`
      )
      .join("\n");

    return `Generate implementation recommendations for this authentication setup:

Authentication Type: ${authType}
Has Authentication Errors: ${hasErrors}

Tokens Identified:
${tokenSummary}

Task: Provide comprehensive implementation guidance including:

1. Setup steps for configuring this authentication type
2. Code patterns for token management and API calls
3. Security considerations and best practices
4. Testing strategies and validation approaches

Focus on practical, actionable guidance for generating working authentication code.`;
  }

  // Helper methods

  function convertLLMResponseToAuthInfo(
    response: AuthenticationAnalysisResponse,
    request: RequestModel,
    requestId: string
  ): RequestAuthenticationInfo {
    const tokens: TokenInfo[] =
      response.authentication_details.tokens_found.map((token) => ({
        type: token.type as TokenInfo["type"],
        location: token.location as TokenInfo["location"],
        name: token.name,
        value: token.value,
      }));

    const authHeaders: Record<string, string> = {};
    for (const header of response.authentication_details.auth_headers) {
      authHeaders[header.name] = header.value;
    }

    const authCookies: Record<string, string> = {};
    for (const cookie of response.authentication_details.auth_cookies) {
      authCookies[cookie.name] = cookie.value;
    }

    const authParams: Record<string, string> = {};
    for (const param of response.authentication_details.auth_parameters) {
      authParams[param.name] = param.value;
    }

    // Check for authentication failure
    const isAuthFailure =
      request.response?.status === 401 || request.response?.status === 403;
    const authErrorDetails =
      isAuthFailure && request.response
        ? (() => {
            const wwwAuth =
              request.response?.headers?.["www-authenticate"] ||
              request.response?.headers?.["WWW-Authenticate"];
            const baseDetails = {
              status: Number(request.response.status),
              statusText: String(request.response.statusText || ""),
            };
            return wwwAuth
              ? { ...baseDetails, wwwAuthenticate: wwwAuth }
              : baseDetails;
          })()
        : undefined;

    const result: RequestAuthenticationInfo = {
      requestId,
      url: request.url,
      method: request.method,
      authenticationType: response.authentication_type as AuthenticationType,
      requirement: response.authentication_required ? "required" : "none",
      tokens,
      authHeaders,
      authCookies,
      authParams,
      isAuthFailure,
    };

    if (authErrorDetails) {
      result.authErrorDetails = authErrorDetails;
    }

    return result;
  }

  function fallbackRequestAnalysis(
    request: RequestModel,
    requestId: string
  ): RequestAuthenticationInfo {
    // Basic fallback analysis when LLM fails
    const authInfo: RequestAuthenticationInfo = {
      requestId,
      url: request.url,
      method: request.method,
      authenticationType: "none",
      requirement: "none",
      tokens: [],
      authHeaders: {},
      authCookies: {},
      authParams: {},
      isAuthFailure:
        request.response?.status === 401 || request.response?.status === 403,
    };

    // Simple header analysis
    for (const [name, value] of Object.entries(request.headers)) {
      if (name.toLowerCase() === "authorization") {
        authInfo.authenticationType = "bearer_token";
        authInfo.requirement = "required";
        authInfo.authHeaders[name] = String(value);
      }
    }

    return authInfo;
  }

  function mapComplexity(
    llmComplexity: string
  ): "simple" | "moderate" | "complex" {
    const lower = llmComplexity.toLowerCase();
    if (lower.includes("simple") || lower.includes("basic")) {
      return "simple";
    }
    if (lower.includes("complex") || lower.includes("advanced")) {
      return "complex";
    }
    return "moderate";
  }
}
