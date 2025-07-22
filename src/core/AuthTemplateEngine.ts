/**
 * Specialized templates for authentication code generation
 *
 * This module provides templates specifically for generating JavaScript/TypeScript
 * authentication setup code, including different auth types and retry logic.
 */

import { type CodeTemplate, templateEngine } from "./CodeTemplate.js";

/**
 * Authentication template configurations
 */
export const authTemplates: CodeTemplate[] = [
  {
    name: "authConfigCheck",
    template: `    // Authentication setup - IMPORTANT: Configure authConfig before using
    if (!authConfig) {
      throw new Error('Authentication required but authConfig not provided. See setup instructions below.');
    }`,
    variables: [],
    description: "Generate authentication config check",
  },
  {
    name: "bearerTokenAuth",
    template: `    // Bearer token authentication
    if (authConfig.type !== 'bearer' || !authConfig.token) {
      throw new Error('Bearer token required in authConfig.token');
    }
    headers["Authorization"] = "Bearer " + authConfig.token;`,
    variables: [],
    description: "Generate Bearer token authentication setup",
  },
  {
    name: "apiKeyAuth",
    template: `    // API key authentication
    if (authConfig.type !== 'api_key' || !authConfig.apiKey) {
      throw new Error('API key required in authConfig.apiKey');
    }
{{headerAssignments}}`,
    variables: [{ name: "headerAssignments", type: "expression" }],
    description: "Generate API key authentication setup",
  },
  {
    name: "basicAuth",
    template: `    // Basic authentication
    if (authConfig.type !== 'basic' || !authConfig.username || !authConfig.password) {
      throw new Error('Username and password required in authConfig for basic auth');
    }
    const basicAuth = btoa(authConfig.username + ":" + authConfig.password);
    headers["Authorization"] = "Basic " + basicAuth;`,
    variables: [],
    description: "Generate Basic authentication setup",
  },
  {
    name: "sessionCookieAuth",
    template: `    // Session cookie authentication
    if (authConfig.type !== 'session' || !authConfig.sessionCookies) {
      throw new Error('Session cookies required in authConfig.sessionCookies');
    }
    const cookiePairs = Object.entries(authConfig.sessionCookies)
      .map(([name, value]) => name + "=" + value)
      .join('; ');
    headers['Cookie'] = cookiePairs;`,
    variables: [],
    description: "Generate session cookie authentication setup",
  },
  {
    name: "customAuth",
    template: `    // Custom authentication
    if (authConfig.type !== 'custom' || !authConfig.customHeaders) {
      throw new Error('Custom authentication headers required in authConfig.customHeaders');
    }
    Object.assign(headers, authConfig.customHeaders);`,
    variables: [],
    description: "Generate custom authentication setup",
  },
  {
    name: "publicEndpointComment",
    template: "    // No authentication required - this is a public endpoint",
    variables: [],
    description: "Generate comment for public endpoints",
  },
  {
    name: "authErrorHandling",
    template: `    // Handle authentication errors with retry logic
    if (response.status === 401 || response.status === 403) {
      const authError = new AuthenticationError(
        "Authentication failed: " + response.status + " " + response.statusText,
        response.status,
        await response.text()
      );
      
      // If token refresh is available, attempt to refresh and retry
      if (authConfig?.onTokenExpired) {
        try {
          console.log('Attempting token refresh due to auth failure...');
          const newToken = await authConfig.onTokenExpired();
          // Update token and retry request
          if (authConfig.type === 'bearer' && newToken) {
            authConfig.token = newToken;
            options.headers["Authorization"] = "Bearer " + newToken;
            console.log('Token refreshed, retrying request...');
            // Retry the request once
            const retryResponse = await fetch({{urlExpression}}, options);
            if (retryResponse.ok) {
              return await processResponse(retryResponse);
            }
          }
        } catch (refreshError) {
          console.warn('Token refresh failed:', refreshError);
        }
      }
      
      throw authError;
    }`,
    variables: [{ name: "urlExpression", type: "expression" }],
    description: "Generate authentication error handling with retry logic",
  },
  {
    name: "authWarningComment",
    template: "    // WARNING: {{warningMessage}}",
    variables: [{ name: "warningMessage", type: "string" }],
    description: "Generate authentication warning comment",
  },
  {
    name: "apiKeyHeaderAssignment",
    template: `    headers['{{headerName}}'] = authConfig.apiKey;`,
    variables: [{ name: "headerName", type: "string" }],
    description: "Generate API key header assignment",
  },
  {
    name: "authenticationSetup",
    template: `{{authConfigCheck}}

{{warningComment}}

{{authImplementation}}`,
    variables: [
      { name: "authConfigCheck", type: "expression" },
      { name: "warningComment", type: "expression" },
      { name: "authImplementation", type: "expression" },
    ],
    description: "Generate complete authentication setup block",
  },
];

