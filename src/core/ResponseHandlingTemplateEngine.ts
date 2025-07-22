/**
 * Specialized templates for response handling and processing code generation
 *
 * This module provides templates specifically for generating JavaScript/TypeScript
 * response processing code, including content type detection, JSON parsing, and variable extraction.
 */

import { type CodeTemplate, templateEngine } from "./CodeTemplate.js";

/**
 * Response handling template configurations
 */
export const responseHandlingTemplates: CodeTemplate[] = [
  {
    name: "contentTypeDetection",
    template: `    const contentType = response.headers.get('content-type') || '';
    let data: any;`,
    variables: [],
    description: "Generate content type detection code",
  },
  {
    name: "responseProcessing",
    template: `    if (contentType.includes('application/json')) {
      data = await response.json();
    } else {
      data = await response.text();
    }`,
    variables: [],
    description: "Generate response processing based on content type",
  },
  {
    name: "responseOkCheck",
    template: `    if (!response.ok) {
      throw new Error("Request failed: " + response.status + " " + response.statusText);
    }`,
    variables: [],
    description: "Generate response status check",
  },
  {
    name: "variableExtractionComment",
    template: `    // Extract variables for dependent requests:
{{extractions}}`,
    variables: [{ name: "extractions", type: "expression" }],
    description: "Generate variable extraction comments",
  },
  {
    name: "singleVariableExtraction",
    template: "    // {{variableName}} will be available in the response data",
    variables: [{ name: "variableName", type: "string" }],
    description: "Generate single variable extraction comment",
  },
  {
    name: "urlConstruction",
    template: `    const url = new URL('{{baseUrl}}');`,
    variables: [{ name: "baseUrl", type: "string" }],
    description: "Generate URL construction",
  },
  {
    name: "urlWithParams",
    template: `    const url = new URL('{{baseUrl}}');
    const searchParams = new URLSearchParams();
{{parameterSetup}}
    const finalUrl = url.toString() + (searchParams.toString() ? '?' + searchParams.toString() : '');`,
    variables: [
      { name: "baseUrl", type: "string" },
      { name: "parameterSetup", type: "expression" },
    ],
    description: "Generate URL construction with parameters",
  },
  {
    name: "staticParameter",
    template: `    url.searchParams.set('{{paramName}}', '{{paramValue}}');`,
    variables: [
      { name: "paramName", type: "string" },
      { name: "paramValue", type: "string" },
    ],
    description: "Generate static parameter assignment",
  },
  {
    name: "configurableParameter",
    template: `    if ({{paramName}} !== undefined && {{paramName}} !== null) {
      url.searchParams.set('{{paramKey}}', String({{paramName}}));
    }`,
    variables: [
      { name: "paramName", type: "identifier" },
      { name: "paramKey", type: "string" },
    ],
    description: "Generate configurable parameter assignment",
  },
  {
    name: "dynamicParameterComment",
    template: `    // TODO: Resolve '{{paramName}}' from previous API response
    url.searchParams.set('{{paramName}}', '{{placeholderValue}}'); // Placeholder value`,
    variables: [
      { name: "paramName", type: "string" },
      { name: "placeholderValue", type: "string" },
    ],
    description: "Generate dynamic parameter placeholder",
  },
  {
    name: "headersObject",
    template: `    const headers: Record<string, string> = {
{{headerEntries}}
    };`,
    variables: [{ name: "headerEntries", type: "expression" }],
    description: "Generate headers object",
  },
  {
    name: "headerEntry",
    template: `      '{{headerName}}': '{{headerValue}}',`,
    variables: [
      { name: "headerName", type: "string" },
      { name: "headerValue", type: "string" },
    ],
    description: "Generate single header entry",
  },
  {
    name: "skippedHeaderEntry",
    template: `      // '{{headerName}}': SKIPPED - Will be set dynamically based on authConfig`,
    variables: [{ name: "headerName", type: "string" }],
    description: "Generate skipped header comment",
  },
  {
    name: "requestOptions",
    template: `    const options: RequestOptions = {
      method: '{{method}}',
      headers,
{{bodyEntry}}
    };`,
    variables: [
      { name: "method", type: "string" },
      { name: "bodyEntry", type: "expression" },
    ],
    description: "Generate request options object",
  },
  {
    name: "requestBody",
    template: "      body: {{bodyContent}},",
    variables: [{ name: "bodyContent", type: "expression" }],
    description: "Generate request body entry",
  },
  {
    name: "jsonBody",
    template: "JSON.stringify({{jsonData}})",
    variables: [{ name: "jsonData", type: "expression" }],
    description: "Generate JSON stringified body",
  },
  {
    name: "stringBody",
    template: `'{{bodyString}}'`,
    variables: [{ name: "bodyString", type: "string" }],
    description: "Generate string body",
  },
  {
    name: "fetchCall",
    template: "    const response = await fetch({{urlExpression}}, options);",
    variables: [{ name: "urlExpression", type: "expression" }],
    description: "Generate fetch call",
  },
  {
    name: "cookieNodeComment",
    template: `// Cookie: {{cookieKey}}
// Value: {{cookieValue}}
// This cookie should be included in requests that need it`,
    variables: [
      { name: "cookieKey", type: "string" },
      { name: "cookieValue", type: "string" },
    ],
    description: "Generate cookie node documentation",
  },
  {
    name: "notFoundNodeFunction",
    template: `// WARNING: Could not resolve {{missingPart}}
function {{functionName}}(): never {
  throw new Error('Missing dependency: {{missingPart}}. This value needs to be provided manually.');
}`,
    variables: [
      { name: "missingPart", type: "string" },
      { name: "functionName", type: "identifier" },
    ],
    description: "Generate not found node function",
  },
];

