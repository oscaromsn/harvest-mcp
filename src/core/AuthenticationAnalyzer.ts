import type { ParsedHARData, RequestModel } from "../types/index.js";
import { createComponentLogger } from "../utils/logger.js";

const logger = createComponentLogger("authentication-analyzer");

/**
 * Supported authentication types
 */
export type AuthenticationType =
  | "bearer_token"
  | "api_key"
  | "basic_auth"
  | "session_cookie"
  | "oauth"
  | "custom_header"
  | "url_parameter"
  | "none";

/**
 * Authentication requirement levels
 */
export type AuthenticationRequirement = "required" | "optional" | "none";

/**
 * Token lifecycle information
 */
export interface TokenLifecycle {
  isStatic: boolean;
  expiresIn?: number;
  refreshEndpoint?: string;
  refreshMethod?: string;
  generationEndpoint?: string;
  generationMethod?: string;
  expirationPattern?: string;
}

/**
 * Authentication endpoint information
 */
export interface AuthenticationEndpoint {
  url: string;
  method: string;
  purpose: "login" | "refresh" | "logout" | "validate";
  request?: RequestModel;
  responseContainsToken?: boolean;
}

/**
 * Individual request authentication analysis
 */
export interface RequestAuthenticationInfo {
  requestId: string;
  url: string;
  method: string;
  authenticationType: AuthenticationType;
  requirement: AuthenticationRequirement;
  tokens: TokenInfo[];
  authHeaders: Record<string, string>;
  authCookies: Record<string, string>;
  authParams: Record<string, string>;
  isAuthFailure: boolean;
  authErrorDetails?: {
    status: number;
    statusText: string;
    wwwAuthenticate?: string;
    errorMessage?: string;
  };
}

/**
 * Token information extracted from requests
 */
export interface TokenInfo {
  type: "bearer" | "api_key" | "session" | "csrf" | "custom";
  location: "header" | "cookie" | "url_param" | "body";
  name: string;
  value: string;
  isExpired?: boolean;
  expiresAt?: Date;
  scope?: string[];
}

/**
 * Comprehensive authentication analysis result
 */
export interface AuthenticationAnalysis {
  // Overall authentication summary
  hasAuthentication: boolean;
  primaryAuthType: AuthenticationType;
  authTypes: AuthenticationType[];

  // Request-level analysis
  authenticatedRequests: RequestAuthenticationInfo[];
  unauthenticatedRequests: RequestAuthenticationInfo[];
  failedAuthRequests: RequestAuthenticationInfo[];

  // Token analysis
  tokens: TokenInfo[];
  tokenLifecycle: TokenLifecycle;

  // Authentication flow
  authEndpoints: AuthenticationEndpoint[];
  authFlow: {
    hasLoginFlow: boolean;
    hasRefreshFlow: boolean;
    hasLogoutFlow: boolean;
    flowComplexity: "simple" | "moderate" | "complex";
  };

  // Security concerns
  securityIssues: string[];
  recommendations: string[];

  // Code generation readiness
  codeGeneration: {
    isReady: boolean;
    requiredSetup: string[];
    supportedPatterns: string[];
    hardcodedTokens: string[];
    dynamicTokens: string[];
  };
}

/**
 * Main authentication analyzer class
 */
