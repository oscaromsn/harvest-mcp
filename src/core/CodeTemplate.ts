/**
 * Template-based code generation system
 *
 * This system replaces string concatenation with a proper template engine
 * that safely handles JavaScript template literals and other dynamic code generation.
 */

export interface TemplateVariable {
  name: string;
  value?: string;
  type?: "string" | "number" | "boolean" | "identifier" | "expression";
}

export interface CodeTemplate {
  name: string;
  template: string;
  variables: TemplateVariable[];
  description?: string;
}

/**
 * Template engine for safe code generation
 */
export class CodeTemplateEngine {
  private templates = new Map<string, CodeTemplate>();

  /**
   * Register a code template
   */
  registerTemplate(template: CodeTemplate): void {
    this.templates.set(template.name, template);
  }

  /**
   * Render a template with variables
   */
  render(templateName: string, variables: Record<string, unknown>): string {
    const template = this.templates.get(templateName);
    if (!template) {
      throw new Error(`Template not found: ${templateName}`);
    }

    let result = template.template;

    // Replace template variables with safe escaping
    for (const variable of template.variables) {
      const value = variables[variable.name];
      if (value === undefined) {
        throw new Error(
          `Variable '${variable.name}' is required for template '${templateName}'`
        );
      }

      const placeholder = `{{${variable.name}}}`;
      const safeValue = this.escapeValue(value, variable.type || "string");
      result = result.replaceAll(placeholder, safeValue);
    }

    return result;
  }

  /**
   * Safely escape values based on their type
   */
  private escapeValue(value: unknown, type: TemplateVariable["type"]): string {
    switch (type) {
      case "string":
        return JSON.stringify(String(value));
      case "number":
        return String(Number(value));
      case "boolean":
        return String(Boolean(value));
      case "identifier": {
        // For JavaScript identifiers, ensure they're valid
        const identifier = String(value);
        if (!/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(identifier)) {
          throw new Error(`Invalid identifier: ${identifier}`);
        }
        return identifier;
      }
      case "expression":
        // For JavaScript expressions, return as-is (caller is responsible for safety)
        return String(value);
      default:
        return JSON.stringify(String(value));
    }
  }

  /**
   * Get all registered templates
   */
  getTemplates(): CodeTemplate[] {
    return Array.from(this.templates.values());
  }

  /**
   * Check if a template exists
   */
  hasTemplate(name: string): boolean {
    return this.templates.has(name);
  }
}

/**
 * Global template engine instance
 */
export const templateEngine = new CodeTemplateEngine();

// ========== Pre-defined Templates ==========

/**
 * Template for error handling with template literals
 */
templateEngine.registerTemplate({
  name: "errorWithTemplateString",
  template: "throw new Error(`{{message}}`);",
  variables: [{ name: "message", type: "expression" }],
  description:
    "Generate error throwing code with template string interpolation",
});

/**
 * Template for fetch calls with URL template strings
 */
templateEngine.registerTemplate({
  name: "fetchWithTemplateUrl",
  template:
    "const {{variableName}} = await fetch(`{{baseUrl}}?{{queryParams}}`, {",
  variables: [
    { name: "variableName", type: "identifier" },
    { name: "baseUrl", type: "expression" },
    { name: "queryParams", type: "expression" },
  ],
  description: "Generate fetch call with template string URL",
});

/**
 * Template for workflow error handling
 */
templateEngine.registerTemplate({
  name: "workflowNotFoundError",
  template:
    "throw new Error(`Workflow implementation not found: {{workflowId}}`);",
  variables: [{ name: "workflowId", type: "expression" }],
  description: "Generate workflow not found error with template string",
});

/**
 * Template for API request error handling
 */
templateEngine.registerTemplate({
  name: "apiRequestError",
  template:
    "throw new Error(`{{prefix}} failed: {{statusCode}} {{statusText}}`);",
  variables: [
    { name: "prefix", type: "expression" },
    { name: "statusCode", type: "expression" },
    { name: "statusText", type: "expression" },
  ],
  description: "Generate API request error with template string",
});

/**
 * Template for function declarations
 */
templateEngine.registerTemplate({
  name: "functionDeclaration",
  template: `{{asyncKeyword}}function {{functionName}}({{parameters}}) {
{{body}}
}`,
  variables: [
    { name: "asyncKeyword", type: "identifier" },
    { name: "functionName", type: "identifier" },
    { name: "parameters", type: "expression" },
    { name: "body", type: "expression" },
  ],
  description: "Generate function declaration",
});

/**
 * Template for try-catch blocks
 */
templateEngine.registerTemplate({
  name: "tryCatchBlock",
  template: `try {
{{tryBody}}
} catch ({{errorVariable}}) {
{{catchBody}}
}`,
  variables: [
    { name: "tryBody", type: "expression" },
    { name: "errorVariable", type: "identifier" },
    { name: "catchBody", type: "expression" },
  ],
  description: "Generate try-catch block",
});
