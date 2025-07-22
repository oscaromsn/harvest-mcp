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
import { createComponentLogger } from "../utils/logger.js";
import {
  generateAuthErrorHandling,
  generateAuthenticationSetup as generateAuthSetup,
} from "./AuthTemplateEngine.js";
import {
  apiRequestFailed,
  workflowFailed,
  workflowNotFound,
} from "./ErrorHandlingTemplate.js";
import { fetchWithQueryParams } from "./FetchTemplate.js";
import {
  generateAsyncFunction,
  generateCatchBlock,
  generateFunctionWithDocumentation,
  generateJSDocComment,
  generateReturnStatement,
} from "./FunctionTemplateEngine.js";
import {
  generateCookieNodeComment,
  generateFetchCall,
  generateHeadersObject,
  generateNotFoundNodeFunction,
  generateParameterSetup,
  generateRequestOptions,
  generateResponseOkCheck,
  generateResponseProcessing,
  generateUrlWithParams,
} from "./ResponseHandlingTemplateEngine.js";
import {
  generateExportBlock,
  generateFileHeader,
  generateInterface,
  generateMainFunctionEmptyBody,
  generateMainFunctionWithMaster,
  generateTypeDefinitions,
  generateUsageExample,
} from "./TypeDefinitionTemplateEngine.js";

const logger = createComponentLogger("code-generator");

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
    logger.warn(
      "Session state completion flag out of sync with DAG completion",
      {
        sessionComplete: session.state.isComplete,
        dagComplete: session.dagManager.isComplete(),
      }
    );
  }

  // Note: Empty DAGs are allowed for testing purposes and edge cases

  // Check for multi-workflow architecture to determine generation strategy
  const workflowInfo = analyzeWorkflowRequirements(session);

  if (workflowInfo.hasMultipleWorkflows) {
    // Generate structured workflow-based client for complex multi-workflow APIs
    return generateWorkflowBasedClient(session, workflowInfo);
  }

  // Check for session-awareness (bootstrap parameters) to determine generation strategy
  const sessionInfo = analyzeSessionRequirements(session);

  if (sessionInfo.requiresSessionManagement) {
    // Generate stateful class-based client for session-aware APIs
    return generateSessionAwareClient(session, sessionInfo);
  }

  // Continue with traditional stateless function generation
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

  // Determine response type
  const inferredTypes = session ? inferResponseTypes(session) : [];
  const responseType = getResponseTypeForNode(node, inferredTypes);

  // Generate function documentation
  const documentation = generateFunctionDocumentation(node, request).join("\n");

  // Generate function body parts
  const bodyParts: string[] = [];

  // Generate URL construction code
  const urlExpression = generateUrlConstruction(request, node, bodyParts);

  // Generate headers and request options
  generateHeadersAndOptions(request, bodyParts);

  // Generate request execution and response handling
  generateRequestExecution(urlExpression, bodyParts);
  generateResponseHandling(bodyParts);

  // Generate variable extraction comments
  generateVariableExtractionComments(node, bodyParts);

  // Generate return statement - use the imported template function
  const returnStmt = generateReturnStatement();
  bodyParts.push(
    ...returnStmt
      .split("\n")
      .map((line) => `    ${line.trim()}`)
      .filter((line) => line.trim())
  );

  // Combine body parts
  const tryBody = bodyParts.join("\n");
  const catchHandler = generateCatchBlock(functionName);
  const functionBody = `  try {\n${tryBody}\n  ${catchHandler}`;

  // Generate complete function using template
  const parameters = generateFunctionParameters(node);
  const completeFunction = generateFunctionWithDocumentation(
    documentation,
    functionName,
    parameters,
    `ApiResponse<${responseType}>`,
    functionBody
  );

  return completeFunction;
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

  return generateCookieNodeComment(cookieKey, cookieValue);
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
  return generateNotFoundNodeFunction(functionName, missingPart);
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
  return generateFileHeader(session.prompt, session.id);
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
    logger.warn("Response type inference failed", {
      error: error instanceof Error ? error.message : "Unknown error",
    });
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
  const inferredTypes = session ? inferResponseTypes(session) : undefined;
  return generateTypeDefinitions(inferredTypes);
}

/**
 * Generate main function and exports
 */