export class AuthenticationAnalyzer {
  /**
   * Analyze authentication patterns in parsed HAR data
   */
  static async analyzeHARData(
    harData: ParsedHARData
  ): Promise<AuthenticationAnalysis> {
    logger.info("Starting comprehensive authentication analysis");

    const analyzer = new AuthenticationAnalyzer();

    // Analyze each request for authentication patterns
    const requestAnalysis = analyzer.analyzeRequests(harData.requests);

    // Extract and analyze tokens
    const tokens = analyzer.extractTokens(harData.requests);

    // Analyze token lifecycle
    const tokenLifecycle = analyzer.analyzeTokenLifecycle(
      harData.requests,
      tokens
    );

    // Identify authentication endpoints
    const authEndpoints = analyzer.identifyAuthEndpoints(harData.requests);

    // Analyze authentication flow
    const authFlow = analyzer.analyzeAuthFlow(authEndpoints, harData.requests);

    // Determine primary authentication type
    const primaryAuthType = analyzer.determinePrimaryAuthType(requestAnalysis);

    // Identify security issues and generate recommendations
    const securityAnalysis = analyzer.analyzeSecurityConcerns(
      requestAnalysis,
      tokens
    );

    // Assess code generation readiness
    const codeGenAnalysis = analyzer.assessCodeGenerationReadiness(
      requestAnalysis,
      tokens,
      tokenLifecycle
    );

    const analysis: AuthenticationAnalysis = {
      hasAuthentication: requestAnalysis.authenticatedRequests.length > 0,
      primaryAuthType,
      authTypes: [
        ...new Set(
          requestAnalysis.authenticatedRequests.map((r) => r.authenticationType)
        ),
      ],

      authenticatedRequests: requestAnalysis.authenticatedRequests,
      unauthenticatedRequests: requestAnalysis.unauthenticatedRequests,
      failedAuthRequests: requestAnalysis.failedAuthRequests,

      tokens,
      tokenLifecycle,

      authEndpoints,
      authFlow,

      securityIssues: securityAnalysis.issues,
      recommendations: securityAnalysis.recommendations,

      codeGeneration: codeGenAnalysis,
    };

    logger.info(
      `Authentication analysis complete: ${analysis.authTypes.join(", ")} detected`
    );
    return analysis;
  }

  /**
   * Analyze individual requests for authentication patterns
   */
  private analyzeRequests(requests: RequestModel[]): {
    authenticatedRequests: RequestAuthenticationInfo[];
    unauthenticatedRequests: RequestAuthenticationInfo[];
    failedAuthRequests: RequestAuthenticationInfo[];
  } {
    const authenticatedRequests: RequestAuthenticationInfo[] = [];
    const unauthenticatedRequests: RequestAuthenticationInfo[] = [];
    const failedAuthRequests: RequestAuthenticationInfo[] = [];

    for (let i = 0; i < requests.length; i++) {
      const request = requests[i];
      if (!request) {
        continue;
      }

      const authInfo = this.analyzeRequest(request, i.toString());

      if (authInfo.isAuthFailure) {
        failedAuthRequests.push(authInfo);
      } else if (authInfo.authenticationType !== "none") {
        authenticatedRequests.push(authInfo);
      } else {
        unauthenticatedRequests.push(authInfo);
      }
    }

    return {
      authenticatedRequests,
      unauthenticatedRequests,
      failedAuthRequests,
    };
  }

  /**
   * Analyze a single request for authentication information
   */
  private analyzeRequest(
    request: RequestModel,
    requestId: string
  ): RequestAuthenticationInfo {
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
      isAuthFailure: false,
    };

    // Check for authentication failures first
    if (request.response?.status === 401 || request.response?.status === 403) {
      authInfo.isAuthFailure = true;
      authInfo.requirement = "required";
      const wwwAuth =
        request.response.headers?.["www-authenticate"] ||
        request.response.headers?.["WWW-Authenticate"];
      const errorMessage = this.extractErrorMessage(request.response);

      authInfo.authErrorDetails = {
        status: request.response.status,
        statusText: request.response.statusText || "",
        ...(wwwAuth && { wwwAuthenticate: wwwAuth }),
        ...(errorMessage && { errorMessage }),
      };
    }

    // Analyze headers for authentication
    for (const [headerName, headerValue] of Object.entries(request.headers)) {
      const lowerName = headerName.toLowerCase();

      if (lowerName === "authorization") {
        authInfo.authHeaders[headerName] = headerValue;
        authInfo.authenticationType =
          this.getAuthTypeFromAuthHeader(headerValue);
        authInfo.requirement = "required";

        // Extract token from Authorization header
        const token = this.extractTokenFromAuthHeader(headerValue);
        if (token) {
          authInfo.tokens.push(token);
        }
      } else if (lowerName === "cookie") {
        authInfo.authCookies = this.parseCookieHeader(headerValue);
        if (Object.keys(authInfo.authCookies).length > 0) {
          authInfo.authenticationType = "session_cookie";
          authInfo.requirement = "required";

          // Extract session tokens from cookies
          const sessionTokens = this.extractTokensFromCookies(
            authInfo.authCookies
          );
          authInfo.tokens.push(...sessionTokens);
        }
      } else if (
        lowerName.includes("api-key") ||
        lowerName.includes("x-api-key")
      ) {
        authInfo.authHeaders[headerName] = headerValue;
        authInfo.authenticationType = "api_key";
        authInfo.requirement = "required";

        authInfo.tokens.push({
          type: "api_key",
          location: "header",
          name: headerName,
          value: headerValue,
        });
      } else if (lowerName.includes("auth") || lowerName.includes("token")) {
        authInfo.authHeaders[headerName] = headerValue;
        authInfo.authenticationType = "custom_header";
        authInfo.requirement = "required";

        authInfo.tokens.push({
          type: "custom",
          location: "header",
          name: headerName,
          value: headerValue,
        });
      }
    }

