/**
 * Specialized templates for TypeScript type definition generation
 *
 * This module provides templates specifically for generating TypeScript
 * interfaces, types, and import/export statements.
 */

import { type CodeTemplate, templateEngine } from "./CodeTemplate.js";

/**
 * Type definition template configurations
 */
export const typeDefinitionTemplates: CodeTemplate[] = [
  {
    name: "interface",
    template: `interface {{interfaceName}} {
{{properties}}
}`,
    variables: [
      { name: "interfaceName", type: "identifier" },
      { name: "properties", type: "expression" },
    ],
    description: "Generate TypeScript interface definition",
  },
  {
    name: "interfaceProperty",
    template: "  {{propertyName}}{{optional}}: {{propertyType}};",
    variables: [
      { name: "propertyName", type: "identifier" },
      { name: "optional", type: "expression" },
      { name: "propertyType", type: "identifier" },
    ],
    description: "Generate interface property",
  },
  {
    name: "genericInterface",
    template: `interface {{interfaceName}}<{{genericParams}}> {
{{properties}}
}`,
    variables: [
      { name: "interfaceName", type: "identifier" },
      { name: "genericParams", type: "expression" },
      { name: "properties", type: "expression" },
    ],
    description: "Generate generic TypeScript interface",
  },
  {
    name: "classDefinition",
    template: `{{classModifier}}class {{className}} {
{{properties}}
{{methods}}
}`,
    variables: [
      { name: "classModifier", type: "expression" },
      { name: "className", type: "identifier" },
      { name: "properties", type: "expression" },
      { name: "methods", type: "expression" },
    ],
    description: "Generate TypeScript class definition",
  },
  {
    name: "exportStatement",
    template: "export { {{exports}} };",
    variables: [{ name: "exports", type: "expression" }],
    description: "Generate export statement",
  },
  {
    name: "exportTypeStatement",
    template: "export type { {{types}} };",
    variables: [{ name: "types", type: "expression" }],
    description: "Generate export type statement",
  },
  {
    name: "fileHeader",
    template: `// Harvest Generated API Integration Code
// ==========================================
//
// Original prompt: {{prompt}}
// Generated: {{date}}
// Session ID: {{sessionId}}
//
// DO NOT EDIT - This file is auto-generated
// To modify the API integration, re-run the Harvest analysis`,
    variables: [
      { name: "prompt", type: "string" },
      { name: "date", type: "string" },
      { name: "sessionId", type: "string" },
    ],
    description: "Generate file header with metadata",
  },
  {
    name: "apiResponseInterface",
    template: `interface ApiResponse<T = any> {
  success: boolean;
  data: T;
  status: number;
  headers: Record<string, string>;
}`,
    variables: [],
    description: "Standard API response interface",
  },
  {
    name: "requestOptionsInterface",
    template: `interface RequestOptions {
  method: string;
  headers: Record<string, string>;
  body?: string;
}`,
    variables: [],
    description: "Standard request options interface",
  },
  {
    name: "authConfigInterface",
    template: `interface AuthConfig {
  type: 'bearer' | 'api_key' | 'basic' | 'session' | 'custom';
  token?: string;
  apiKey?: string;
  username?: string;
  password?: string;
  sessionCookies?: Record<string, string>;
  customHeaders?: Record<string, string>;
  tokenRefreshUrl?: string;
  onTokenExpired?: () => Promise<string>;
}`,
    variables: [],
    description: "Authentication configuration interface",
  },
  {
    name: "authenticationError",
    template: `class AuthenticationError extends Error {
  constructor(message: string, public status: number, public response?: any) {
    super(message);
    this.name = 'AuthenticationError';
  }
}`,
    variables: [],
    description: "Authentication error class",
  },
  {
    name: "inferredResponseInterface",
    template: `interface {{interfaceName}} {
{{fields}}
}`,
    variables: [
      { name: "interfaceName", type: "identifier" },
      { name: "fields", type: "expression" },
    ],
    description: "Generate inferred response type interface",
  },
  {
    name: "mainFunction",
    template: `/**
 * Main function that executes the complete API workflow
 */
async function main(): Promise<ApiResponse> {
{{body}}
}`,
    variables: [{ name: "body", type: "expression" }],
    description: "Generate main orchestration function",
  },
  {
    name: "mainFunctionEmptyBody",
    template: `  throw new Error("No API functions found to execute");`,
    variables: [],
    description: "Generate main function body when no functions exist",
  },
  {
    name: "mainFunctionWithMaster",
    template: `  // Execute requests in dependency order
  const result = await {{masterFunctionName}}();
  return result;`,
    variables: [{ name: "masterFunctionName", type: "identifier" }],
    description: "Generate main function body with master function call",
  },
  {
    name: "exportBlock",
    template: `// Export all functions for individual use
export {
{{functionExports}}
  main
};`,
    variables: [{ name: "functionExports", type: "expression" }],
    description: "Generate export block with function list",
  },
  {
    name: "usageExample",
    template: `// Usage example:
// import { main } from "./generated-api-integration.ts";
// const result = await main();
// console.log(result.data);`,
    variables: [],
    description: "Generate usage example comment",
  },
];

/**
 * Register all type definition templates
 */
export function registerTypeDefinitionTemplates(): void {
  for (const template of typeDefinitionTemplates) {
    templateEngine.registerTemplate(template);
  }
}

/**
 * Helper functions for type definition generation
 */

