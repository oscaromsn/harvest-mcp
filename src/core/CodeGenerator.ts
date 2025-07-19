import type { DAGNode, HarvestSession, RequestModel } from "../types/index.js";

/**
 * Generate a complete TypeScript wrapper script from a completed analysis session
 * Converts completed dependency graphs into executable TypeScript code
 *
 * Takes a fully analyzed session with resolved dependencies and generates a complete
 * wrapper script that reproduces the API workflow.
 */
export function generateWrapperScript(session: HarvestSession): string {
  // Comprehensive session validation
  if (!session) {
    throw new Error("Session is null or undefined");
  }

  if (!session.state) {
    throw new Error("Session state is missing");
  }

  if (!session.dagManager) {
    throw new Error("DAG manager is missing from session");
  }

  if (!session.prompt) {
    throw new Error("Session prompt is missing");
  }

  // Validate that analysis is complete (use DAG as primary source of truth)
  if (!session.dagManager.isComplete()) {
    const unresolvedNodes = session.dagManager.getUnresolvedNodes();

    // Create detailed error message with actionable information
    const errorDetails = unresolvedNodes
      .map(
        (n) => `  - Node ${n.nodeId}: Missing [${n.unresolvedParts.join(", ")}]`
      )
      .join("\n");

    const actionableMessage =
      unresolvedNodes.length === 0
        ? "Analysis appears complete but DAG validation failed. This may indicate an internal issue with dependency resolution."
        : `The following ${unresolvedNodes.length} nodes still have unresolved dependencies:\n${errorDetails}\n\nTo resolve this:\n  1. Continue processing with 'analysis_process_next_node'\n  2. Check for manual intervention needs with debug tools\n  3. Verify all required input variables are provided`;

    throw new Error(
      `Code generation failed: Analysis not complete.\n\n${actionableMessage}`
    );
  }

  // Warn if session state is out of sync (should not happen with new synchronization)
  if (!session.state.isComplete) {
    console.warn(
      "Warning: Session state completion flag is out of sync with DAG completion. This should not happen."
    );
  }

  // Note: Empty DAGs are allowed for testing purposes and edge cases

  const parts: string[] = [];

  // 1. File header with metadata
  parts.push(generateHeader(session));
  parts.push("");

  // 2. TypeScript imports and type definitions
  parts.push(generateImports());
  parts.push("");

  // 3. Generate functions for each node in dependency order
  const sortedNodeIds = session.dagManager.topologicalSort();
  const sortedNodeCount = sortedNodeIds.length;

  if (sortedNodeCount === 0) {
    parts.push("// No requests found in the analysis");
    parts.push("");
  } else {
    for (const nodeId of sortedNodeIds) {
      const node = session.dagManager.getNode(nodeId);
      if (node) {
        const functionName = generateNodeFunctionName(node, session);
        const nodeCode = generateNodeCode(node, functionName);
        if (nodeCode.trim()) {
          parts.push(nodeCode);
          parts.push("");
        }
      }
    }
  }

  // 4. Main orchestration function and exports
  parts.push(generateFooter(session));

  return parts.join("\n");
}

/**
 * Generate code for a specific DAG node
 */
export function generateNodeCode(node: DAGNode, functionName: string): string {
  try {
    if (!node) {
      throw new Error("Node is null or undefined");
    }

    if (!functionName || typeof functionName !== "string") {
      throw new Error(`Invalid function name provided: ${functionName}`);
    }

    switch (node.nodeType) {
      case "master_curl":
      case "curl":
        return generateRequestNodeCode(node, functionName);
      case "cookie":
        return generateCookieNodeCode(node, functionName);
      case "not_found":
        return generateNotFoundNodeCode(node, functionName);
      default:
        throw new Error(`Unsupported node type: ${node.nodeType}`);
    }
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    return `// ERROR: Failed to generate code for node ${node?.id || "unknown"}: ${errorMessage}`;
  }
}

/**
 * Generate code for request-based nodes (curl, master_curl)
 */
