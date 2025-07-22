/**
 * Specialized templates for function code generation
 *
 * This module provides templates specifically for generating JavaScript/TypeScript
 * functions, including signatures, JSDoc documentation, and function bodies.
 */

import { type CodeTemplate, templateEngine } from "./CodeTemplate.js";

/**
 * Function template configurations
 */
export const functionTemplates: CodeTemplate[] = [
  {
    name: "jsdocComment",
    template: `/**
 * {{description}}
{{#additionalLines}}
 * {{line}}
{{/additionalLines}}
 */`,
    variables: [
      { name: "description", type: "string" },
      { name: "additionalLines", type: "expression" },
    ],
    description: "Generate JSDoc comment block",
  },
  {
    name: "asyncFunction",
    template: `async function {{functionName}}({{parameters}}): Promise<{{returnType}}> {
{{body}}
}`,
    variables: [
      { name: "functionName", type: "identifier" },
      { name: "parameters", type: "expression" },
      { name: "returnType", type: "expression" },
      { name: "body", type: "expression" },
    ],
    description: "Generate async function declaration",
  },
  {
    name: "functionWithDocumentation",
    template: `{{documentation}}
async function {{functionName}}({{parameters}}): Promise<{{returnType}}> {
{{body}}
}`,
    variables: [
      { name: "documentation", type: "expression" },
      { name: "functionName", type: "identifier" },
      { name: "parameters", type: "expression" },
      { name: "returnType", type: "expression" },
      { name: "body", type: "expression" },
    ],
    description: "Generate async function with JSDoc documentation",
  },
  {
    name: "tryBlock",
    template: `  try {
{{body}}
  }`,
    variables: [{ name: "body", type: "expression" }],
    description: "Generate try block with indented body",
  },
  {
    name: "catchBlock",
    template: `  } catch (error) {
    throw new Error(\`{{functionName}} failed: \${error instanceof Error ? error.message : 'Unknown error'}\`);
  }`,
    variables: [{ name: "functionName", type: "identifier" }],
    description: "Generate catch block with function-specific error message",
  },
  {
    name: "tryCatchWrapper",
    template: `  try {
{{tryBody}}
  } catch (error) {
    throw new Error(\`{{functionName}} failed: \${error instanceof Error ? error.message : 'Unknown error'}\`);
  }`,
    variables: [
      { name: "tryBody", type: "expression" },
      { name: "functionName", type: "identifier" },
    ],
    description: "Generate complete try-catch wrapper",
  },
  {
    name: "functionParameter",
    template: "{{paramName}}{{optional}}: {{paramType}}{{defaultValue}}",
    variables: [
      { name: "paramName", type: "identifier" },
      { name: "optional", type: "expression" },
      { name: "paramType", type: "identifier" },
      { name: "defaultValue", type: "expression" },
    ],
    description: "Generate function parameter with optional default value",
  },
  {
    name: "returnStatement",
    template: `    return {
      success: true,
      data,
      status: response.status,
      headers: Object.fromEntries(response.headers.entries())
    };`,
    variables: [],
    description: "Generate standard API response return statement",
  },
];

/**
 * Register all function templates
 */
export function registerFunctionTemplates(): void {
  for (const template of functionTemplates) {
    templateEngine.registerTemplate(template);
  }
}

/**
 * Helper functions for function code generation
 */

/**
 * Generate JSDoc comment for a function
 */
export function generateJSDocComment(
  description: string,
  additionalLines: string[] = []
): string {
  const formattedLines = additionalLines.map((line) => ` * ${line}`).join("\n");
  return templateEngine.render("jsdocComment", {
    description,
    additionalLines: formattedLines,
  });
}

/**
 * Generate async function declaration
 */
export function generateAsyncFunction(
  functionName: string,
  parameters: string,
  returnType: string,
  body: string
): string {
  return templateEngine.render("asyncFunction", {
    functionName,
    parameters,
    returnType,
    body,
  });
}

/**
 * Generate async function with documentation
 */
export function generateDocumentedAsyncFunction(
  documentation: string,
  functionName: string,
  parameters: string,
  returnType: string,
  body: string
): string {
  return templateEngine.render("functionWithDocumentation", {
    documentation,
    functionName,
    parameters,
    returnType,
    body,
  });
}

/**
 * Generate try-catch wrapper
 */
export function generateTryCatchWrapper(
  functionName: string,
  tryBody: string
): string {
  return templateEngine.render("tryCatchWrapper", {
    functionName,
    tryBody,
  });
}

/**
 * Generate function parameter
 */
export function generateFunctionParameter(
  paramName: string,
  paramType: string,
  optional = false,
  defaultValue?: string
): string {
  return templateEngine.render("functionParameter", {
    paramName,
    optional: optional ? "?" : "",
    paramType,
    defaultValue: defaultValue ? ` = ${defaultValue}` : "",
  });
}

/**
 * Generate standard API response return statement
 */
export function generateReturnStatement(): string {
  return templateEngine.render("returnStatement", {});
}

/**
 * Generate function parameters list from parameter objects
 */
export function generateParametersList(
  parameters: Array<{
    name: string;
    type: string;
    optional?: boolean;
    defaultValue?: string;
  }>
): string {
  return parameters
    .map((param) =>
      generateFunctionParameter(
        param.name,
        param.type,
        param.optional,
        param.defaultValue
      )
    )
    .join(", ");
}

/**
 * Generate catch block for error handling
 */
export function generateCatchBlock(functionName: string): string {
  return templateEngine.render("catchBlock", {
    functionName,
  });
}

/**
 * Generate complete function with documentation
 */
export function generateFunctionWithDocumentation(
  documentation: string,
  functionName: string,
  parameters: string,
  returnType: string,
  body: string
): string {
  return templateEngine.render("functionWithDocumentation", {
    documentation,
    functionName,
    parameters,
    returnType,
    body,
  });
}

// Auto-register templates when module is imported
registerFunctionTemplates();