/**
 * Generate TypeScript interface
 */
export function generateInterface(
  interfaceName: string,
  properties: Array<{ name: string; type: string; optional?: boolean }>
): string {
  const propertyStrings = properties.map((prop) =>
    templateEngine.render("interfaceProperty", {
      propertyName: prop.name,
      optional: prop.optional ? "?" : "",
      propertyType: prop.type,
    })
  );

  return templateEngine.render("interface", {
    interfaceName,
    properties: propertyStrings.join("\n"),
  });
}

/**
 * Generate generic interface
 */
export function generateGenericInterface(
  interfaceName: string,
  genericParams: string,
  properties: Array<{ name: string; type: string; optional?: boolean }>
): string {
  const propertyStrings = properties.map((prop) =>
    templateEngine.render("interfaceProperty", {
      propertyName: prop.name,
      optional: prop.optional ? "?" : "",
      propertyType: prop.type,
    })
  );

  return templateEngine.render("genericInterface", {
    interfaceName,
    genericParams,
    properties: propertyStrings.join("\n"),
  });
}

/**
 * Generate file header with metadata
 */
export function generateFileHeader(
  prompt: string,
  sessionId: string,
  date?: string
): string {
  return templateEngine.render("fileHeader", {
    prompt,
    date: date || new Date().toISOString().split("T")[0],
    sessionId,
  });
}

/**
 * Generate standard API response interface
 */
export function generateApiResponseInterface(): string {
  return templateEngine.render("apiResponseInterface", {});
}

/**
 * Generate request options interface
 */
export function generateRequestOptionsInterface(): string {
  return templateEngine.render("requestOptionsInterface", {});
}

/**
 * Generate auth config interface
 */
export function generateAuthConfigInterface(): string {
  return templateEngine.render("authConfigInterface", {});
}

/**
 * Generate authentication error class
 */
export function generateAuthenticationError(): string {
  return templateEngine.render("authenticationError", {});
}

/**
 * Generate export statement
 */
export function generateExportStatement(exports: string[]): string {
  return templateEngine.render("exportStatement", {
    exports: exports.join(",\n  "),
  });
}

/**
 * Generate export type statement
 */
export function generateExportTypeStatement(types: string[]): string {
  return templateEngine.render("exportTypeStatement", {
    types: types.join(", "),
  });
}

/**
 * Generate inferred response interface
 */
export function generateInferredResponseInterface(
  interfaceName: string,
  fields: Array<{ name: string; type: string; optional: boolean }>
): string {
  const fieldStrings = fields.map((field) =>
    templateEngine.render("interfaceProperty", {
      propertyName: field.name,
      optional: field.optional ? "?" : "",
      propertyType: field.type,
    })
  );

  return templateEngine.render("inferredResponseInterface", {
    interfaceName,
    fields: fieldStrings.join("\n"),
  });
}

/**
 * Generate main function
 */
export function generateMainFunction(body: string): string {
  return templateEngine.render("mainFunction", {
    body,
  });
}

/**
 * Generate complete type definitions section
 */
export function generateTypeDefinitions(
  inferredTypes?: Array<{
    interfaceName: string;
    fields: Array<{ name: string; type: string; optional: boolean }>;
  }>
): string {
  const parts: string[] = [];

  parts.push("// Type definitions");

  // Add inferred response types if provided
  if (inferredTypes && inferredTypes.length > 0) {
    parts.push("");
    parts.push("// Inferred response data types");
    for (const responseType of inferredTypes) {
      parts.push(
        generateInferredResponseInterface(
          responseType.interfaceName,
          responseType.fields
        )
      );
      parts.push("");
    }
  }

  // Add standard interfaces
  parts.push(generateApiResponseInterface());
  parts.push("");
  parts.push(generateRequestOptionsInterface());
  parts.push("");
  parts.push("// Authentication configuration interface");
  parts.push(generateAuthConfigInterface());
  parts.push("");
  parts.push("// Authentication error for retry logic");
  parts.push(generateAuthenticationError());
  parts.push("");
  parts.push(
    generateExportTypeStatement(["ApiResponse", "RequestOptions", "AuthConfig"])
  );
  parts.push("export { AuthenticationError };");

  return parts.join("\n");
}

/**
 * Generate main function body when no API functions exist
 */
export function generateMainFunctionEmptyBody(): string {
  return templateEngine.render("mainFunctionEmptyBody", {});
}

/**
 * Generate main function body with master function call
 */
export function generateMainFunctionWithMaster(
  masterFunctionName: string
): string {
  return templateEngine.render("mainFunctionWithMaster", {
    masterFunctionName,
  });
}

/**
 * Generate export block for functions
 */
export function generateExportBlock(functionNames: string[]): string {
  return templateEngine.render("exportBlock", {
    functionExports: functionNames.join(",\n  "),
  });
}

/**
 * Generate usage example comment
 */
export function generateUsageExample(importPath: string): string {
  return templateEngine.render("usageExample", {
    importPath,
  });
}

/**
 * Generate TypeScript class definition
 */
export function generateClassDefinition(
  className: string,
  properties: string,
  methods: string,
  classModifier = ""
): string {
  return templateEngine.render("classDefinition", {
    classModifier: classModifier ? `${classModifier} ` : "",
    className,
    properties,
    methods,
  });
}

// Auto-register templates when module is imported
registerTypeDefinitionTemplates();
