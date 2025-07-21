import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { findDependencies } from "../agents/DependencyAgent.js";
import { identifyDynamicParts } from "../agents/DynamicPartsAgent.js";
import { identifyInputVariables } from "../agents/InputVariablesAgent.js";
import { classifyParameters } from "../agents/ParameterClassificationAgent.js";
import { identifyEndUrl } from "../agents/URLIdentificationAgent.js";
import {
  discoverWorkflows,
  getPrimaryWorkflow,
} from "../agents/WorkflowDiscoveryAgent.js";
import {
  type AnalysisToolContext,
  type ClassifiedParameter,
  HarvestError,
  type HarvestSession,
  SessionIdSchema,
  type URLInfo,
} from "../types/index.js";

/**
 * Handle initial analysis with CLI configuration
 */
export async function handleRunInitialAnalysisWithConfig(
  params: { sessionId: string },
  context: AnalysisToolContext
): Promise<CallToolResult> {
  try {
    const session = context.sessionManager.getSession(params.sessionId);
    if (!session) {
      throw new HarvestError(
        `Session ${params.sessionId} not found`,
        "SESSION_NOT_FOUND"
      );
    }

    // Check HAR data quality before proceeding
    if (session.harData.validation) {
      const validation = session.harData.validation;

      if (validation.quality === "empty") {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error: "Cannot analyze empty HAR file",
                message: "No meaningful network requests found in HAR file",
                issues: validation.issues,
                recommendations: validation.recommendations,
                stats: validation.stats,
                nextSteps: [
                  "1. Capture a new HAR file with meaningful interactions",
                  "2. Ensure you interact with the website's main functionality",
                  "3. Look for forms, buttons, or API calls to capture",
                ],
              }),
            },
          ],
          isError: true,
        };
      }

      if (validation.quality === "poor") {
        context.sessionManager.addLog(
          params.sessionId,
          "warn",
          `Proceeding with poor quality HAR file: ${validation.issues.join(", ")}`
        );
      }
    }

    // Check if we have any URLs available
    if (!session.harData.urls || session.harData.urls.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              error: "Cannot analyze - no URLs found",
              message: "No URLs available for analysis",
              nextSteps: [
                "1. Capture a new HAR file with website interactions",
                "2. Ensure network requests are recorded during capture",
                "3. Use session_start with a valid HAR file",
              ],
            }),
          },
        ],
        isError: true,
      };
    }

    // Identify end URL using CLI-configured LLM client
    let actionUrl: string;
    try {
      actionUrl = await identifyEndUrl(session, session.harData.urls);
    } catch (error) {
      // If LLM-based identification fails, use heuristic fallback
      if (
        error instanceof HarvestError &&
        error.code === "NO_PROVIDER_CONFIGURED"
      ) {
        context.sessionManager.addLog(
          params.sessionId,
          "warn",
          "LLM provider not configured, using heuristic URL selection"
        );
        actionUrl = selectUrlHeuristically(session.harData.urls);
      } else {
        throw error;
      }
    }

    // Find the corresponding request in HAR data
    const targetRequest = session.harData.requests.find(
      (req) => req.url === actionUrl
    );

    if (!targetRequest) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              error: "Target request not found",
              message: `URL ${actionUrl} not found in HAR data`,
              nextSteps: [
                "1. Check HAR file contains the expected requests",
                "2. Verify the URL identification is working correctly",
                "3. Try with a different HAR file",
              ],
            }),
          },
        ],
        isError: true,
      };
    }

    // Create DAG node for the target request
    const nodeId = session.dagManager.addNode("master_curl", {
      key: targetRequest,
    });

    // Set as master node
    session.state.masterNodeId = nodeId;

    // Sync completion state after master node creation
    context.sessionManager.syncCompletionState(params.sessionId);

    context.sessionManager.addLog(
      params.sessionId,
      "info",
      `Initial analysis complete. Master node created: ${nodeId}`
    );

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            status: "success",
            message: "Initial analysis completed successfully",
            actionUrl,
            masterNodeId: nodeId,
            targetRequest: {
              url: targetRequest.url,
              method: targetRequest.method,
              headers: targetRequest.headers,
              body: targetRequest.body,
            },
          }),
        },
      ],
    };
  } catch (error) {
    if (error instanceof HarvestError) {
      throw error;
    }

    throw new HarvestError(
      `Initial analysis failed: ${error instanceof Error ? error.message : "Unknown error"}`,
      "INITIAL_ANALYSIS_FAILED",
      { originalError: error }
    );
  }
}