function generateRequestNodeCode(node: DAGNode, functionName: string): string {
  if (
    node.nodeType !== "curl" &&
    node.nodeType !== "master_curl" &&
    node.nodeType !== "master"
  ) {
    throw new Error(
      `Invalid node type for request code generation: ${node.nodeType}`
    );
  }

  const request = node.content.key;
  if (!request) {
    throw new Error(
      `No request data found for node ${node.id}. Expected Request object in node.content.key`
    );
  }

  if (!request.url || !request.method) {
    throw new Error(
      `Invalid request data for node ${node.id}. Missing url or method`
    );
  }

  const lines: string[] = [];

  // Generate function documentation and signature
  lines.push(...generateFunctionDocumentation(node, request));
  lines.push(
    `async function ${functionName}(${generateFunctionParameters(node)}): Promise<ApiResponse> {`
  );
  lines.push("  try {");

  // Generate URL construction code
  const urlExpression = generateUrlConstruction(request, node, lines);

  // Generate headers and request options
  generateHeadersAndOptions(request, lines);

  // Generate request execution and response handling
  generateRequestExecution(urlExpression, lines);
  generateResponseHandling(lines);

  // Generate variable extraction comments
  generateVariableExtractionComments(node, lines);

  // Generate return statement and error handling
  generateReturnStatement(lines);
  generateErrorHandling(functionName, lines);

  lines.push("}");
  return lines.join("\n");
}

/**
 * Generate code for cookie nodes
 */
function generateCookieNodeCode(node: DAGNode, _functionName: string): string {
  if (node.nodeType !== "cookie") {
    throw new Error(
      `Invalid node type for cookie code generation: ${node.nodeType}`
    );
  }

  const cookieKey = node.content.key;
  const cookieValue = node.content.value;

  const lines: string[] = [];
  lines.push(`// Cookie: ${cookieKey}`);
  lines.push(`// Value: ${cookieValue}`);
  lines.push("// This cookie should be included in requests that need it");

  return lines.join("\n");
}

/**
 * Generate code for not_found nodes
 */
function generateNotFoundNodeCode(node: DAGNode, functionName: string): string {
  if (node.nodeType !== "not_found") {
    throw new Error(
      `Invalid node type for not_found code generation: ${node.nodeType}`
    );
  }

  const missingPart = node.content.key;

  const lines: string[] = [];
  lines.push(`// WARNING: Could not resolve ${missingPart}`);
  lines.push(`function ${functionName}(): never {`);
  lines.push(
    `  throw new Error('Missing dependency: ${missingPart}. This value needs to be provided manually.');`
  );
  lines.push("}");

  return lines.join("\n");
}

/**
 * Generate function parameters based on node requirements
 */
function generateFunctionParameters(node: DAGNode): string {
  const params: string[] = [];

  // Add input variables as parameters
  if (node.inputVariables && Object.keys(node.inputVariables).length > 0) {
    for (const [key, defaultValue] of Object.entries(node.inputVariables)) {
      params.push(`${key}: string = '${defaultValue}'`);
    }
  }

  // Add dependencies as parameters (placeholder for now)
  // In a more sophisticated implementation, we would analyze the dependency graph
  // to determine which variables need to be passed down

  return params.join(", ");
}

/**
 * Generate appropriate function name for a node
 */
function generateNodeFunctionName(
  node: DAGNode,
  session: HarvestSession
): string {
  if (node.nodeType === "master_curl") {
    return generateMasterFunctionName(session.prompt);
  }

  if (node.nodeType === "curl") {
    return generateFunctionName(node.content.key);
  }

  if (node.nodeType === "cookie") {
    return `getCookie${toPascalCase(String(node.content.key))}`;
  }

  if (node.nodeType === "not_found") {
    return `handleMissing${toPascalCase(String(node.content.key))}`;
  }

  return `unknownFunction${node.id.substring(0, 8)}`;
}

/**
 * Generate function name from request URL
 */
export function generateFunctionName(request: RequestModel): string {
  // Extract meaningful parts from URL path
  const url = new URL(request.url);
  const pathParts = url.pathname
    .split("/")
    .filter((part) => part && part !== "api")
    .map((part) => toCamelCase(part));

  if (pathParts.length === 0) {
    // Fallback to method name
    return `${request.method.toLowerCase()}Request`;
  }

  // Join parts and ensure proper camelCase
  const functionName = pathParts
    .map((part, index) => (index === 0 ? part : capitalize(part)))
    .join("");

  return functionName;
}

/**
 * Generate master function name from prompt
 */