/**
 * Register all auth templates
 */
export function registerAuthTemplates(): void {
  for (const template of authTemplates) {
    templateEngine.registerTemplate(template);
  }
}

/**
 * Helper functions for authentication code generation
 */

/**
 * Generate authentication config check
 */
export function generateAuthConfigCheck(): string {
  return templateEngine.render("authConfigCheck", {});
}

/**
 * Generate Bearer token authentication
 */
export function generateBearerTokenAuth(): string {
  return templateEngine.render("bearerTokenAuth", {});
}

/**
 * Generate API key authentication
 */
export function generateApiKeyAuth(headerNames: string[]): string {
  const headerAssignments = headerNames
    .map((headerName) =>
      templateEngine.render("apiKeyHeaderAssignment", { headerName })
    )
    .join("\n");

  return templateEngine.render("apiKeyAuth", {
    headerAssignments,
  });
}

/**
 * Generate Basic authentication
 */
export function generateBasicAuth(): string {
  return templateEngine.render("basicAuth", {});
}

/**
 * Generate session cookie authentication
 */
export function generateSessionCookieAuth(): string {
  return templateEngine.render("sessionCookieAuth", {});
}

/**
 * Generate custom authentication
 */
export function generateCustomAuth(): string {
  return templateEngine.render("customAuth", {});
}

/**
 * Generate public endpoint comment
 */
export function generatePublicEndpointComment(): string {
  return templateEngine.render("publicEndpointComment", {});
}

/**
 * Generate authentication error handling
 */
export function generateAuthErrorHandling(urlExpression: string): string {
  return templateEngine.render("authErrorHandling", { urlExpression });
}

/**
 * Generate authentication warning comment
 */
export function generateAuthWarning(warningMessage: string): string {
  return templateEngine.render("authWarningComment", { warningMessage });
}

/**
 * Generate complete authentication setup based on auth type
 */
export function generateAuthenticationSetup(authInfo: {
  hasAuthentication: boolean;
  authType: string;
  authHeaders: string[];
  warningMessage?: string;
}): string {
  if (!authInfo.hasAuthentication) {
    return generatePublicEndpointComment();
  }

  const parts: string[] = [];

  // Add config check
  parts.push(generateAuthConfigCheck());
  parts.push("");

  // Add warning if present
  if (authInfo.warningMessage) {
    parts.push(generateAuthWarning(authInfo.warningMessage));
    parts.push("");
  }

  // Add authentication implementation based on type
  switch (authInfo.authType) {
    case "bearer_token":
      parts.push(generateBearerTokenAuth());
      break;
    case "api_key":
      parts.push(generateApiKeyAuth(authInfo.authHeaders));
      break;
    case "basic_auth":
      parts.push(generateBasicAuth());
      break;
    case "session_cookie":
      parts.push(generateSessionCookieAuth());
      break;
    case "custom_header":
    case "url_parameter":
      parts.push(generateCustomAuth());
      break;
    default:
      parts.push(generatePublicEndpointComment());
      break;
  }

  return parts.join("\n");
}

/**
 * Authentication type definitions for better type safety
 */
export type AuthenticationType =
  | "none"
  | "bearer_token"
  | "api_key"
  | "basic_auth"
  | "session_cookie"
  | "custom_header"
  | "url_parameter";

export interface AuthenticationInfo {
  hasAuthentication: boolean;
  authType: AuthenticationType;
  tokens: Array<{
    type: string;
    location: string;
    name: string;
    value: string;
  }>;
  authHeaders: string[];
  authCookies: string[];
  warningMessage?: string;
}

// Auto-register templates when module is imported
registerAuthTemplates();
