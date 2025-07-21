/**
 * Specialized templates for error handling code generation
 *
 * This module provides templates specifically for generating JavaScript error handling
 * code that safely uses template literals without triggering linter warnings.
 */

import { type CodeTemplate, templateEngine } from "./CodeTemplate.js";

/**
 * Error handling template configurations
 */
export const errorHandlingTemplates: CodeTemplate[] = [
  {
    name: "workflowImplementationNotFound",
    template:
      "throw new Error(`Workflow implementation not found: $${{{workflowId}}}`);",
    variables: [{ name: "workflowId", type: "identifier" }],
    description: "Error for missing workflow implementation",
  },
  {
    name: "workflowExecutionFailed",
    template:
      "throw new Error(`$${{{workflowName}}} failed: $${{{responseStatus}}} $${{{responseStatusText}}}`);",
    variables: [
      { name: "workflowName", type: "expression" },
      { name: "responseStatus", type: "expression" },
      { name: "responseStatusText", type: "expression" },
    ],
    description: "Error for workflow execution failure",
  },
  {
    name: "apiRequestFailed",
    template:
      "throw new Error(`API request failed: $${{{responseStatus}}} $${{{responseStatusText}}}`);",
    variables: [
      { name: "responseStatus", type: "expression" },
      { name: "responseStatusText", type: "expression" },
    ],
    description: "Error for API request failure",
  },
  {
    name: "genericErrorWithContext",
    template: "throw new Error(`{{errorMessage}}: $${{{contextVariable}}}`);",
    variables: [
      { name: "errorMessage", type: "string" },
      { name: "contextVariable", type: "expression" },
    ],
    description: "Generic error with context variable",
  },
];

/**
 * Register all error handling templates
 */
export function registerErrorHandlingTemplates(): void {
  for (const template of errorHandlingTemplates) {
    templateEngine.registerTemplate(template);
  }
}

/**
 * Helper functions for common error scenarios
 */

/**
 * Generate workflow not found error
 */
export function workflowNotFound(workflowId: string): string {
  return templateEngine.render("workflowImplementationNotFound", {
    workflowId,
  });
}

/**
 * Generate workflow execution failure error
 */
export function workflowFailed(_workflowName: string): string {
  return templateEngine.render("workflowExecutionFailed", {
    workflowName: "workflow.name",
    responseStatus: "response.status",
    responseStatusText: "response.statusText",
  });
}

/**
 * Generate API request failure error
 */
export function apiRequestFailed(): string {
  return templateEngine.render("apiRequestFailed", {
    responseStatus: "response.status",
    responseStatusText: "response.statusText",
  });
}

/**
 * Generate generic error with template literal interpolation
 */
export function genericError(message: string, contextVar: string): string {
  return templateEngine.render("genericErrorWithContext", {
    errorMessage: message,
    contextVariable: contextVar,
  });
}

// Auto-register templates when module is imported
registerErrorHandlingTemplates();