/**
 * Handle analysis.process_next_node tool
 */
export async function handleProcessNextNode(
  params: { sessionId: string },
  context: AnalysisToolContext
): Promise<CallToolResult> {
  try {
    const session = context.sessionManager.getSession(params.sessionId);
    if (!session) {
      throw new HarvestError(
        `Session ${params.sessionId} not found`,
        "SESSION_NOT_FOUND"
      );
    }

    // Check if there are nodes available for processing
    const noNodesResult = checkNoNodesToProcess(session);
    if (noNodesResult) {
      return noNodesResult;
    }

    // Extract and validate the next node
    const { nodeId, curlCommand } = extractNextNodeForProcessing(
      session,
      params.sessionId,
      context
    );

    // Handle JavaScript file skipping
    const jsSkipResult = handleJavaScriptFileSkip(
      curlCommand,
      nodeId,
      session,
      params.sessionId,
      context
    );
    if (jsSkipResult) {
      return jsSkipResult;
    }

    // Process dynamic parts and input variables
    const {
      dynamicParts,
      finalDynamicParts,
      identifiedInputVars,
      classifiedParameters,
    } = await processDynamicPartsAndInputVariables(
      curlCommand,
      session,
      params.sessionId,
      nodeId,
      context
    );

    // Update node with processed information including parameter classification
    session.dagManager.updateNode(nodeId, {
      dynamicParts: finalDynamicParts,
      inputVariables: identifiedInputVars,
      classifiedParameters: classifiedParameters,
    });

    // Process dependencies and add new nodes
    const newNodesAdded = await processDependenciesAndAddNodes(
      finalDynamicParts,
      nodeId,
      session,
      params.sessionId,
      context
    );

    // Generate final response
    return generateNodeProcessingResponse(
      nodeId,
      dynamicParts,
      identifiedInputVars,
      finalDynamicParts,
      newNodesAdded,
      session,
      params.sessionId,
      context
    );
  } catch (error) {
    return handleNodeProcessingError(error);
  }
}

/**
 * Handle analysis.is_complete tool - Uses comprehensive completion analysis as single source of truth
 */