export function generateMasterFunctionName(prompt: string): string {
  // Extract action from prompt and convert to camelCase
  const cleanPrompt = prompt
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .trim();

  const words = cleanPrompt.split(/\s+/).filter((word) => word.length > 0);

  if (words.length === 0) {
    return "mainAction";
  }

  // Convert to camelCase
  const functionName = words
    .map((word, index) => (index === 0 ? word : capitalize(word)))
    .join("");

  return functionName;
}

/**
 * Get variables that should be extracted from a node's response
 */
export function getExtractedVariables(node: DAGNode): string[] {
  return node.extractedParts || [];
}

/**
 * Generate file header with metadata
 */
export function generateHeader(session: HarvestSession): string {
  const lines: string[] = [];
  lines.push("// Harvest Generated API Integration Code");
  lines.push("// ==========================================");
  lines.push("//");
  lines.push(`// Original prompt: ${session.prompt}`);
  lines.push(`// Generated: ${new Date().toISOString().split("T")[0]}`);
  lines.push(`// Session ID: ${session.id}`);
  lines.push("//");
  lines.push("// DO NOT EDIT - This file is auto-generated");
  lines.push("// To modify the API integration, re-run the Harvest analysis");

  return lines.join("\n");
}

/**
 * Generate TypeScript imports and type definitions
 */
export function generateImports(): string {
  const lines: string[] = [];

  // Type definitions
  lines.push("// Type definitions");
  lines.push("interface ApiResponse {");
  lines.push("  success: boolean;");
  lines.push("  data: any;");
  lines.push("  status: number;");
  lines.push("  headers: Record<string, string>;");
  lines.push("}");
  lines.push("");
  lines.push("interface RequestOptions {");
  lines.push("  method: string;");
  lines.push("  headers: Record<string, string>;");
  lines.push("  body?: string;");
  lines.push("}");
  lines.push("");
  lines.push("export type { ApiResponse, RequestOptions };");

  return lines.join("\n");
}

/**
 * Generate main function and exports
 */
export function generateFooter(session: HarvestSession): string {
  const lines: string[] = [];

  // Get all function names
  const sortedNodeIds = session.dagManager.topologicalSort();
  const functionNames: string[] = [];

  for (const nodeId of sortedNodeIds) {
    const node = session.dagManager.getNode(nodeId);
    if (node && (node.nodeType === "master_curl" || node.nodeType === "curl")) {
      functionNames.push(generateNodeFunctionName(node, session));
    }
  }

  // Main orchestration function
  lines.push("/**");
  lines.push(" * Main function that executes the complete API workflow");
  lines.push(" */");
  lines.push("async function main(): Promise<ApiResponse> {");

  if (functionNames.length === 0) {
    lines.push('  throw new Error("No API functions found to execute");');
  } else {
    lines.push("  // Execute requests in dependency order");

    // Find the master function (main action)
    const masterFunctionName =
      functionNames.find((name) =>
        sortedNodeIds.some((nodeId) => {
          const node = session.dagManager.getNode(nodeId);
          return (
            node?.nodeType === "master_curl" &&
            generateNodeFunctionName(node, session) === name
          );
        })
      ) || functionNames[functionNames.length - 1];

    lines.push(`  const result = await ${masterFunctionName}();`);
    lines.push("  return result;");
  }

  lines.push("}");
  lines.push("");

  // Exports
  lines.push("// Export all functions for individual use");
  lines.push("export {");
  if (functionNames.length > 0) {
    for (const functionName of functionNames) {
      lines.push(`  ${functionName},`);
    }
  }
  lines.push("  main");
  lines.push("};");
  lines.push("");

  // Usage example
  lines.push("// Usage example:");
  lines.push('// import { main } from "./generated-api-integration.ts";');
  lines.push("// const result = await main();");
  lines.push("// console.log(result.data);");

  return lines.join("\n");
}

/**
 * Generate JSDoc documentation for the function
 */
function generateFunctionDocumentation(
  node: DAGNode,
  request: RequestModel
): string[] {
  const lines: string[] = [];
  lines.push("/**");
  lines.push(
    ` * ${node.nodeType === "master_curl" ? "Main API call" : "Dependency request"}: ${request.method} ${request.url}`
  );
  if (node.extractedParts && node.extractedParts.length > 0) {
    lines.push(` * Extracts: ${node.extractedParts.join(", ")}`);
  }
  if (node.inputVariables && Object.keys(node.inputVariables).length > 0) {
    lines.push(
      ` * Input variables: ${Object.keys(node.inputVariables).join(", ")}`
    );
  }
  lines.push(" */");
  return lines;
}