export function generateFooter(
  session: HarvestSession,
  nodeFunctionNameMap?: Map<string, string>
): string {
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

  // Generate main function using templates
  const mainFunctionDoc = generateJSDocComment(
    "Main function that executes the complete API workflow"
  );

  let mainFunctionBody: string;
  if (functionNames.length === 0) {
    mainFunctionBody = generateMainFunctionEmptyBody();
  } else {
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

    if (!masterFunctionName) {
      throw new Error("No master function found in the generated code");
    }

    mainFunctionBody = generateMainFunctionWithMaster(masterFunctionName);
  }

  const mainFunction = generateAsyncFunction(
    "main",
    "",
    "ApiResponse",
    mainFunctionBody
  );

  // Generate exports using template
  const exportBlock = generateExportBlock(functionNames);

  // Generate usage example using template
  const usageExample = generateUsageExample("./generated-api-integration.ts");

  // Combine all parts
  return `${mainFunctionDoc}
${mainFunction}

${exportBlock}

${usageExample}`;
}

/**
 * Generate JSDoc documentation for the function
 */
function generateFunctionDocumentation(
  node: DAGNode,
  request: RequestModel
): string[] {
  const description = `${node.nodeType === "master_curl" ? "Main API call" : "Dependency request"}: ${request.method} ${request.url}`;

  const additionalLines: string[] = [];
  if (node.extractedParts && node.extractedParts.length > 0) {
    additionalLines.push(`Extracts: ${node.extractedParts.join(", ")}`);
  }
  if (node.inputVariables && Object.keys(node.inputVariables).length > 0) {
    additionalLines.push(
      `Input variables: ${Object.keys(node.inputVariables).join(", ")}`
    );
  }

  return generateJSDocComment(description, additionalLines).split("\n");
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

  // Generate URL construction using templates
  const queryParams = request.queryParams; // Already checked above for existence
  if (!queryParams) {
    return "url.toString()"; // Should never happen but type safety
  }

  const staticParamsList = staticParams.map((key) => ({
    key,
    value: queryParams[key] as string, // Type safe - we know queryParams exists and has string values
  }));

  const configurableParamsList = configurableParams.map((key) => {
    const defaultValue = queryParams[key];
    // Check if this parameter should come from function arguments
    const paramName =
      node.inputVariables &&
      defaultValue &&
      Object.values(node.inputVariables).includes(defaultValue)
        ? Object.keys(node.inputVariables).find(
            (k) => node.inputVariables?.[k] === defaultValue
          ) || key
        : key;

    return { key, paramName };
  });

  const dynamicParamsList = dynamicParams.map((key) => ({
    key,
    value: queryParams[key] as string, // Type safe - we know queryParams exists and has string values
  }));

  // Generate the URL construction code using templates
  const parameterSetupCode = generateParameterSetup({
    static: staticParamsList,
    configurable: configurableParamsList,
    dynamic: dynamicParamsList,
  });

  const urlConstructionCode = generateUrlWithParams(
    baseUrl as string,
    parameterSetupCode || ""
  );
  lines.push(...urlConstructionCode.split("\n"));

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
  // Generate headers using template
  const headersCode = generateHeadersObject(request.headers, true);
  lines.push(headersCode);
  lines.push("");

  // Generate authentication setup based on detected type
  const authInfo = detectRequestAuthentication(request);
  const authSetupCode = generateAuthSetup(authInfo);
  lines.push(...authSetupCode.split("\n"));
  lines.push("");

  // Generate request options using template
  const requestOptionsCode = generateRequestOptions(
    request.method,
    request.body
  );
  lines.push(requestOptionsCode);
  lines.push("");
}

/**
 * Generate request execution code
 */
function generateRequestExecution(
  urlExpression: string,
  lines: string[]
): void {
  // Generate fetch call
  const fetchCallCode = generateFetchCall(urlExpression);
  lines.push(fetchCallCode);
  lines.push("");

  // Generate authentication error handling with retry logic
  const authErrorHandlingCode = generateAuthErrorHandling(urlExpression);
  lines.push(...authErrorHandlingCode.split("\n"));
  lines.push("");

  // Generate basic response check
  const responseOkCheckCode = generateResponseOkCheck();
  lines.push(responseOkCheckCode);
  lines.push("");
}

/**
 * Generate response parsing code
 */