export function handleIsComplete(
  params: { sessionId: string },
  context: AnalysisToolContext
): CallToolResult {
  try {
    // Use the comprehensive completion analysis as the single source of truth
    const analysis = context.sessionManager.analyzeCompletionState(
      params.sessionId
    );

    // Determine status and next actions based on comprehensive analysis
    let status: string;
    let nextActions: string[];

    if (analysis.isComplete) {
      status = "ready_for_code_generation";
      nextActions = [
        "Use 'codegen_generate_wrapper_script' to generate TypeScript code",
        "Analysis is fully complete and ready for code generation",
      ];
    } else if (analysis.diagnostics.pendingInQueue > 0) {
      status = "analysis_in_progress";
      nextActions = [
        "Continue with 'analysis_process_next_node' to process remaining nodes",
        `${analysis.diagnostics.pendingInQueue} nodes remaining in processing queue`,
      ];
    } else if (analysis.diagnostics.unresolvedNodes > 0) {
      status = "needs_intervention";
      nextActions = [
        "Use 'debug_get_unresolved_nodes' to see specific unresolved parts",
        "Consider using 'debug_force_dependency' for manual intervention",
        "Or use 'debug_set_master_node' if URL identification failed",
      ];
    } else if (
      !analysis.diagnostics.hasMasterNode ||
      !analysis.diagnostics.hasActionUrl
    ) {
      status = "analysis_not_started";
      nextActions = [
        "Use 'analysis_run_initial_analysis' to identify the target action URL",
        "Or use 'debug_set_master_node' to manually specify the target URL",
      ];
    } else {
      status = "analysis_stalled";
      nextActions = [
        "Check session status with 'session_status'",
        "Consider restarting analysis or manual intervention",
      ];
    }

    // Log the comprehensive completion check
    context.sessionManager.addLog(
      params.sessionId,
      "info",
      `Comprehensive completion check: ${status} - ${analysis.blockers.length} blockers, ${analysis.diagnostics.unresolvedNodes} unresolved nodes`
    );

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            isComplete: analysis.isComplete,
            status,
            blockers: analysis.blockers,
            recommendations: analysis.recommendations,
            diagnostics: analysis.diagnostics,
            nextActions,
            summary: analysis.isComplete
              ? "Analysis completed successfully - ready for code generation"
              : `Analysis incomplete: ${analysis.blockers.length} blockers preventing completion`,
            detailedStatus: {
              masterNodeIdentified: analysis.diagnostics.hasMasterNode,
              actionUrlFound: analysis.diagnostics.hasActionUrl,
              dagComplete: analysis.diagnostics.dagComplete,
              queueEmpty: analysis.diagnostics.queueEmpty,
              totalNodes: analysis.diagnostics.totalNodes,
              unresolvedNodes: analysis.diagnostics.unresolvedNodes,
              pendingInQueue: analysis.diagnostics.pendingInQueue,
            },
          }),
        },
      ],
    };
  } catch (error) {
    if (error instanceof HarvestError) {
      throw error;
    }

    throw new HarvestError(
      `Completion check failed: ${error instanceof Error ? error.message : "Unknown error"}`,
      "COMPLETION_CHECK_FAILED",
      { originalError: error }
    );
  }
}

/**
 * Handle analysis.discover_workflows tool
 */
