import {
  type AuthenticationType,
  type ClassifiedParameter,
  type DAGNode,
  HarvestError,
  type HarvestSession,
  type ParameterDiagnostic,
  type ParameterErrorContext,
  type RequestModel,
  type TokenInfo,
} from "../types/index.js";

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

    // Generate detailed parameter diagnostics
    const diagnostics: ParameterDiagnostic[] = [];
    const enhancedUnresolvedNodes = [];

    for (const node of unresolvedNodes) {
      const nodeParameters: ClassifiedParameter[] = []; // Parameters for this node

      for (const param of node.unresolvedParts) {
        // For now, provide basic diagnostic without full classification data
        // This will be enhanced when ParameterClassificationAgent is integrated
        const diagnostic: ParameterDiagnostic = {
          parameter: param,
          classification: "dynamic", // Default until classification system is integrated
          issue: `Parameter "${param}" cannot be resolved from previous API responses`,
          possibleSources: [
            "Previous API response data",
            "User input parameters",
            "Session initialization data",
            "Authentication flow",
            "Cookie data",
          ],
          recommendedAction: `Verify if "${param}" should be classified as sessionConstant or userInput`,
          debugCommand: `debug_get_node_details --session=${session.id} --node=${node.nodeId}`,
        };

        diagnostics.push(diagnostic);
        nodeParameters.push({
          name: param,
          value: param,
          classification: "dynamic",
          confidence: 0.8,
          source: "heuristic",
          metadata: {
            occurrenceCount: 1,
            totalRequests: 1,
            consistencyScore: 1.0,
            parameterPattern: `^${param}$`,
            domainContext: "unresolved",
          },
        });
      }

      enhancedUnresolvedNodes.push({
        nodeId: node.nodeId,
        parameters: nodeParameters,
      });
    }

    // Create detailed error message with actionable information
    const errorDetails = unresolvedNodes
      .map(
        (n) => `  - Node ${n.nodeId}: Missing [${n.unresolvedParts.join(", ")}]`
      )
      .join("\n");

    const actionableMessage =
      unresolvedNodes.length === 0
        ? "Analysis appears complete but DAG validation failed. This may indicate an internal issue with dependency resolution."
        : `The following ${unresolvedNodes.length} nodes still have unresolved dependencies:\n${errorDetails}\n\nTo resolve this:\n  1. Continue processing with 'analysis_process_next_node'\n  2. Check for manual intervention needs with 'debug_get_unresolved_nodes'\n  3. Use 'debug_get_completion_blockers' for detailed analysis\n  4. Verify all required input variables are provided`;

    // Create enhanced error context
    const errorContext: ParameterErrorContext = {
      sessionId: session.id,
      unresolvedNodes: enhancedUnresolvedNodes,
      recommendations: [
        "Use debug_get_completion_blockers for comprehensive analysis",
        "Check if unresolved parameters are session constants",
        "Verify input variables are correctly provided",
        "Consider manual parameter classification if needed",
      ],
      debugCommands: [
        `debug_get_completion_blockers --session=${session.id}`,
        `debug_get_unresolved_nodes --session=${session.id}`,
        `session_status --session=${session.id}`,
      ],
      parameterAnalysis: diagnostics,
    };

    throw new HarvestError(
      `Code generation failed: Analysis not complete.\n\n${actionableMessage}`,
      "ANALYSIS_INCOMPLETE",
      errorContext
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
  parts.push(generateImports(session));
  parts.push("");

  // 3. Generate functions for each node in dependency order
  const sortedNodeIds = session.dagManager.topologicalSort();
  const sortedNodeCount = sortedNodeIds.length;

  // Create function name mapping for deduplication
  const nodeFunctionNameMap = new Map<string, string>();

  if (sortedNodeCount === 0) {
    parts.push("// No requests found in the analysis");
    parts.push("");
  } else {
    // Track generated function names to avoid duplicates
    const generatedFunctionNames = new Set<string>();

    for (const nodeId of sortedNodeIds) {
      const node = session.dagManager.getNode(nodeId);
      if (node) {
        // Generate base function name
        const functionName = generateNodeFunctionName(node, session);

        // Ensure function name is unique by adding numeric suffix if needed
        let counter = 1;
        let uniqueFunctionName = functionName;
        while (generatedFunctionNames.has(uniqueFunctionName)) {
          uniqueFunctionName = `${functionName}${counter}`;
          counter++;
        }

        // Add the unique function name to our tracking set and mapping
        generatedFunctionNames.add(uniqueFunctionName);
        nodeFunctionNameMap.set(nodeId, uniqueFunctionName);

        const nodeCode = generateNodeCode(node, uniqueFunctionName, session);
        if (nodeCode.trim()) {
          parts.push(nodeCode);
          parts.push("");
        }
      }
    }
  }

  // 4. Main orchestration function and exports
  parts.push(generateFooter(session, nodeFunctionNameMap));

  return parts.join("\n");
}