function generateResponseHandling(lines: string[]): void {
  const responseProcessingCode = generateResponseProcessing();
  lines.push(...responseProcessingCode.split("\n"));
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

// ========== Multi-Workflow Code Generation ==========

/**
 * Analyze workflow requirements to determine if multi-workflow client is needed
 */
function analyzeWorkflowRequirements(session: HarvestSession): {
  hasMultipleWorkflows: boolean;
  workflows: Array<{
    id: string;
    name: string;
    description: string;
    category: string;
    priority: number;
    complexity: number;
    requiresUserInput: boolean;
    masterNodeId: string;
    nodeIds: string[];
  }>;
  workflowCount: number;
} {
  const workflows = Array.from(session.state.workflowGroups?.values() || []);

  const workflowInfo = workflows.map((workflow) => ({
    id: workflow.id,
    name: workflow.name,
    description: workflow.description,
    category: workflow.category,
    priority: workflow.priority,
    complexity: workflow.complexity,
    requiresUserInput: workflow.requiresUserInput,
    masterNodeId: workflow.masterNodeId,
    nodeIds: Array.from(workflow.nodeIds),
  }));

  return {
    hasMultipleWorkflows: workflows.length > 1,
    workflows: workflowInfo,
    workflowCount: workflows.length,
  };
}

/**
 * Generate workflow-based client for multi-workflow APIs
 */
function generateWorkflowBasedClient(
  session: HarvestSession,
  workflowInfo: ReturnType<typeof analyzeWorkflowRequirements>
): string {
  const parts: string[] = [];

  // 1. File header with workflow metadata
  parts.push(generateWorkflowHeader(session, workflowInfo));
  parts.push("");

  // 2. Imports and types
  parts.push(generateWorkflowImports(session));
  parts.push("");

  // 3. Workflow interfaces
  parts.push(generateWorkflowInterfaces(workflowInfo));
  parts.push("");

  // 4. Main API client class with workflow methods
  parts.push(generateWorkflowAPIClientClass(session, workflowInfo));
  parts.push("");

  // 5. Export statement
  parts.push(generateWorkflowExportStatement(session));

  return parts.join("\n");
}

/**
 * Generate header for workflow-based clients
 */
function generateWorkflowHeader(
  session: HarvestSession,
  workflowInfo: ReturnType<typeof analyzeWorkflowRequirements>
): string {
  const additionalLines: string[] = [
    `Source: ${session.prompt}`,
    `Generated: ${new Date().toISOString()}`,
    "",
    `This client provides ${workflowInfo.workflowCount} distinct workflows:`,
  ];

  for (const workflow of workflowInfo.workflows) {
    additionalLines.push(
      `- ${workflow.name}: ${workflow.description} (${workflow.category})`
    );
  }

  additionalLines.push(
    "",
    "Usage:",
    "  const client = new APIClient();",
    "  const workflows = client.getAvailableWorkflows();",
    "  const result = await client.executeWorkflow('workflow-id', params);"
  );

  return generateJSDocComment(
    "Generated Multi-Workflow API Client",
    additionalLines
  );
}

/**
 * Generate imports for workflow-based clients
 */
function generateWorkflowImports(session: HarvestSession): string {
  // Combine comment with standard imports
  return `// HTTP client and type definitions

${generateImports(session)}`;
}

/**
 * Generate workflow-specific interfaces
 */
function generateWorkflowInterfaces(
  _workflowInfo: ReturnType<typeof analyzeWorkflowRequirements>
): string {
  const workflowInfoDoc = generateJSDocComment("Workflow metadata interface");
  const workflowInfoInterface = generateInterface("WorkflowInfo", [
    { name: "id", type: "string" },
    { name: "name", type: "string" },
    { name: "description", type: "string" },
    { name: "category", type: "string" },
    { name: "priority", type: "number" },
    { name: "complexity", type: "number" },
    { name: "requiresUserInput", type: "boolean" },
  ]);

  const workflowResultDoc = generateJSDocComment("Workflow execution result");
  const workflowResultInterface = generateInterface("WorkflowResult<T = any>", [
    { name: "workflowId", type: "string" },
    { name: "success", type: "boolean" },
    { name: "data", type: "T" },
    { name: "executionTime", type: "number" },
    {
      name: "metadata",
      type: "{\n    requestCount: number;\n    workflow: WorkflowInfo;\n  }",
    },
  ]);

  return `${workflowInfoDoc}
${workflowInfoInterface}

${workflowResultDoc}
${workflowResultInterface}`;
}

/**
 * Generate the main workflow API client class
 */
function generateWorkflowAPIClientClass(
  session: HarvestSession,
  workflowInfo: ReturnType<typeof analyzeWorkflowRequirements>
): string {
  const parts: string[] = [];

  // Class definition
  parts.push("export class APIClient {");
  parts.push("  private workflows: Map<string, WorkflowInfo> = new Map();");
  parts.push("");

  // Constructor to initialize workflows
  parts.push("  constructor() {");
  parts.push("    this.initializeWorkflows();");
  parts.push("  }");
  parts.push("");

  // Initialize workflows method
  parts.push("  /**");
  parts.push("   * Initialize available workflows");
  parts.push("   */");
  parts.push("  private initializeWorkflows(): void {");

  for (const workflow of workflowInfo.workflows) {
    parts.push("    this.workflows.set(");
    parts.push(`      '${workflow.id}',`);
    parts.push("      {");
    parts.push(`        id: '${workflow.id}',`);
    parts.push(`        name: '${workflow.name}',`);
    parts.push(`        description: '${workflow.description}',`);
    parts.push(`        category: '${workflow.category}',`);
    parts.push(`        priority: ${workflow.priority},`);
    parts.push(`        complexity: ${workflow.complexity},`);
    parts.push(`        requiresUserInput: ${workflow.requiresUserInput},`);
    parts.push("      }");
    parts.push("    );");
  }

  parts.push("  }");
  parts.push("");

  // Get available workflows method
  parts.push("  /**");
  parts.push("   * Get all available workflows");
  parts.push("   */");
  parts.push("  getAvailableWorkflows(): WorkflowInfo[] {");
  parts.push("    return Array.from(this.workflows.values())");
  parts.push("      .sort((a, b) => b.priority - a.priority);");
  parts.push("  }");
  parts.push("");

  // Get workflow by category
  parts.push("  /**");
  parts.push("   * Get workflows by category");
  parts.push("   */");
  parts.push("  getWorkflowsByCategory(category: string): WorkflowInfo[] {");
  parts.push("    return this.getAvailableWorkflows()");
  parts.push("      .filter(w => w.category === category);");
  parts.push("  }");
  parts.push("");

  // Execute workflow method
  parts.push("  /**");
  parts.push("   * Execute a specific workflow");
  parts.push("   */");
  parts.push(
    "  async executeWorkflow(workflowId: string, params: any = {}): Promise<WorkflowResult> {"
  );
  parts.push("    const startTime = Date.now();");
  parts.push("    const workflow = this.workflows.get(workflowId);");
  parts.push("");
  parts.push("    if (!workflow) {");
  parts.push(
    `      throw new Error(\`Workflow '\${workflowId}' not found. Available: \${Array.from(this.workflows.keys()).join(', ')}\`);`
  );
  parts.push("    }");
  parts.push("");

  // Generate switch statement for different workflows
  parts.push("    let result: any;");
  parts.push("    let requestCount = 0;");
  parts.push("");
  parts.push("    switch (workflowId) {");

  for (const workflow of workflowInfo.workflows) {
    parts.push(`      case '${workflow.id}':`);
    parts.push(
      `        result = await this.execute${toPascalCase(workflow.id)}(params);`
    );
    parts.push(
      `        requestCount = ${workflow.nodeIds.length}; // Number of nodes in workflow`
    );
    parts.push("        break;");
    parts.push("");
  }

  parts.push("      default:");
  parts.push(`        ${workflowNotFound("workflowId")}`);
  parts.push("    }");
  parts.push("");
  parts.push("    const executionTime = Date.now() - startTime;");
  parts.push("");
  parts.push("    return {");
  parts.push("      workflowId,");
  parts.push("      success: true,");
  parts.push("      data: result,");
  parts.push("      executionTime,");
  parts.push("      metadata: {");
  parts.push("        requestCount,");
  parts.push("        workflow,");
  parts.push("      },");
  parts.push("    };");
  parts.push("  }");
  parts.push("");

  // Generate individual workflow methods
  for (const workflow of workflowInfo.workflows) {
    parts.push(...generateWorkflowMethod(session, workflow));
    parts.push("");
  }

  parts.push("}");

  return parts.join("\n");
}

/**
 * Generate individual workflow execution method
 */
function generateWorkflowMethod(
  session: HarvestSession,
  workflow: {
    id: string;
    name: string;
    description: string;
    masterNodeId: string;
    nodeIds: string[];
    requiresUserInput: boolean;
  }
): string[] {
  const parts: string[] = [];
  const methodName = `execute${toPascalCase(workflow.id)}`;

  parts.push("  /**");
  parts.push(`   * ${workflow.name}: ${workflow.description}`);
  if (workflow.requiresUserInput) {
    parts.push("   * Requires user input parameters");
  }
  parts.push("   */");
  parts.push(`  private async ${methodName}(params: any = {}): Promise<any> {`);

  // Get the master node for this workflow
  const masterNode = session.dagManager.getNode(workflow.masterNodeId);

  if (masterNode?.content.key) {
    const request = masterNode.content.key as RequestModel;

    // Generate URL construction
    parts.push(`    const baseUrl = '${getBaseUrl(request.url)}';`);
    parts.push("    const searchParams = new URLSearchParams();");
    parts.push("");

    // Add parameters
    if (request.queryParams) {
      for (const [key, value] of Object.entries(request.queryParams)) {
        if (workflow.requiresUserInput && isLikelyUserInput(key, value)) {
          parts.push(`    if (params.${toCamelCase(key)} !== undefined) {`);
          parts.push(
            `      searchParams.set('${key}', String(params.${toCamelCase(key)}));`
          );
          parts.push("    } else {");
          parts.push(
            `      searchParams.set('${key}', '${value}'); // Default value`
          );
          parts.push("    }");
        } else {
          parts.push(`    searchParams.set('${key}', '${value}');`);
        }
      }
    }

    parts.push("");
    parts.push(
      "    " +
        fetchWithQueryParams("response", "baseUrl", "searchParams.toString()")
    );
    parts.push(`      method: '${request.method}',`);
    parts.push("      headers: {");

    for (const [key, value] of Object.entries(request.headers)) {
      parts.push(`        '${key}': '${value}',`);
    }

    parts.push("      },");

    if (request.body) {
      parts.push(
        `      body: JSON.stringify(params.body || ${JSON.stringify(request.body)}),`
      );
    }

    parts.push("    });");
    parts.push("");
    parts.push("    if (!response.ok) {");
    parts.push(`      ${workflowFailed("workflow")}`);
    parts.push("    }");
    parts.push("");
    parts.push("    return await response.json();");
  } else {
    // Fallback for missing master node
    parts.push("    // TODO: Implement workflow logic");
    parts.push("    throw new Error('Workflow implementation not available');");
  }

  parts.push("  }");

  return parts;
}

/**
 * Generate export statement for workflow client
 */
function generateWorkflowExportStatement(_session: HarvestSession): string {
  return "// Export the workflow-based client\nexport default APIClient;";
}

// ========== Session-Aware Code Generation ==========

/**
 * Analyze session requirements to determine if session management is needed
 */
function analyzeSessionRequirements(session: HarvestSession): {
  requiresSessionManagement: boolean;
  bootstrapParameters: Array<{
    name: string;
    value: string;
    bootstrapSource: import("../types/index.js").BootstrapParameterSource;
  }>;
  sessionConstantsCount: number;
  bootstrapUrl?: string;
} {
  const bootstrapParameters: Array<{
    name: string;
    value: string;
    bootstrapSource: import("../types/index.js").BootstrapParameterSource;
  }> = [];

  let sessionConstantsCount = 0;
  let bootstrapUrl: string | undefined;

  // Iterate through all nodes to find session constants with bootstrap sources
  const allNodes = session.dagManager.getAllNodes();

  for (const [, node] of allNodes) {
    if (node.classifiedParameters) {
      for (const param of node.classifiedParameters) {
        if (param.classification === "sessionConstant") {
          sessionConstantsCount++;

          if (param.metadata.bootstrapSource) {
            bootstrapParameters.push({
              name: param.name,
              value: param.value,
              bootstrapSource: param.metadata.bootstrapSource,
            });

            // Set bootstrap URL from the first bootstrap source found
            if (!bootstrapUrl) {
              bootstrapUrl = param.metadata.bootstrapSource.sourceUrl;
            }
          }
        }
      }
    }
  }

  const requiresSessionManagement = bootstrapParameters.length > 0;

  const result: {
    requiresSessionManagement: boolean;
    bootstrapParameters: Array<{
      name: string;
      value: string;
      bootstrapSource: import("../types/index.js").BootstrapParameterSource;
    }>;
    sessionConstantsCount: number;
    bootstrapUrl?: string;
  } = {
    requiresSessionManagement,
    bootstrapParameters,
    sessionConstantsCount,
  };

  if (bootstrapUrl) {
    result.bootstrapUrl = bootstrapUrl;
  }

  return result;
}

/**
 * Generate session-aware client class for APIs that require bootstrap parameters
 */
function generateSessionAwareClient(
  session: HarvestSession,
  sessionInfo: ReturnType<typeof analyzeSessionRequirements>
): string {
  const parts: string[] = [];

  // 1. File header with session-aware metadata
  parts.push(generateSessionAwareHeader(session, sessionInfo));
  parts.push("");

  // 2. Imports and types
  parts.push(generateSessionAwareImports(session));
  parts.push("");

  // 3. Session configuration interface
  parts.push(generateSessionConfigInterface(sessionInfo));
  parts.push("");

  // 4. Main API client class
  parts.push(generateAPIClientClass(session, sessionInfo));
  parts.push("");

  // 5. Export statement
  parts.push(generateExportStatement(session));

  return parts.join("\n");
}

/**
 * Generate header for session-aware clients
 */
function generateSessionAwareHeader(
  session: HarvestSession,
  sessionInfo: ReturnType<typeof analyzeSessionRequirements>
): string {
  const parts: string[] = [];

  parts.push("/**");
  parts.push(" * Generated API Client with Session Management");
  parts.push(` * Source: ${session.prompt}`);
  parts.push(` * Generated: ${new Date().toISOString()}`);
  parts.push(" * ");
  parts.push(" * This client manages session state automatically by:");
  parts.push(
    ` * - Initializing sessions from ${sessionInfo.bootstrapUrl || "main page"}`
  );
  parts.push(
    ` * - Extracting session parameters: ${sessionInfo.bootstrapParameters.map((p) => p.name).join(", ")}`
  );
  parts.push(" * - Managing session lifecycle across API calls");
  parts.push(" * ");
  parts.push(" * Usage:");
  parts.push(" *   const client = new APIClient();");
  parts.push(" *   await client.initialize();");
  parts.push(" *   const result = await client.performAction(params);");
  parts.push(" */");

  return parts.join("\n");
}

/**
 * Generate imports for session-aware clients
 */
function generateSessionAwareImports(_session: HarvestSession): string {
  const parts: string[] = [];

  parts.push("// HTTP client for making requests");
  parts.push(
    "// You can replace this with axios, node-fetch, or your preferred HTTP library"
  );
  parts.push("");

  return parts.join("\n");
}

/**
 * Generate session configuration interface
 */
function generateSessionConfigInterface(
  sessionInfo: ReturnType<typeof analyzeSessionRequirements>
): string {
  const parts: string[] = [];

  parts.push("/**");
  parts.push(" * Session configuration containing dynamic parameters");
  parts.push(" */");
  parts.push("interface SessionConfig {");

  for (const param of sessionInfo.bootstrapParameters) {
    parts.push(
      `  ${param.name}: string; // From ${param.bootstrapSource.type}`
    );
  }

  parts.push("}");

  return parts.join("\n");
}

/**
 * Generate the main API client class
 */
function generateAPIClientClass(
  session: HarvestSession,
  sessionInfo: ReturnType<typeof analyzeSessionRequirements>
): string {
  const parts: string[] = [];

  // Class definition
  parts.push("export class APIClient {");
  parts.push("  private session: SessionConfig | null = null;");
  parts.push("");

  // Initialize session method
  parts.push("  /**");
  parts.push("   * Initialize session by fetching bootstrap parameters");
  parts.push("   */");
  parts.push("  async initializeSession(): Promise<void> {");
  parts.push(
    `    const response = await fetch('${sessionInfo.bootstrapUrl}');`
  );
  parts.push("    ");

  // Generate extraction logic based on bootstrap sources
  for (const param of sessionInfo.bootstrapParameters) {
    const source = param.bootstrapSource;

    if (source.type === "initial-page-html") {
      parts.push("    // Extract from HTML content");
      parts.push("    const htmlContent = await response.text();");
      parts.push(
        `    const ${param.name}Match = htmlContent.match(/${source.extractionDetails.pattern}/i);`
      );
      parts.push(`    if (!${param.name}Match || !${param.name}Match[1]) {`);
      parts.push(
        `      throw new Error('Failed to extract ${param.name} from page');`
      );
      parts.push("    }");
      parts.push(`    const ${param.name} = ${param.name}Match[1];`);
      parts.push("");
    } else if (source.type === "initial-page-cookie") {
      parts.push("    // Extract from Set-Cookie headers");
      parts.push(
        "    const cookies = response.headers.get('set-cookie') || '';"
      );
      parts.push(
        `    const ${param.name}Match = cookies.match(/${source.extractionDetails.pattern}/);`
      );
      parts.push(`    if (!${param.name}Match || !${param.name}Match[1]) {`);
      parts.push(
        `      throw new Error('Failed to extract ${param.name} from cookies');`
      );
      parts.push("    }");
      parts.push(`    const ${param.name} = ${param.name}Match[1];`);
      parts.push("");
    }
  }

  // Store session
  parts.push("    this.session = {");
  for (const param of sessionInfo.bootstrapParameters) {
    parts.push(`      ${param.name},`);
  }
  parts.push("    };");
  parts.push("  }");
  parts.push("");

  // Ensure session helper
  parts.push("  /**");
  parts.push("   * Ensure session is initialized");
  parts.push("   */");
  parts.push("  private async ensureSession(): Promise<void> {");
  parts.push("    if (!this.session) {");
  parts.push("      await this.initializeSession();");
  parts.push("    }");
  parts.push("  }");
  parts.push("");

  // Generate API methods
  parts.push(...generateSessionAwareAPIMethods(session, sessionInfo));

  parts.push("}");

  return parts.join("\n");
}

/**
 * Generate API methods that use session state
 */
function generateSessionAwareAPIMethods(
  session: HarvestSession,
  sessionInfo: ReturnType<typeof analyzeSessionRequirements>
): string[] {
  const parts: string[] = [];

  // Get the main action node
  const masterNodeId = session.state.masterNodeId;
  if (!masterNodeId) {
    parts.push("  // No master node identified");
    return parts;
  }

  const masterNode = session.dagManager.getNode(masterNodeId);
  if (
    !masterNode ||
    (masterNode.nodeType !== "master" && masterNode.nodeType !== "master_curl")
  ) {
    parts.push("  // Master node not found or invalid");
    return parts;
  }

  const request = masterNode.content.key as RequestModel;

  parts.push("  /**");
  parts.push("   * Perform the main API action with session management");
  parts.push("   */");
  parts.push("  async performAction(params: any = {}): Promise<any> {");
  parts.push("    await this.ensureSession();");
  parts.push("");
  parts.push("    // Build URL with session parameters");
  parts.push(`    const baseUrl = '${getBaseUrl(request.url)}';`);
  parts.push("    const searchParams = new URLSearchParams();");
  parts.push("");

  // Add session parameters
  for (const param of sessionInfo.bootstrapParameters) {
    parts.push(
      `    searchParams.set('${param.name}', this.session!.${param.name});`
    );
  }

  // Add other parameters from the original request
  if (request.queryParams) {
    for (const [key, value] of Object.entries(request.queryParams)) {
      // Skip session constants as they're already added above
      const isSessionConstant = sessionInfo.bootstrapParameters.some(
        (p) => p.name === key
      );
      if (!isSessionConstant) {
        parts.push(`    searchParams.set('${key}', '${value}');`);
      }
    }
  }

  parts.push("");
  parts.push("    // Make the request");
  parts.push(
    "    " +
      fetchWithQueryParams("response", "baseUrl", "searchParams.toString()")
  );
  parts.push(`      method: '${request.method}',`);
  parts.push("      headers: {");

  // Add headers
  for (const [key, value] of Object.entries(request.headers)) {
    if (key.toLowerCase() !== "cookie") {
      // Skip cookie header as it may contain session info
      parts.push(`        '${key}': '${value}',`);
    }
  }

  parts.push("      },");

  // Add body if it's a POST request
  if (request.method.toUpperCase() === "POST" && request.body) {
    parts.push(
      `      body: JSON.stringify(params.body || ${JSON.stringify(request.body)}),`
    );
  }

  parts.push("    });");
  parts.push("");
  parts.push("    if (!response.ok) {");
  parts.push(`      ${apiRequestFailed()}`);
  parts.push("    }");
  parts.push("");
  parts.push("    return await response.json();");
  parts.push("  }");

  return parts;
}

/**
 * Extract base URL from full URL
 */
function getBaseUrl(fullUrl: string): string {
  const url = new URL(fullUrl);
  return `${url.protocol}//${url.host}${url.pathname}`;
}

/**
 * Generate export statement
 */
function generateExportStatement(_session: HarvestSession): string {
  return "// Export the client for use\nexport default APIClient;";
}