export async function handleDiscoverWorkflows(
  params: { sessionId: string },
  context: AnalysisToolContext
): Promise<CallToolResult> {
  try {
    const session = context.sessionManager.getSession(params.sessionId);
    if (!session) {
      throw new HarvestError(
        `Session ${params.sessionId} not found`,
        "SESSION_NOT_FOUND"
      );
    }

    // Check HAR data quality before proceeding
    if (session.harData.validation) {
      const validation = session.harData.validation;

      if (validation.quality === "empty") {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error: "Cannot discover workflows from empty HAR file",
                message: "No meaningful network requests found in HAR file",
                issues: validation.issues,
                recommendations: validation.recommendations,
                stats: validation.stats,
                nextSteps: [
                  "1. Capture a new HAR file with meaningful interactions",
                  "2. Ensure you interact with the website's main functionality",
                  "3. Look for forms, buttons, or API calls to capture",
                ],
              }),
            },
          ],
          isError: true,
        };
      }

      if (validation.quality === "poor") {
        context.sessionManager.addLog(
          params.sessionId,
          "warn",
          `Proceeding with poor quality HAR file: ${validation.issues.join(", ")}`
        );
      }
    }

    // Check if we have any URLs available
    if (!session.harData.urls || session.harData.urls.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              error: "Cannot discover workflows - no URLs found",
              message: "No URLs available for workflow analysis",
              nextSteps: [
                "1. Capture a new HAR file with website interactions",
                "2. Ensure network requests are recorded during capture",
                "3. Use session_start with a valid HAR file",
              ],
            }),
          },
        ],
        isError: true,
      };
    }

    // Discover workflows using the WorkflowDiscoveryAgent
    const workflowGroups = await discoverWorkflows(session);

    if (workflowGroups.size === 0) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              error: "No workflows discovered",
              message:
                "Failed to identify any logical workflow groups from the HAR data",
              recommendations: [
                "The HAR file may contain only simple requests without complex workflows",
                "Try capturing a more comprehensive user interaction sequence",
                "Consider using the legacy analysis_run_initial_analysis for simple APIs",
              ],
              stats: {
                totalUrls: session.harData.urls.length,
                totalRequests: session.harData.requests.length,
              },
            }),
          },
        ],
        isError: false, // Not really an error, just no complex workflows found
      };
    }

    // Update session state with discovered workflows
    session.state.workflowGroups = workflowGroups;

    // Select primary workflow if none specified
    const primaryWorkflow = getPrimaryWorkflow(workflowGroups);
    if (primaryWorkflow) {
      session.state.activeWorkflowId = primaryWorkflow.id;
      context.sessionManager.addLog(
        params.sessionId,
        "info",
        `Selected primary workflow: ${primaryWorkflow.name} (${primaryWorkflow.id})`
      );
    }

    context.sessionManager.addLog(
      params.sessionId,
      "info",
      `Workflow discovery complete. Found ${workflowGroups.size} workflow groups`
    );

    // Prepare workflow summary for response
    const workflowSummary = Array.from(workflowGroups.values()).map(
      (group) => ({
        id: group.id,
        name: group.name,
        description: group.description,
        category: group.category,
        priority: group.priority,
        complexity: group.complexity,
        requiresUserInput: group.requiresUserInput,
        nodeCount: group.nodeIds.size,
        isPrimary: group.id === session.state.activeWorkflowId,
      })
    );

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            status: "success",
            message: "Workflow discovery completed successfully",
            workflowCount: workflowGroups.size,
            primaryWorkflowId: session.state.activeWorkflowId,
            workflows: workflowSummary,
            stats: {
              totalUrls: session.harData.urls.length,
              totalRequests: session.harData.requests.length,
            },
            nextSteps: [
              "Use analysis_process_next_node to process discovered workflows",
              "Use debug tools to inspect specific workflow details",
              "Use codegen_generate_wrapper_script when analysis is complete",
            ],
          }),
        },
      ],
    };
  } catch (error) {
    if (error instanceof HarvestError) {
      throw error;
    }

    throw new HarvestError(
      `Workflow discovery failed: ${error instanceof Error ? error.message : "Unknown error"}`,
      "WORKFLOW_DISCOVERY_FAILED",
      {
        sessionId: params.sessionId,
        originalError: error,
      }
    );
  }
}

// Helper functions that were used in the original handlers

function selectUrlHeuristically(urls: URLInfo[]): string {
  // Simple heuristic: prioritize POST requests, then by URL complexity
  const postUrls = urls.filter((url) => url.method === "POST");
  if (postUrls.length > 0) {
    return postUrls[0]?.url || "";
  }

  // If no POST, take the first non-GET with query params
  const nonGetWithParams = urls.filter(
    (url) => url.method !== "GET" && url.url.includes("?")
  );
  if (nonGetWithParams.length > 0) {
    return nonGetWithParams[0]?.url || "";
  }

  // Fallback to first URL
  return urls[0]?.url || "";
}

function checkNoNodesToProcess(session: HarvestSession): CallToolResult | null {
  if (session.state.toBeProcessedNodes.length === 0) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            status: "no_nodes_to_process",
            message: "No nodes available for processing",
            nextStep: "Use 'analysis_is_complete' to check session status",
          }),
        },
      ],
    };
  }
  return null;
}