/**
 * Register all response handling templates
 */
export function registerResponseHandlingTemplates(): void {
  for (const template of responseHandlingTemplates) {
    templateEngine.registerTemplate(template);
  }
}

/**
 * Helper functions for response handling code generation
 */

/**
 * Generate content type detection and data parsing
 */
export function generateResponseProcessing(): string {
  const parts: string[] = [];
  parts.push(templateEngine.render("contentTypeDetection", {}));
  parts.push("");
  parts.push(templateEngine.render("responseProcessing", {}));
  return parts.join("\n");
}

/**
 * Generate response status check
 */
export function generateResponseOkCheck(): string {
  return templateEngine.render("responseOkCheck", {});
}

/**
 * Generate variable extraction comments
 */
export function generateVariableExtractionComments(
  extractedParts: string[]
): string {
  if (extractedParts.length === 0) {
    return "";
  }

  const extractions = extractedParts
    .map((part) =>
      templateEngine.render("singleVariableExtraction", { variableName: part })
    )
    .join("\n");

  return templateEngine.render("variableExtractionComment", { extractions });
}

/**
 * Generate URL construction
 */
export function generateUrlConstruction(baseUrl: string): string {
  return templateEngine.render("urlConstruction", { baseUrl });
}

/**
 * Generate URL construction with parameters
 */
export function generateUrlWithParams(
  baseUrl: string,
  parameterSetup: string
): string {
  return templateEngine.render("urlWithParams", { baseUrl, parameterSetup });
}

/**
 * Generate static parameter assignment
 */
export function generateStaticParameter(
  paramName: string,
  paramValue: string
): string {
  return templateEngine.render("staticParameter", { paramName, paramValue });
}

/**
 * Generate configurable parameter assignment
 */
export function generateConfigurableParameter(
  paramName: string,
  paramKey: string
): string {
  return templateEngine.render("configurableParameter", {
    paramName,
    paramKey,
  });
}

/**
 * Generate dynamic parameter placeholder
 */
export function generateDynamicParameterComment(
  paramName: string,
  placeholderValue: string
): string {
  return templateEngine.render("dynamicParameterComment", {
    paramName,
    placeholderValue,
  });
}

/**
 * Generate headers object
 */
export function generateHeadersObject(
  headers: Record<string, string>,
  skipAuthHeaders = true
): string {
  const authHeaders = ["authorization", "cookie", "x-api-key", "auth-token"];
  const entries: string[] = [];

  for (const [key, value] of Object.entries(headers)) {
    const lowerKey = key.toLowerCase();
    const isAuthHeader =
      skipAuthHeaders &&
      authHeaders.some((authHeader) => lowerKey.includes(authHeader));

    if (isAuthHeader) {
      entries.push(
        templateEngine.render("skippedHeaderEntry", { headerName: key })
      );
    } else {
      const escapedValue = value.replace(/'/g, "\\'");
      entries.push(
        templateEngine.render("headerEntry", {
          headerName: key,
          headerValue: escapedValue,
        })
      );
    }
  }

  return templateEngine.render("headersObject", {
    headerEntries: entries.join("\n"),
  });
}

/**
 * Generate request options object
 */
export function generateRequestOptions(method: string, body?: unknown): string {
  let bodyEntry = "";
  if (body) {
    if (typeof body === "object") {
      const jsonContent = templateEngine.render("jsonBody", {
        jsonData: JSON.stringify(body, null, 6),
      });
      bodyEntry = templateEngine.render("requestBody", {
        bodyContent: jsonContent,
      });
    } else {
      const escapedBody = String(body).replace(/'/g, "\\'");
      const stringContent = templateEngine.render("stringBody", {
        bodyString: escapedBody,
      });
      bodyEntry = templateEngine.render("requestBody", {
        bodyContent: stringContent,
      });
    }
  }

  return templateEngine.render("requestOptions", { method, bodyEntry });
}

/**
 * Generate fetch call
 */
export function generateFetchCall(urlExpression: string): string {
  return templateEngine.render("fetchCall", { urlExpression });
}

/**
 * Generate cookie node comment
 */
export function generateCookieNodeComment(
  cookieKey: string,
  cookieValue: string
): string {
  return templateEngine.render("cookieNodeComment", { cookieKey, cookieValue });
}

/**
 * Generate not found node function
 */
export function generateNotFoundNodeFunction(
  functionName: string,
  missingPart: string
): string {
  return templateEngine.render("notFoundNodeFunction", {
    functionName,
    missingPart,
  });
}

/**
 * Generate complete parameter setup code
 */
export function generateParameterSetup(parameters: {
  static: Array<{ key: string; value: string }>;
  configurable: Array<{ key: string; paramName: string }>;
  dynamic: Array<{ key: string; value: string }>;
}): string {
  const parts: string[] = [];

  // Static parameters
  if (parameters.static.length > 0) {
    parts.push("    // Static parameters");
    for (const param of parameters.static) {
      parts.push(generateStaticParameter(param.key, param.value));
    }
    parts.push("");
  }

  // Configurable parameters
  if (parameters.configurable.length > 0) {
    parts.push("    // Configurable parameters");
    for (const param of parameters.configurable) {
      parts.push(generateConfigurableParameter(param.paramName, param.key));
    }
    parts.push("");
  }

  // Dynamic parameters
  if (parameters.dynamic.length > 0) {
    parts.push("    // Dynamic parameters (resolved from previous requests)");
    for (const param of parameters.dynamic) {
      parts.push(generateDynamicParameterComment(param.key, param.value));
    }
    parts.push("");
  }

  return parts.join("\n");
}

// Auto-register templates when module is imported
registerResponseHandlingTemplates();
