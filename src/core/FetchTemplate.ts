/**
 * Specialized templates for fetch operation code generation
 *
 * This module provides templates specifically for generating JavaScript fetch
 * operations that safely use template literals for URL construction.
 */

import { type CodeTemplate, templateEngine } from "./CodeTemplate.js";

/**
 * Fetch operation template configurations
 */
export const fetchTemplates: CodeTemplate[] = [
  {
    name: "fetchWithQueryParams",
    template:
      "const {{responseVariable}} = await fetch(`$${{{baseUrl}}}?$${{{queryParams}}}`, {",
    variables: [
      { name: "responseVariable", type: "identifier" },
      { name: "baseUrl", type: "identifier" },
      { name: "queryParams", type: "expression" },
    ],
    description: "Fetch request with template literal URL and query parameters",
  },
  {
    name: "fetchWithSimpleUrl",
    template:
      "const {{responseVariable}} = await fetch(`$${{{urlExpression}}}`, {",
    variables: [
      { name: "responseVariable", type: "identifier" },
      { name: "urlExpression", type: "expression" },
    ],
    description: "Simple fetch request with template literal URL",
  },
  {
    name: "fetchOptionsStart",
    template: "const {{responseVariable}} = await fetch({{url}}, {",
    variables: [
      { name: "responseVariable", type: "identifier" },
      { name: "url", type: "string" },
    ],
    description: "Start of fetch options block",
  },
  {
    name: "fetchMethod",
    template: "      method: {{method}},",
    variables: [{ name: "method", type: "string" }],
    description: "HTTP method for fetch request",
  },
  {
    name: "fetchHeaders",
    template: `      headers: {
{{headerEntries}}
      },`,
    variables: [{ name: "headerEntries", type: "expression" }],
    description: "Headers object for fetch request",
  },
  {
    name: "fetchBody",
    template: "      body: {{bodyContent}},",
    variables: [{ name: "bodyContent", type: "expression" }],
    description: "Body content for fetch request",
  },
];

/**
 * Register all fetch templates
 */
export function registerFetchTemplates(): void {
  for (const template of fetchTemplates) {
    templateEngine.registerTemplate(template);
  }
}

/**
 * Helper functions for fetch code generation
 */

/**
 * Generate fetch call with query parameters
 */
export function fetchWithQueryParams(
  responseVar: string,
  baseUrl: string,
  queryParamsExpr: string
): string {
  return templateEngine.render("fetchWithQueryParams", {
    responseVariable: responseVar,
    baseUrl,
    queryParams: queryParamsExpr,
  });
}

/**
 * Generate simple fetch call
 */
export function fetchSimple(
  responseVar: string,
  urlExpression: string
): string {
  return templateEngine.render("fetchWithSimpleUrl", {
    responseVariable: responseVar,
    urlExpression,
  });
}

/**
 * Generate fetch method specification
 */
export function fetchMethod(httpMethod: string): string {
  return templateEngine.render("fetchMethod", {
    method: JSON.stringify(httpMethod),
  });
}

/**
 * Generate fetch headers object
 */
export function fetchHeaders(headerEntries: string): string {
  return templateEngine.render("fetchHeaders", {
    headerEntries,
  });
}

/**
 * Generate fetch body specification
 */
export function fetchBody(bodyContent: string): string {
  return templateEngine.render("fetchBody", {
    bodyContent,
  });
}

/**
 * Generate complete fetch request with all options
 */
export function fetchComplete(options: {
  responseVariable: string;
  baseUrl: string;
  queryParams: string;
  method: string;
  headers?: string;
  body?: string;
}): string[] {
  const parts: string[] = [];

  // Start fetch call
  parts.push(
    fetchWithQueryParams(
      options.responseVariable,
      options.baseUrl,
      options.queryParams
    )
  );

  // Add method
  parts.push(fetchMethod(options.method));

  // Add headers if provided
  if (options.headers) {
    parts.push(fetchHeaders(options.headers));
  }

  // Add body if provided
  if (options.body) {
    parts.push(fetchBody(options.body));
  }

  // Close the options object
  parts.push("    });");

  return parts;
}

/**
 * Legacy class-based interface for backward compatibility
 * @deprecated Use the named functions instead
 */
export const FetchCodeGenerator = {
  withQueryParams: fetchWithQueryParams,
  simple: fetchSimple,
  method: fetchMethod,
  headers: fetchHeaders,
  body: fetchBody,
  complete: fetchComplete,
};

// Auto-register templates when module is imported
registerFetchTemplates();