function extractNextNodeForProcessing(
  session: HarvestSession,
  sessionId: string,
  context: AnalysisToolContext
): { nodeId: string; curlCommand: string } {
  const nodeId = session.state.toBeProcessedNodes.shift();
  if (!nodeId) {
    throw new HarvestError("No nodes to process", "ANALYSIS_ERROR");
  }
  const node = session.dagManager.getNode(nodeId);

  if (!node) {
    throw new HarvestError(`Node ${nodeId} not found in DAG`, "NODE_NOT_FOUND");
  }

  const requestContent = node.content as {
    key: { toCurlCommand(): string; method: string; url: string };
  };
  const curlCommand = requestContent.key.toCurlCommand();

  context.sessionManager.addLog(
    sessionId,
    "info",
    `Processing node ${nodeId}: ${requestContent.key.method} ${requestContent.key.url}`
  );

  return { nodeId, curlCommand };
}

function handleJavaScriptFileSkip(
  curlCommand: string,
  nodeId: string,
  _session: HarvestSession,
  sessionId: string,
  context: AnalysisToolContext
): CallToolResult | null {
  // Note: This is a simplified check - the actual function expects a RequestModel
  // but we're doing a simple string check here for the extracted curl command
  if (
    curlCommand.includes(".js") ||
    curlCommand.includes(".html") ||
    curlCommand.includes(".css")
  ) {
    context.sessionManager.addLog(
      sessionId,
      "info",
      `Skipping JavaScript/HTML node ${nodeId}`
    );

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            status: "skipped_javascript",
            nodeId,
            message: "Skipped JavaScript/HTML file processing",
            nextStep: "Continue with next node or check completion status",
          }),
        },
      ],
    };
  }
  return null;
}

async function processDynamicPartsAndInputVariables(
  curlCommand: string,
  session: HarvestSession,
  sessionId: string,
  nodeId: string,
  context: AnalysisToolContext
): Promise<{
  dynamicParts: string[];
  finalDynamicParts: string[];
  identifiedInputVars: Record<string, string>;
  classifiedParameters: ClassifiedParameter[];
}> {
  const dynamicParts = await identifyDynamicParts(curlCommand);

  context.sessionManager.addLog(
    sessionId,
    "info",
    `Found ${dynamicParts.length} dynamic parts for node ${nodeId}`
  );

  // Convert dynamic parts array to the expected Record format
  const dynamicPartsRecord: Record<string, string> = {};
  dynamicParts.forEach((part, index) => {
    dynamicPartsRecord[`dynamic_${index}`] = part;
  });

  const inputVarsResult = await identifyInputVariables(
    curlCommand,
    dynamicPartsRecord
  );
  const identifiedInputVars = inputVarsResult.identifiedVariables;
  const finalDynamicParts = inputVarsResult.removedDynamicParts;

  // For classifyParameters, we need the actual RequestModel, not the curl command
  // Get the original request from the node
  const node = session.dagManager.getNode(nodeId);
  const requestContent = node?.content as {
    key?: { toCurlCommand(): string; method: string; url: string };
  };
  const requestModel = requestContent?.key;
  const classifiedParameters = requestModel
    ? await classifyParameters(requestModel as never, session)
    : [];

  return {
    dynamicParts,
    finalDynamicParts,
    identifiedInputVars,
    classifiedParameters,
  };
}

async function processDependenciesAndAddNodes(
  finalDynamicParts: string[],
  nodeId: string,
  session: HarvestSession,
  _sessionId: string,
  _context: AnalysisToolContext
): Promise<number> {
  let newNodesAdded = 0;

  if (finalDynamicParts.length > 0) {
    const dependencies = await findDependencies(
      finalDynamicParts,
      session.harData,
      session.cookieData || {}
    );

    // Add cookie dependencies
    for (const cookieDep of dependencies.cookieDependencies) {
      const cookieNodeId = session.dagManager.addNode("cookie", {
        key: cookieDep.cookieKey,
        value: session.cookieData?.[cookieDep.cookieKey]?.value || "",
      });
      session.dagManager.addEdge(cookieNodeId, nodeId);
      newNodesAdded++;
    }

    // Add request dependencies
    for (const reqDep of dependencies.requestDependencies) {
      const depNodeId = session.dagManager.addNode("curl", {
        key: reqDep.sourceRequest,
      });
      session.dagManager.addEdge(depNodeId, nodeId);
      session.state.toBeProcessedNodes.push(depNodeId);
      newNodesAdded++;
    }

    // Handle not found parts
    for (const notFoundPart of dependencies.notFoundParts) {
      const notFoundNodeId = session.dagManager.addNode("not_found", {
        key: notFoundPart,
      });
      session.dagManager.addEdge(notFoundNodeId, nodeId);
      newNodesAdded++;
    }
  }

  return newNodesAdded;
}