    // Analyze URL parameters for authentication
    if (request.queryParams) {
      for (const [paramName, paramValue] of Object.entries(
        request.queryParams
      )) {
        const lowerName = paramName.toLowerCase();

        if (
          lowerName.includes("token") ||
          lowerName.includes("api") ||
          lowerName.includes("auth")
        ) {
          authInfo.authParams[paramName] = paramValue;
          if (authInfo.authenticationType === "none") {
            authInfo.authenticationType = "url_parameter";
            authInfo.requirement = "required";
          }

          authInfo.tokens.push({
            type: "custom",
            location: "url_param",
            name: paramName,
            value: paramValue,
          });
        }
      }
    }

    return authInfo;
  }

  /**
   * Extract all tokens from requests
   */
  private extractTokens(requests: RequestModel[]): TokenInfo[] {
    const tokens: TokenInfo[] = [];
    const seenTokens = new Set<string>();

    for (const request of requests) {
      // Extract from Authorization headers
      const authHeader =
        request.headers.Authorization || request.headers.authorization;
      if (authHeader) {
        const token = this.extractTokenFromAuthHeader(authHeader);
        if (token && !seenTokens.has(token.value)) {
          tokens.push(token);
          seenTokens.add(token.value);
        }
      }

      // Extract from cookies
      const cookieHeader = request.headers.Cookie || request.headers.cookie;
      if (cookieHeader) {
        const cookieTokens = this.extractTokensFromCookies(
          this.parseCookieHeader(cookieHeader)
        );
        for (const token of cookieTokens) {
          if (!seenTokens.has(token.value)) {
            tokens.push(token);
            seenTokens.add(token.value);
          }
        }
      }

      // Extract from URL parameters
      if (request.queryParams) {
        for (const [name, value] of Object.entries(request.queryParams)) {
          if (this.isTokenParameter(name, value) && !seenTokens.has(value)) {
            tokens.push({
              type: "custom",
              location: "url_param",
              name,
              value,
            });
            seenTokens.add(value);
          }
        }
      }
    }

    return tokens;
  }

  /**
   * Analyze token lifecycle patterns
   */
  private analyzeTokenLifecycle(
    requests: RequestModel[],
    _tokens: TokenInfo[]
  ): TokenLifecycle {
    // Basic implementation - can be enhanced with more sophisticated analysis
    const lifecycle: TokenLifecycle = {
      isStatic: true,
    };

    // Check if tokens appear to be generated dynamically
    const tokenGenerationEndpoint = this.findTokenGenerationEndpoint(requests);
    if (tokenGenerationEndpoint) {
      lifecycle.isStatic = false;
      lifecycle.generationEndpoint = tokenGenerationEndpoint.url;
      lifecycle.generationMethod = tokenGenerationEndpoint.method;
    }

    // Look for refresh endpoints
    const refreshEndpoint = this.findTokenRefreshEndpoint(requests);
    if (refreshEndpoint) {
      lifecycle.refreshEndpoint = refreshEndpoint.url;
      lifecycle.refreshMethod = refreshEndpoint.method;
    }

    return lifecycle;
  }

  /**
   * Identify authentication-related endpoints
   */
  private identifyAuthEndpoints(
    requests: RequestModel[]
  ): AuthenticationEndpoint[] {
    const endpoints: AuthenticationEndpoint[] = [];

    for (const request of requests) {
      const url = request.url.toLowerCase();
      const method = request.method;

      let purpose: AuthenticationEndpoint["purpose"] | null = null;

      if (
        url.includes("/login") ||
        url.includes("/signin") ||
        url.includes("/auth")
      ) {
        purpose = "login";
      } else if (url.includes("/refresh") || url.includes("/renew")) {
        purpose = "refresh";
      } else if (url.includes("/logout") || url.includes("/signout")) {
        purpose = "logout";
      } else if (url.includes("/validate") || url.includes("/verify")) {
        purpose = "validate";
      }

      if (purpose) {
        endpoints.push({
          url: request.url,
          method,
          purpose,
          request,
          responseContainsToken: this.responseContainsToken(request.response),
        });
      }
    }

    return endpoints;
  }

  /**
   * Analyze authentication flow complexity
   */
  private analyzeAuthFlow(
    authEndpoints: AuthenticationEndpoint[],
    requests: RequestModel[]
  ): AuthenticationAnalysis["authFlow"] {
    const hasLoginFlow = authEndpoints.some((e) => e.purpose === "login");
    const hasRefreshFlow = authEndpoints.some((e) => e.purpose === "refresh");
    const hasLogoutFlow = authEndpoints.some((e) => e.purpose === "logout");

    let flowComplexity: "simple" | "moderate" | "complex" = "simple";

    if (hasRefreshFlow || authEndpoints.length > 2) {
      flowComplexity = "moderate";
    }

    if (authEndpoints.length > 4 || this.hasOAuthFlow(requests)) {
      flowComplexity = "complex";
    }

    return {
      hasLoginFlow,
      hasRefreshFlow,
      hasLogoutFlow,
      flowComplexity,
    };
  }

  /**
   * Determine the primary authentication type used
   */
  private determinePrimaryAuthType(requestAnalysis: {
    authenticatedRequests: RequestAuthenticationInfo[];
  }): AuthenticationType {
    const authTypeCounts = new Map<AuthenticationType, number>();

    for (const request of requestAnalysis.authenticatedRequests) {
      const current = authTypeCounts.get(request.authenticationType) || 0;
      authTypeCounts.set(request.authenticationType, current + 1);
    }

    if (authTypeCounts.size === 0) {
      return "none";
    }

    // Return the most common authentication type
    let maxCount = 0;
    let primaryType: AuthenticationType = "none";

    for (const [type, count] of authTypeCounts) {
      if (count > maxCount) {
        maxCount = count;
        primaryType = type;
      }
    }

    return primaryType;
  }

  /**
   * Analyze security concerns and generate recommendations
   */
  private analyzeSecurityConcerns(
    requestAnalysis: {
      authenticatedRequests: RequestAuthenticationInfo[];
      failedAuthRequests: RequestAuthenticationInfo[];
    },
    tokens: TokenInfo[]
  ): { issues: string[]; recommendations: string[] } {
    const issues: string[] = [];
    const recommendations: string[] = [];

    // Check for authentication failures
    if (requestAnalysis.failedAuthRequests.length > 0) {
      issues.push(
        `Found ${requestAnalysis.failedAuthRequests.length} authentication failures`
      );
      recommendations.push(
        "Verify authentication tokens are valid and not expired"
      );
    }

    // Check for tokens in URLs (security risk)
    const urlTokens = tokens.filter((t) => t.location === "url_param");
    if (urlTokens.length > 0) {
      issues.push(
        "Authentication tokens found in URL parameters (security risk)"
      );
      recommendations.push(
        "Move authentication tokens to headers for better security"
      );
    }

    // Check for potentially expired tokens
    const suspiciouslyShortTokens = tokens.filter((t) => t.value.length < 10);
    if (suspiciouslyShortTokens.length > 0) {
      issues.push("Found suspiciously short authentication tokens");
      recommendations.push(
        "Verify token validity and ensure they meet security requirements"
      );
    }

    return { issues, recommendations };
  }

  /**
   * Assess readiness for code generation
   */
  private assessCodeGenerationReadiness(
    requestAnalysis: {
      authenticatedRequests: RequestAuthenticationInfo[];
      failedAuthRequests: RequestAuthenticationInfo[];
    },
    tokens: TokenInfo[],
    tokenLifecycle: TokenLifecycle
  ): AuthenticationAnalysis["codeGeneration"] {
    const isReady =
      requestAnalysis.failedAuthRequests.length === 0 && tokens.length > 0;
    const requiredSetup: string[] = [];
    const supportedPatterns: string[] = [];
    const hardcodedTokens: string[] = [];
    const dynamicTokens: string[] = [];

    // Determine required setup
    if (!isReady) {
      requiredSetup.push("Fix authentication failures before code generation");
    }

    if (tokenLifecycle.isStatic) {
      requiredSetup.push("Manual token configuration will be required");
      hardcodedTokens.push(...tokens.map((t) => t.name));
    } else {
      requiredSetup.push("Implement token acquisition flow");
      dynamicTokens.push(...tokens.map((t) => t.name));
    }

    // Determine supported patterns
    const authTypes = [
      ...new Set(
        requestAnalysis.authenticatedRequests.map((r) => r.authenticationType)
      ),
    ];
    for (const authType of authTypes) {
      switch (authType) {
        case "bearer_token":
          supportedPatterns.push("Bearer Token Authentication");
          break;
        case "api_key":
          supportedPatterns.push("API Key Authentication");
          break;
        case "session_cookie":
          supportedPatterns.push("Session Cookie Authentication");
          break;
        case "basic_auth":
          supportedPatterns.push("Basic Authentication");
          break;
        default:
          supportedPatterns.push("Custom Authentication");
      }
    }

    return {
      isReady,
      requiredSetup,
      supportedPatterns,
      hardcodedTokens,
      dynamicTokens,
    };
  }

  // Helper methods for token and authentication analysis

  private getAuthTypeFromAuthHeader(authHeader: string): AuthenticationType {
    const lower = authHeader.toLowerCase();
    if (lower.startsWith("bearer")) {
      return "bearer_token";
    }
    if (lower.startsWith("basic")) {
      return "basic_auth";
    }
    return "custom_header";
  }

  private extractTokenFromAuthHeader(authHeader: string): TokenInfo | null {
    if (authHeader.toLowerCase().startsWith("bearer ")) {
      return {
        type: "bearer",
        location: "header",
        name: "Authorization",
        value: authHeader.substring(7).trim(),
      };
    }
    return null;
  }

  private parseCookieHeader(cookieHeader: string): Record<string, string> {
    const cookies: Record<string, string> = {};
    const parts = cookieHeader.split(";");

    for (const part of parts) {
      const [name, value] = part.trim().split("=");
      if (name && value) {
        cookies[name] = value;
      }
    }

    return cookies;
  }

  private extractTokensFromCookies(
    cookies: Record<string, string>
  ): TokenInfo[] {
    const tokens: TokenInfo[] = [];

    for (const [name, value] of Object.entries(cookies)) {
      const lowerName = name.toLowerCase();
      if (
        lowerName.includes("session") ||
        lowerName.includes("token") ||
        lowerName.includes("auth") ||
        lowerName.includes("csrf")
      ) {
        tokens.push({
          type: "session",
          location: "cookie",
          name,
          value,
        });
      }
    }

    return tokens;
  }

  private isTokenParameter(name: string, value: string): boolean {
    const lowerName = name.toLowerCase();
    return (
      (lowerName.includes("token") ||
        lowerName.includes("auth") ||
        lowerName.includes("api")) &&
      value.length > 8
    );
  }

  private findTokenGenerationEndpoint(
    requests: RequestModel[]
  ): { url: string; method: string } | null {
    for (const request of requests) {
      if (
        request.method === "POST" &&
        (request.url.includes("/login") || request.url.includes("/auth")) &&
        this.responseContainsToken(request.response)
      ) {
        return { url: request.url, method: request.method };
      }
    }
    return null;
  }

  private findTokenRefreshEndpoint(
    requests: RequestModel[]
  ): { url: string; method: string } | null {
    for (const request of requests) {
      if (request.url.includes("/refresh") || request.url.includes("/renew")) {
        return { url: request.url, method: request.method };
      }
    }
    return null;
  }

  private responseContainsToken(response: unknown): boolean {
    if (!response || typeof response !== "object") {
      return false;
    }

    const responseObj = response as { text?: string };
    if (!responseObj.text) {
      return false;
    }

    try {
      const text = responseObj.text.toLowerCase();
      return (
        text.includes("token") ||
        text.includes("access") ||
        text.includes("bearer")
      );
    } catch {
      return false;
    }
  }

  private hasOAuthFlow(requests: RequestModel[]): boolean {
    return requests.some(
      (r) =>
        r.url.includes("oauth") ||
        r.url.includes("authorize") ||
        r.url.includes("callback")
    );
  }

  private extractErrorMessage(response: unknown): string | undefined {
    if (!response || typeof response !== "object") {
      return undefined;
    }

    const responseObj = response as { text?: string };
    if (!responseObj.text) {
      return undefined;
    }

    try {
      const parsed = JSON.parse(responseObj.text);
      return parsed.error || parsed.message || parsed.error_description;
    } catch {
      return responseObj.text?.substring(0, 200);
    }
  }
}