/**
 * Generate URL construction code with query parameters
 */
function generateUrlConstruction(
  request: RequestModel,
  node: DAGNode,
  lines: string[]
): string {
  let urlExpression = `'${request.url}'`;
  if (request.queryParams && Object.keys(request.queryParams).length > 0) {
    lines.push("    const params = new URLSearchParams({");
    for (const [key, value] of Object.entries(request.queryParams)) {
      // Check if this is a dynamic value that needs substitution
      if (node.inputVariables && Object.hasOwn(node.inputVariables, value)) {
        lines.push(`      '${key}': ${value},`);
      } else {
        lines.push(`      '${key}': '${value}',`);
      }
    }
    lines.push("    });");
    urlExpression = `'${request.url.split("?")[0]}?' + params.toString()`;
  }
  return urlExpression;
}

/**
 * Generate headers and request options code
 */
function generateHeadersAndOptions(
  request: RequestModel,
  lines: string[]
): void {
  // Build headers
  lines.push("    const headers: Record<string, string> = {");
  for (const [key, value] of Object.entries(request.headers)) {
    // Escape quotes in header values
    const escapedValue = value.replace(/'/g, "\\'");
    lines.push(`      '${key}': '${escapedValue}',`);
  }
  lines.push("    };");

  // Build request options
  lines.push("    const options: RequestOptions = {");
  lines.push(`      method: '${request.method}',`);
  lines.push("      headers,");

  // Add body if present
  if (request.body) {
    if (typeof request.body === "object") {
      lines.push(
        `      body: JSON.stringify(${JSON.stringify(request.body, null, 6)}),`
      );
    } else {
      lines.push(`      body: '${String(request.body).replace(/'/g, "\\'")}',`);
    }
  }

  lines.push("    };");
  lines.push("");
}

/**
 * Generate request execution code
 */
function generateRequestExecution(
  urlExpression: string,
  lines: string[]
): void {
  lines.push(`    const response = await fetch(${urlExpression}, options);`);
  lines.push("");
  lines.push("    if (!response.ok) {");
  lines.push(
    "      throw new Error('Request failed: ' + response.status + ' ' + response.statusText);"
  );
  lines.push("    }");
  lines.push("");
}

/**
 * Generate response parsing code
 */
function generateResponseHandling(lines: string[]): void {
  lines.push(
    `    const contentType = response.headers.get('content-type') || '';`
  );
  lines.push("    let data: any;");
  lines.push("    ");
  lines.push(`    if (contentType.includes('application/json')) {`);
  lines.push("      data = await response.json();");
  lines.push("    } else {");
  lines.push("      data = await response.text();");
  lines.push("    }");
  lines.push("");
}

/**
 * Generate variable extraction comments
 */
function generateVariableExtractionComments(
  node: DAGNode,
  lines: string[]
): void {
  if (node.extractedParts && node.extractedParts.length > 0) {
    lines.push("    // Extract variables for dependent requests:");
    for (const part of node.extractedParts) {
      lines.push(`    // ${part} will be available in the response data`);
    }
    lines.push("");
  }
}

/**
 * Generate return statement
 */
function generateReturnStatement(lines: string[]): void {
  lines.push("    return {");
  lines.push("      success: true,");
  lines.push("      data,");
  lines.push("      status: response.status,");
  lines.push("      headers: Object.fromEntries(response.headers.entries())");
  lines.push("    };");
}

/**
 * Generate error handling code
 */
function generateErrorHandling(functionName: string, lines: string[]): void {
  lines.push("  } catch (error) {");
  lines.push(
    `    throw new Error(\`${functionName} failed: \${error instanceof Error ? error.message : 'Unknown error'}\`);`
  );
  lines.push("  }");
}

// Utility functions
function toCamelCase(str: string): string {
  return str
    .replace(/[^a-zA-Z0-9]/g, " ")
    .split(" ")
    .filter((word) => word.length > 0)
    .map((word, index) => (index === 0 ? word.toLowerCase() : capitalize(word)))
    .join("");
}

function toPascalCase(str: string): string {
  return str
    .replace(/[^a-zA-Z0-9]/g, " ")
    .split(" ")
    .filter((word) => word.length > 0)
    .map((word) => capitalize(word))
    .join("");
}

function capitalize(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1).toLowerCase();
}