function generateNodeProcessingResponse(
  nodeId: string,
  dynamicParts: string[],
  identifiedInputVars: Record<string, string>,
  finalDynamicParts: string[],
  newNodesAdded: number,
  session: HarvestSession,
  sessionId: string,
  context: AnalysisToolContext
): CallToolResult {
  const remainingNodes = session.state.toBeProcessedNodes.length;
  const totalNodes = session.dagManager.getNodeCount();

  const nextStep =
    remainingNodes > 0
      ? "Continue with 'analysis_process_next_node'"
      : "Use 'analysis_is_complete' to check if ready for code generation";

  context.sessionManager.addLog(
    sessionId,
    "info",
    `Node ${nodeId} processing complete. ${newNodesAdded} new nodes added, ${remainingNodes} nodes remaining`
  );

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          status: "completed",
          nodeId,
          dynamicPartsFound: dynamicParts.length,
          inputVariablesFound: Object.keys(identifiedInputVars).length,
          finalDynamicParts: finalDynamicParts.length,
          newNodesAdded,
          remainingNodes,
          totalNodes,
          nextStep,
          message: `Node processing completed successfully. ${newNodesAdded} dependencies added.`,
        }),
      },
    ],
  };
}

function handleNodeProcessingError(error: unknown): CallToolResult {
  if (error instanceof HarvestError) {
    throw error;
  }

  throw new HarvestError(
    `Node processing failed: ${error instanceof Error ? error.message : "Unknown error"}`,
    "NODE_PROCESSING_FAILED",
    { originalError: error }
  );
}

/**
 * Register analysis tools with the MCP server
 */
export function registerAnalysisTools(
  server: McpServer,
  context: AnalysisToolContext
): void {
  server.tool(
    "analysis_run_initial_analysis",
    "Identify the target action URL and create the master node in the dependency graph. Configure API keys using CLI arguments: --provider and --api-key.",
    {
      sessionId: SessionIdSchema.shape.sessionId,
    },
    async (params) => handleRunInitialAnalysisWithConfig(params, context)
  );

  server.tool(
    "analysis_process_next_node",
    "Process the next unresolved node in the dependency graph using dynamic parts and dependency analysis. This iteratively resolves dependencies and builds the complete API workflow.",
    {
      sessionId: z
        .string()
        .uuid()
        .describe(
          "UUID of the session containing nodes to process. The session must have been initialized with analysis_run_initial_analysis."
        ),
    },
    async (params) => handleProcessNextNode(params, context)
  );

  server.tool(
    "analysis_is_complete",
    "Check if the analysis workflow is complete by verifying all nodes are resolved. Returns true when ready for code generation.",
    {
      sessionId: z
        .string()
        .uuid()
        .describe(
          "UUID of the session to check completion status. Use this to determine if analysis_process_next_node needs to be called again."
        ),
    },
    async (params) => handleIsComplete(params, context)
  );

  server.tool(
    "analysis_discover_workflows",
    "Discover and analyze multiple workflow groups from HAR data instead of single URL identification. This replaces the single-master-action model with comprehensive multi-workflow analysis.",
    {
      sessionId: z
        .string()
        .uuid()
        .describe(
          "UUID of the session to analyze for workflow discovery. The session must have been initialized with session_start and contain HAR data."
        ),
    },
    async (params) => handleDiscoverWorkflows(params, context)
  );
}