/**
 * Get the appropriate response type for a node based on its URL
 */
function getResponseTypeForNode(
  node: DAGNode,
  inferredTypes: InferredResponseType[]
): string {
  if (!node.content.key || inferredTypes.length === 0) {
    return "any";
  }

  const request = node.content.key as RequestModel;
  const interfaceName = generateResponseInterfaceName(request.url);

  const matchingType = inferredTypes.find(
    (type) => type.interfaceName === interfaceName
  );
  return matchingType ? matchingType.interfaceName : "any";
}

/**
 * Generate code for a specific DAG node
 */
export function generateNodeCode(
  node: DAGNode,
  functionName: string,
  session?: HarvestSession
): string {
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
        return generateRequestNodeCode(node, functionName, session);
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
function generateRequestNodeCode(
  node: DAGNode,
  functionName: string,
  session?: HarvestSession
): string {
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

  // Determine response type
  const inferredTypes = session ? inferResponseTypes(session) : [];
  const responseType = getResponseTypeForNode(node, inferredTypes);

  // Generate function documentation and signature
  lines.push(...generateFunctionDocumentation(node, request));
  lines.push(
    `async function ${functionName}(${generateFunctionParameters(node)}): Promise<ApiResponse<${responseType}>> {`
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
 * Generate function parameters based on node requirements and classified parameters
 */
function generateFunctionParameters(node: DAGNode): string {
  const params: string[] = [];

  // Check if authentication is needed based on classified parameters or request analysis
  const needsAuth = checkIfAuthenticationRequired(node);

  if (needsAuth) {
    params.push("authConfig?: AuthConfig");
  }

  // Add parameters based on classification
  if (node.classifiedParameters) {
    const userInputParams = node.classifiedParameters.filter(
      (p) => p.classification === "userInput"
    );

    for (const param of userInputParams) {
      const paramType = inferParameterType(param.name, param.value);
      const defaultValue = formatDefaultValue(param.value, paramType);

      // Create clean parameter name
      const cleanParamName = toCamelCase(param.name);
      params.push(
        `${cleanParamName}${paramType === "number" || paramType === "boolean" ? "" : "?"}: ${paramType}${defaultValue ? ` = ${defaultValue}` : ""}`
      );
    }
  } else if (
    node.inputVariables &&
    Object.keys(node.inputVariables).length > 0
  ) {
    // Fallback: use input variables if no classification available
    for (const [key, defaultValue] of Object.entries(node.inputVariables)) {
      const cleanKey = toCamelCase(key);
      params.push(`${cleanKey}?: string = '${defaultValue}'`);
    }
  }

  return params.join(", ");
}

/**
 * Check if the node requires authentication
 */
function checkIfAuthenticationRequired(node: DAGNode): boolean {
  // Check if any session constants or auth headers are present
  if (node.classifiedParameters) {
    return node.classifiedParameters.some(
      (p) =>
        p.classification === "sessionConstant" &&
        (p.name.toLowerCase().includes("auth") ||
          p.name.toLowerCase().includes("token") ||
          p.name.toLowerCase().includes("key"))
    );
  }

  // Check if the request has authentication headers
  if (node.nodeType === "curl" || node.nodeType === "master_curl") {
    const request = node.content.key as RequestModel;
    const authHeaders = ["authorization", "cookie", "x-api-key", "auth-token"];

    return Object.keys(request.headers).some((header) =>
      authHeaders.some((authHeader) =>
        header.toLowerCase().includes(authHeader)
      )
    );
  }

  return false;
}

/**
 * Infer TypeScript type from parameter name and value
 */
function inferParameterType(name: string, value: string): string {
  const nameLower = name.toLowerCase();

  // Numeric parameters
  if (
    ["page", "size", "limit", "offset", "count", "number"].some((term) =>
      nameLower.includes(term)
    )
  ) {
    return "number";
  }

  // Boolean parameters
  if (
    ["true", "false"].includes(value.toLowerCase()) ||
    ["enable", "disable", "show", "hide", "include", "exclude"].some((term) =>
      nameLower.includes(term)
    )
  ) {
    return "boolean";
  }

  // Date parameters
  if (
    ["date", "time", "inicio", "fim", "start", "end"].some((term) =>
      nameLower.includes(term)
    )
  ) {
    return "string | Date";
  }

  // Array parameters (like tribunal filters)
  if (
    ["tribunais", "filters", "categories", "tags"].some((term) =>
      nameLower.includes(term)
    )
  ) {
    return "string[]";
  }

  return "string";
}

/**
 * Format default value based on type
 */
function formatDefaultValue(value: string, type: string): string | null {
  switch (type) {
    case "number": {
      const numValue = Number.parseInt(value, 10);
      return Number.isNaN(numValue) ? "0" : numValue.toString();
    }

    case "boolean":
      return value.toLowerCase() === "true" ? "true" : "false";

    case "string[]":
      if (value) {
        return `["${value}"]`;
      }
      return "[]";

    case "string":
    case "string | Date":
      return value ? `"${value}"` : '""';

    default:
      return value ? `"${value}"` : null;
  }
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
 * Generate master function name from prompt using AI-powered naming
 */
export function generateMasterFunctionName(prompt: string): string {
  // Try to extract a meaningful action from the prompt
  const actionKeywords = extractActionKeywords(prompt);

  if (actionKeywords.length > 0) {
    // Create concise function name from action keywords
    const functionName = actionKeywords
      .slice(0, 3) // Limit to 3 keywords max
      .map((word, index) =>
        index === 0 ? word.toLowerCase() : capitalize(word)
      )
      .join("");

    // Ensure reasonable length (max 50 characters as per bug report)
    if (functionName.length <= 50) {
      return functionName;
    }
  }

  // Fallback: Use domain-specific patterns
  const domainName = detectDomainFromPrompt(prompt);
  return domainName || "performAction";
}

/**
 * Extract meaningful action keywords from a prompt
 */
function extractActionKeywords(prompt: string): string[] {
  const keywords: string[] = [];
  const promptLower = prompt.toLowerCase();

  // Common action patterns
  const actionPatterns = [
    // Search/Query actions
    {
      pattern: /\b(search|pesquisa|query|find|buscar|consulta)\b/i,
      keyword: "search",
    },
    { pattern: /\bjurisprudencia\b/i, keyword: "jurisprudence" },
    { pattern: /\btribunal\b/i, keyword: "court" },

    // CRUD actions
    { pattern: /\b(create|add|new|criar|novo)\b/i, keyword: "create" },
    { pattern: /\b(update|edit|modify|atualizar)\b/i, keyword: "update" },
    { pattern: /\b(delete|remove|deletar|remover)\b/i, keyword: "delete" },
    { pattern: /\b(get|fetch|retrieve|obter)\b/i, keyword: "get" },

    // Domain-specific terms
    { pattern: /\b(login|signin|auth)\b/i, keyword: "authenticate" },
    { pattern: /\b(checkout|purchase|buy)\b/i, keyword: "checkout" },
    { pattern: /\b(upload|download)\b/i, keyword: "transfer" },
    { pattern: /\b(analyze|process|parse)\b/i, keyword: "analyze" },

    // Data operations
    { pattern: /\b(list|browse|explore)\b/i, keyword: "list" },
    { pattern: /\b(filter|sort|organize)\b/i, keyword: "filter" },
    { pattern: /\b(export|import|save)\b/i, keyword: "export" },
  ];

  // Extract matched keywords
  for (const { pattern, keyword } of actionPatterns) {
    if (pattern.test(promptLower)) {
      keywords.push(keyword);
    }
  }

  // If no specific patterns, try to extract meaningful nouns/verbs
  if (keywords.length === 0) {
    const words = promptLower
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((word) => word.length > 3 && word.length < 15); // Reasonable word length

    // Take first few meaningful words
    keywords.push(...words.slice(0, 2));
  }

  return keywords;
}

/**
 * Detect domain context from prompt for better naming
 */
function detectDomainFromPrompt(prompt: string): string | null {
  const promptLower = prompt.toLowerCase();

  if (
    promptLower.includes("jurisprudencia") ||
    promptLower.includes("legal") ||
    promptLower.includes("tribunal")
  ) {
    return "searchLegalCases";
  }
  if (
    promptLower.includes("ecommerce") ||
    promptLower.includes("shop") ||
    promptLower.includes("cart")
  ) {
    return "performCheckout";
  }
  if (
    promptLower.includes("user") ||
    promptLower.includes("account") ||
    promptLower.includes("profile")
  ) {
    return "manageUser";
  }
  if (promptLower.includes("api") || promptLower.includes("service")) {
    return "callService";
  }

  return null;
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
 * Interface for inferred response types
 */
interface InferredResponseType {
  interfaceName: string;
  fields: Array<{
    name: string;
    type: string;
    optional: boolean;
  }>;
  sourceUrl: string;
}

/**
 * Infer TypeScript types from response data in the session
 */
function inferResponseTypes(session: HarvestSession): InferredResponseType[] {
  const responseTypes: InferredResponseType[] = [];
  const seen = new Set<string>();

  try {
    // Get all nodes from the DAG to analyze their response data
    const allNodes = session.dagManager.getAllNodes();

    for (const [, node] of allNodes) {
      if (!node || !node.content.key) {
        continue;
      }

      const request = node.content.key as RequestModel;

      // Check if we have response data for this request
      const responseData = extractResponseData(request);
      if (!responseData) {
        continue;
      }

      // Generate a unique interface name based on the endpoint
      const interfaceName = generateResponseInterfaceName(request.url);

      // Avoid duplicates
      if (seen.has(interfaceName)) {
        continue;
      }
      seen.add(interfaceName);

      // Infer fields from response data
      const fields = inferFieldsFromData(responseData);

      if (fields.length > 0) {
        responseTypes.push({
          interfaceName,
          fields,
          sourceUrl: request.url,
        });
      }
    }
  } catch (error) {
    // If inference fails, return empty array - the code will still work with generic types
    console.warn("Response type inference failed:", error);
  }

  return responseTypes;
}

/**
 * Extract response data from a request model
 */
function extractResponseData(request: RequestModel): unknown {
  // Try to extract response data from various possible sources
  if (request.response?.json) {
    return request.response.json;
  }

  if (request.response?.text) {
    try {
      return JSON.parse(request.response.text);
    } catch {
      // Not JSON, return null
      return null;
    }
  }

  // Could also check other properties where response data might be stored
  return null;
}

/**
 * Generate a TypeScript interface name from a URL
 */
function generateResponseInterfaceName(url: string): string {
  try {
    const urlObj = new URL(url);
    const pathParts = urlObj.pathname
      .split("/")
      .filter((part) => part && part !== "api" && !part.startsWith("v"))
      .map((part) => {
        // Convert kebab-case and snake_case to PascalCase
        return part
          .split(/[-_]/)
          .map(
            (word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()
          )
          .join("");
      });

    let baseName = pathParts.length > 0 ? pathParts.join("") : "Api";

    // Ensure it starts with uppercase and ends with Response
    baseName = baseName.charAt(0).toUpperCase() + baseName.slice(1);
    if (!baseName.endsWith("Response")) {
      baseName += "Response";
    }

    return baseName;
  } catch {
    return "ApiResponse";
  }
}

/**
 * Infer TypeScript field types from response data
 */
function inferFieldsFromData(
  data: unknown
): Array<{ name: string; type: string; optional: boolean }> {
  const fields: Array<{ name: string; type: string; optional: boolean }> = [];

  if (!data || typeof data !== "object") {
    return fields;
  }

  for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
    if (key.startsWith("_") || key.length > 50) {
      // Skip internal fields and overly long keys
      continue;
    }

    const fieldType = inferTypeScriptType(value);
    const isOptional = value === null || value === undefined;

    fields.push({
      name: key,
      type: fieldType,
      optional: isOptional,
    });

    // Limit to avoid overly complex interfaces
    if (fields.length >= 20) {
      break;
    }
  }

  return fields;
}

/**
 * Infer TypeScript type from a JavaScript value
 */
function inferTypeScriptType(value: unknown): string {
  if (value === null || value === undefined) {
    return "any";
  }

  if (typeof value === "string") {
    // Check for common patterns
    if (value.match(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)) {
      return "string"; // ISO date string
    }
    if (
      value.match(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
      )
    ) {
      return "string"; // UUID
    }
    return "string";
  }

  if (typeof value === "number") {
    return Number.isInteger(value) ? "number" : "number";
  }

  if (typeof value === "boolean") {
    return "boolean";
  }

  if (Array.isArray(value)) {
    if (value.length === 0) {
      return "any[]";
    }

    // Infer array element type from first few elements
    const elementTypes = new Set<string>();
    for (let i = 0; i < Math.min(value.length, 3); i++) {
      elementTypes.add(inferTypeScriptType(value[i]));
    }

    if (elementTypes.size === 1) {
      return `${Array.from(elementTypes)[0]}[]`;
    }
    return "any[]";
  }

  if (typeof value === "object") {
    return "object";
  }

  return "any";
}

/**
 * Generate TypeScript imports and type definitions with authentication support
 */
export function generateImports(session?: HarvestSession): string {
  const lines: string[] = [];

  // Type definitions with inferred response types
  lines.push("// Type definitions");

  if (session) {
    const responseTypes = inferResponseTypes(session);

    if (responseTypes.length > 0) {
      lines.push("// Inferred response data types");
      for (const responseType of responseTypes) {
        lines.push(`interface ${responseType.interfaceName} {`);
        for (const field of responseType.fields) {
          lines.push(
            `  ${field.name}${field.optional ? "?" : ""}: ${field.type};`
          );
        }
        lines.push("}");
        lines.push("");
      }
    }
  }

  lines.push("interface ApiResponse<T = any> {");
  lines.push("  success: boolean;");
  lines.push("  data: T;");
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
  lines.push("// Authentication configuration interface");
  lines.push("interface AuthConfig {");
  lines.push("  type: 'bearer' | 'api_key' | 'basic' | 'session' | 'custom';");
  lines.push("  token?: string;");
  lines.push("  apiKey?: string;");
  lines.push("  username?: string;");
  lines.push("  password?: string;");
  lines.push("  sessionCookies?: Record<string, string>;");
  lines.push("  customHeaders?: Record<string, string>;");
  lines.push("  tokenRefreshUrl?: string;");
  lines.push("  onTokenExpired?: () => Promise<string>;");
  lines.push("}");
  lines.push("");
  lines.push("// Authentication error for retry logic");
  lines.push("class AuthenticationError extends Error {");
  lines.push(
    "  constructor(message: string, public status: number, public response?: any) {"
  );
  lines.push("    super(message);");
  lines.push("    this.name = 'AuthenticationError';");
  lines.push("  }");
  lines.push("}");
  lines.push("");
  lines.push("export type { ApiResponse, RequestOptions, AuthConfig };");
  lines.push("export { AuthenticationError };");

  return lines.join("\n");
}

/**
 * Generate main function and exports
 */
export function generateFooter(
  session: HarvestSession,
  nodeFunctionNameMap?: Map<string, string>
): string {
  const lines: string[] = [];

  // Get all function names, using provided mapping if available
  const sortedNodeIds = session.dagManager.topologicalSort();
  const functionNames: string[] = [];

  for (const nodeId of sortedNodeIds) {
    const node = session.dagManager.getNode(nodeId);
    if (node && (node.nodeType === "master_curl" || node.nodeType === "curl")) {
      if (nodeFunctionNameMap?.has(nodeId)) {
        // Use the deduplicated function name from the mapping
        const mappedName = nodeFunctionNameMap.get(nodeId);
        if (mappedName) {
          functionNames.push(mappedName);
        }
      } else {
        // Fallback to original generation method
        functionNames.push(generateNodeFunctionName(node, session));
      }
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
          if (node?.nodeType === "master_curl") {
            if (nodeFunctionNameMap?.has(nodeId)) {
              return nodeFunctionNameMap.get(nodeId) === name;
            }
            return generateNodeFunctionName(node, session) === name;
          }
          return false;
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
 * Generate URL construction code with proper parameterization
 */
function generateUrlConstruction(
  request: RequestModel,
  node: DAGNode,
  lines: string[]
): string {
  const baseUrl = request.url.split("?")[0];

  if (!request.queryParams || Object.keys(request.queryParams).length === 0) {
    return `'${request.url}'`;
  }

  // Analyze parameters to determine which should be configurable
  const configurableParams: string[] = [];
  const staticParams: string[] = [];
  const dynamicParams: string[] = [];

  for (const [key, value] of Object.entries(request.queryParams)) {
    // Use parameter classification if available
    if (node.classifiedParameters) {
      const classified = node.classifiedParameters.find((p) => p.name === key);
      if (classified) {
        switch (classified.classification) {
          case "userInput":
            configurableParams.push(key);
            break;
          case "staticConstant":
            staticParams.push(key);
            break;
          case "dynamic":
            dynamicParams.push(key);
            break;
          case "sessionConstant":
            // Session constants are handled separately
            staticParams.push(key);
            break;
        }
        continue;
      }
    }

    // Fallback classification based on input variables and heuristics
    if (node.inputVariables && Object.hasOwn(node.inputVariables, value)) {
      configurableParams.push(key);
    } else if (isLikelyUserInput(key, value)) {
      configurableParams.push(key);
    } else if (isLikelyStatic(key, value)) {
      staticParams.push(key);
    } else {
      dynamicParams.push(key);
    }
  }

  // Generate URL construction based on parameter types
  lines.push(`    const url = new URL('${baseUrl}');`);
  lines.push("");

  // Add static parameters first
  if (staticParams.length > 0) {
    lines.push("    // Static parameters");
    for (const key of staticParams) {
      const value = request.queryParams[key];
      lines.push(`    url.searchParams.set('${key}', '${value}');`);
    }
    lines.push("");
  }

  // Add configurable parameters
  if (configurableParams.length > 0) {
    lines.push("    // Configurable parameters");
    for (const key of configurableParams) {
      const defaultValue = request.queryParams[key];
      // Check if this parameter should come from function arguments
      const paramName =
        node.inputVariables &&
        defaultValue &&
        Object.values(node.inputVariables).includes(defaultValue)
          ? Object.keys(node.inputVariables).find(
              (k) => node.inputVariables?.[k] === defaultValue
            ) || key
          : key;

      lines.push(
        `    if (${paramName} !== undefined && ${paramName} !== null) {`
      );
      lines.push(`      url.searchParams.set('${key}', String(${paramName}));`);
      lines.push("    }");
    }
    lines.push("");
  }

  // Add dynamic parameters (these need to be resolved from previous responses)
  if (dynamicParams.length > 0) {
    lines.push("    // Dynamic parameters (resolved from previous requests)");
    for (const key of dynamicParams) {
      const value = request.queryParams[key];
      lines.push(`    // TODO: Resolve '${key}' from previous API response`);
      lines.push(
        `    url.searchParams.set('${key}', '${value}'); // Placeholder value`
      );
    }
    lines.push("");
  }

  return "url.toString()";
}

/**
 * Check if a parameter is likely user input
 */
function isLikelyUserInput(key: string, value: string): boolean {
  const keyLower = key.toLowerCase();

  // Search and query parameters
  if (
    ["search", "query", "q", "text", "texto", "term", "keyword"].some((term) =>
      keyLower.includes(term)
    )
  ) {
    return true;
  }

  // Pagination parameters
  if (["page", "size", "limit", "offset", "per_page"].includes(keyLower)) {
    return true;
  }

  // Date parameters with actual dates
  if (
    ["date", "inicio", "fim", "start", "end", "from", "to"].some((term) =>
      keyLower.includes(term)
    )
  ) {
    return /^\d{4}-\d{2}-\d{2}/.test(value) || /^\d{10,13}$/.test(value);
  }

  // Filter parameters
  if (
    ["filter", "filtro", "category", "type", "tribunal"].some((term) =>
      keyLower.includes(term)
    )
  ) {
    return true;
  }

  return false;
}

/**
 * Check if a parameter is likely static
 */
function isLikelyStatic(key: string, value: string): boolean {
  const keyLower = key.toLowerCase();

  // Coordinates that are zero
  if ((keyLower === "latitude" || keyLower === "longitude") && value === "0") {
    return true;
  }

  // Boolean flags
  if (["true", "false"].includes(value.toLowerCase())) {
    return true;
  }

  // API versions or configuration
  if (
    ["version", "api_version", "format", "output"].some((term) =>
      keyLower.includes(term)
    )
  ) {
    return true;
  }

  return false;
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
    const lowerKey = key.toLowerCase();
    // Skip authentication headers - these will be handled dynamically
    if (
      lowerKey === "authorization" ||
      lowerKey === "cookie" ||
      lowerKey.includes("api-key") ||
      lowerKey.includes("auth-token") ||
      lowerKey.includes("x-api-key")
    ) {
      lines.push(
        `      // '${key}': SKIPPED - Will be set dynamically based on authConfig`
      );
      continue;
    }

    lines.push(`      '${key}': '${escapedValue}',`);
  }
  lines.push("    };");
  lines.push("");

  // Generate authentication setup based on detected type
  const authInfo = detectRequestAuthentication(request);
  if (authInfo.hasAuthentication) {
    generateAuthenticationSetup(authInfo, lines);
  } else {
    lines.push("    // No authentication detected - request may be public");
    lines.push("");
  }

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
  lines.push("    // Handle authentication errors with retry logic");
  lines.push("    if (response.status === 401 || response.status === 403) {");
  lines.push("      const authError = new AuthenticationError(");
  lines.push(
    '        "Authentication failed: " + response.status + " " + response.statusText,'
  );
  lines.push("        response.status,");
  lines.push("        await response.text()");
  lines.push("      );");
  lines.push("      ");
  lines.push(
    "      // If token refresh is available, attempt to refresh and retry"
  );
  lines.push("      if (authConfig?.onTokenExpired) {");
  lines.push("        try {");
  lines.push(
    "          console.log('Attempting token refresh due to auth failure...');"
  );
  lines.push("          const newToken = await authConfig.onTokenExpired();");
  lines.push("          // Update token and retry request");
  lines.push("          if (authConfig.type === 'bearer' && newToken) {");
  lines.push("            authConfig.token = newToken;");
  lines.push(
    '            options.headers["Authorization"] = "Bearer " + newToken;'
  );
  lines.push(
    "            console.log('Token refreshed, retrying request...');"
  );
  lines.push("            // Retry the request once");
  lines.push(
    `            const retryResponse = await fetch(${urlExpression}, options);`
  );
  lines.push("            if (retryResponse.ok) {");
  lines.push("              return await processResponse(retryResponse);");
  lines.push("            }");
  lines.push("          }");
  lines.push("        } catch (refreshError) {");
  lines.push("          console.warn('Token refresh failed:', refreshError);");
  lines.push("        }");
  lines.push("      }");
  lines.push("      ");
  lines.push("      throw authError;");
  lines.push("    }");
  lines.push("");
  lines.push("    if (!response.ok) {");
  lines.push(
    '      throw new Error("Request failed: " + response.status + " " + response.statusText);'
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
    `    throw new Error(\`${functionName} failed: \\\${error instanceof Error ? error.message : 'Unknown error'}\`);`
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

// Authentication helper functions

/**
 * Detect authentication requirements in a request
 */
function detectRequestAuthentication(request: RequestModel): {
  hasAuthentication: boolean;
  authType: AuthenticationType;
  tokens: TokenInfo[];
  authHeaders: string[];
  authCookies: string[];
  warningMessage?: string;
} {
  const tokens: TokenInfo[] = [];
  const authHeaders: string[] = [];
  const authCookies: string[] = [];
  let authType: AuthenticationType = "none";
  let warningMessage: string | undefined;

  // Check headers for authentication
  for (const [headerName, headerValue] of Object.entries(request.headers)) {
    const lowerName = headerName.toLowerCase();

    if (lowerName === "authorization") {
      authHeaders.push(headerName);
      if (headerValue.toLowerCase().startsWith("bearer")) {
        authType = "bearer_token";
        tokens.push({
          type: "bearer",
          location: "header",
          name: headerName,
          value: headerValue.substring(7).trim(),
        });
        warningMessage =
          "Bearer token detected - ensure token is obtained dynamically";
      } else if (headerValue.toLowerCase().startsWith("basic")) {
        authType = "basic_auth";
        warningMessage =
          "Basic auth detected - ensure credentials are obtained securely";
      }
    } else if (lowerName === "cookie") {
      authCookies.push(headerName);
      authType = "session_cookie";
      warningMessage =
        "Session cookies detected - ensure cookies are obtained from login flow";
    } else if (
      lowerName.includes("api-key") ||
      lowerName.includes("x-api-key")
    ) {
      authHeaders.push(headerName);
      authType = "api_key";
      tokens.push({
        type: "api_key",
        location: "header",
        name: headerName,
        value: headerValue,
      });
      warningMessage =
        "API key detected - ensure key is obtained from environment variables";
    } else if (lowerName.includes("auth") || lowerName.includes("token")) {
      authHeaders.push(headerName);
      authType = "custom_header";
      tokens.push({
        type: "custom",
        location: "header",
        name: headerName,
        value: headerValue,
      });
      warningMessage = "Custom authentication header detected";
    }
  }

  // Check URL parameters for authentication
  if (request.queryParams) {
    for (const [paramName, paramValue] of Object.entries(request.queryParams)) {
      const lowerName = paramName.toLowerCase();
      if (
        lowerName.includes("token") ||
        lowerName.includes("api") ||
        lowerName.includes("auth")
      ) {
        tokens.push({
          type: "custom",
          location: "url_param",
          name: paramName,
          value: paramValue,
        });
        if (authType === "none") {
          authType = "url_parameter";
          warningMessage =
            "URL parameter authentication detected - consider moving to headers for security";
        }
      }
    }
  }

  const result = {
    hasAuthentication: authType !== "none",
    authType,
    tokens,
    authHeaders,
    authCookies,
  } as {
    hasAuthentication: boolean;
    authType: AuthenticationType;
    tokens: TokenInfo[];
    authHeaders: string[];
    authCookies: string[];
    warningMessage?: string;
  };

  if (warningMessage) {
    result.warningMessage = warningMessage;
  }

  return result;
}

/**
 * Generate authentication setup code based on detected authentication type
 */
function generateAuthenticationSetup(
  authInfo: ReturnType<typeof detectRequestAuthentication>,
  lines: string[]
): void {
  // Check if this is a public endpoint (addresses the main bug report issue)
  const isPublicEndpoint =
    authInfo.authType === "none" ||
    (authInfo.authHeaders.length === 0 && authInfo.authCookies.length === 0);

  if (isPublicEndpoint) {
    lines.push("    // No authentication required - this is a public endpoint");
    lines.push("");
    return;
  }

  lines.push(
    "    // Authentication setup - IMPORTANT: Configure authConfig before using"
  );
  lines.push("    if (!authConfig) {");
  lines.push(
    "      throw new Error('Authentication required but authConfig not provided. See setup instructions below.');"
  );
  lines.push("    }");
  lines.push("");

  if (authInfo.warningMessage) {
    lines.push(`    // WARNING: ${authInfo.warningMessage}`);
    lines.push("");
  }

  switch (authInfo.authType) {
    case "bearer_token":
      lines.push("    // Bearer token authentication");
      lines.push(
        "    if (authConfig.type !== 'bearer' || !authConfig.token) {"
      );
      lines.push(
        "      throw new Error('Bearer token required in authConfig.token');"
      );
      lines.push("    }");
      lines.push(
        '    headers["Authorization"] = "Bearer " + authConfig.token;'
      );
      break;

    case "api_key":
      lines.push("    // API key authentication");
      lines.push(
        "    if (authConfig.type !== 'api_key' || !authConfig.apiKey) {"
      );
      lines.push(
        "      throw new Error('API key required in authConfig.apiKey');"
      );
      lines.push("    }");
      for (const headerName of authInfo.authHeaders) {
        lines.push(`    headers['${headerName}'] = authConfig.apiKey;`);
      }
      break;

    case "basic_auth":
      lines.push("    // Basic authentication");
      lines.push(
        "    if (authConfig.type !== 'basic' || !authConfig.username || !authConfig.password) {"
      );
      lines.push(
        "      throw new Error('Username and password required in authConfig for basic auth');"
      );
      lines.push("    }");
      lines.push(
        '    const basicAuth = btoa(authConfig.username + ":" + authConfig.password);'
      );
      lines.push('    headers["Authorization"] = "Basic " + basicAuth;');
      break;

    case "session_cookie":
      lines.push("    // Session cookie authentication");
      lines.push(
        "    if (authConfig.type !== 'session' || !authConfig.sessionCookies) {"
      );
      lines.push(
        "      throw new Error('Session cookies required in authConfig.sessionCookies');"
      );
      lines.push("    }");
      lines.push(
        "    const cookiePairs = Object.entries(authConfig.sessionCookies)"
      );
      lines.push('      .map(([name, value]) => name + "=" + value)');
      lines.push("      .join('; ');");
      lines.push("    headers['Cookie'] = cookiePairs;");
      break;

    case "custom_header":
    case "url_parameter":
      lines.push("    // Custom authentication");
      lines.push(
        "    if (authConfig.type !== 'custom' || !authConfig.customHeaders) {"
      );
      lines.push(
        "      throw new Error('Custom authentication headers required in authConfig.customHeaders');"
      );
      lines.push("    }");
      lines.push("    Object.assign(headers, authConfig.customHeaders);");
      break;

    case "none":
      // Already handled above, but include for completeness
      lines.push("    // No authentication required for this endpoint");
      lines.push("");
      return;
  }

  lines.push("");
}
