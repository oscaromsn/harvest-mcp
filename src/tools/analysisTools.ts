import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

/**
 * Extract URL from temporary masterNodeId format (e.g., "GET:https://example.com/api")
 */
function extractUrlFromMasterNodeId(masterNodeId: string): string | null {
  if (masterNodeId.includes(":")) {
    return masterNodeId.split(":", 2)[1] || null;
  }
  return masterNodeId;
}

import {
  discoverWorkflows,
  getPrimaryWorkflow,
} from "../agents/WorkflowDiscoveryAgent.js";
import {
  type AnalysisToolContext,
  HarvestError,
  SessionIdSchema,
} from "../types/index.js";
import { createComponentLogger } from "../utils/logger.js";

const logger = createComponentLogger("analysis-tools");

/**
 * Handle analysis.process_next_node tool using FSM events
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

    // Check FSM state to ensure we can process nodes
    const currentState = context.sessionManager.getFsmState(params.sessionId);

    if (currentState === "readyForCodeGen") {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              status: "already_complete",
              message:
                "Analysis is already complete - no more nodes to process",
              nextStep:
                "Use 'codegen_generate_wrapper_script' to generate code",
              currentState,
            }),
          },
        ],
      };
    }

    if (currentState === "failed") {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              status: "session_failed",
              message: "Session has failed - cannot process nodes",
              suggestion: "Create a new session with session_start",
              currentState,
            }),
          },
        ],
      };
    }

    if (currentState !== "processingDependencies") {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              status: "invalid_state",
              message: `Session is not in the correct state for node processing (current: ${currentState})`,
              suggestion:
                currentState === "awaitingWorkflowSelection"
                  ? "Use 'analysis_start_primary_workflow' first"
                  : "Check session status and restart if needed",
              currentState,
            }),
          },
        ],
      };
    }

    // Send PROCESS_NEXT_NODE event to the FSM
    try {
      context.sessionManager.sendFsmEvent(params.sessionId, {
        type: "PROCESS_NEXT_NODE",
      });

      // Give the FSM a moment to process the event
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Check the new state and provide appropriate response using FSM context
      const newState = context.sessionManager.getFsmState(params.sessionId);
      const updatedFsmContext = context.sessionManager.getFsmContext(
        params.sessionId
      );

      if (newState === "readyForCodeGen") {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                status: "analysis_complete",
                message:
                  "All nodes processed successfully - analysis is now complete",
                totalNodes: updatedFsmContext.dagManager.getNodeCount(),
                nextStep:
                  "Use 'codegen_generate_wrapper_script' to generate code",
                currentState: newState,
              }),
            },
          ],
        };
      }
      if (newState === "processingDependencies") {
        const remainingNodes = updatedFsmContext.toBeProcessedNodes.length;
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                status: "node_processed",
                message: "Node processed successfully - more nodes remaining",
                remainingNodes,
                totalNodes: updatedFsmContext.dagManager.getNodeCount(),
                nextStep:
                  remainingNodes > 0
                    ? "Continue with 'analysis_process_next_node'"
                    : "Use 'analysis_is_complete' to check status",
                currentState: newState,
              }),
            },
          ],
        };
      }
      if (newState === "failed") {
        const contextData = updatedFsmContext;
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                status: "processing_failed",
                message: "Node processing failed",
                error:
                  contextData.error?.message ||
                  "Unknown error during processing",
                suggestion: "Check logs and consider restarting the session",
                currentState: newState,
              }),
            },
          ],
        };
      }

      // Default response for unexpected states
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              status: "unexpected_state",
              message: `Node processing resulted in unexpected state: ${newState}`,
              currentState: newState,
              suggestion: "Check session status with analysis_is_complete",
            }),
          },
        ],
      };
    } catch (fsmError) {
      logger.error("FSM event processing failed", {
        sessionId: params.sessionId,
        error: fsmError instanceof Error ? fsmError.message : "Unknown error",
      });

      // Return error instead of falling back to legacy processing
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              status: "fsm_processing_failed",
              message: "FSM event processing failed",
              error:
                fsmError instanceof Error ? fsmError.message : "Unknown error",
              suggestion:
                "Check session state and consider restarting the session",
            }),
          },
        ],
      };
    }
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

    // Debug: Log completion analysis details
    logger.debug("Completion analysis", {
      sessionId: params.sessionId,
      isComplete: analysis.isComplete,
      blockers: analysis.blockers,
      blockersCount: analysis.blockers.length,
      pendingInQueue: analysis.diagnostics.pendingInQueue,
      unresolvedNodes: analysis.diagnostics.unresolvedNodes,
      queueEmpty: analysis.diagnostics.queueEmpty,
      dagComplete: analysis.diagnostics.dagComplete,
    });

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
        "Use 'analysis_start_primary_workflow' to identify the target action URL",
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
                "Consider using 'analysis_start_primary_workflow' for simpler workflow discovery",
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

    // Update FSM context with discovered workflows
    const fsmContext = context.sessionManager.getFsmContext(params.sessionId);
    fsmContext.workflowGroups = workflowGroups;

    // Debug: Log discovered workflows
    for (const [id, workflow] of workflowGroups.entries()) {
      context.sessionManager.addLog(
        params.sessionId,
        "debug",
        `Discovered workflow: ${id} - ${workflow.name} - Primary endpoint: ${extractUrlFromMasterNodeId(workflow.masterNodeId)}`
      );
    }

    // Select primary workflow if none specified
    const primaryWorkflow = getPrimaryWorkflow(workflowGroups);
    if (primaryWorkflow) {
      fsmContext.activeWorkflowId = primaryWorkflow.id;

      // Create the initial DAG node for the primary workflow
      const primaryUrl = extractUrlFromMasterNodeId(
        primaryWorkflow.masterNodeId
      );
      if (primaryUrl) {
        // Find the matching request from HAR data
        const urlWithoutQuery = primaryUrl.split("?")[0];
        const matchingRequest = session.harData.requests.find((req) => {
          if (!req.url) {
            return false;
          }
          const reqUrlWithoutQuery = req.url.split("?")[0];
          return reqUrlWithoutQuery === urlWithoutQuery;
        });

        if (matchingRequest) {
          // Create DAG node for the primary endpoint
          const masterNodeId = session.dagManager.addNode("master_curl", {
            key: matchingRequest,
            value: matchingRequest.response || null,
          });

          // Add to processing queue for dependency analysis
          if (!fsmContext.toBeProcessedNodes.includes(masterNodeId)) {
            fsmContext.toBeProcessedNodes.push(masterNodeId);
          }

          // Update the workflow group with the actual DAG node ID
          primaryWorkflow.masterNodeId = masterNodeId;

          context.sessionManager.addLog(
            params.sessionId,
            "info",
            `Created master DAG node ${masterNodeId} for primary workflow: ${primaryWorkflow.name} - Endpoint: ${primaryUrl}`
          );
        } else {
          context.sessionManager.addLog(
            params.sessionId,
            "warn",
            `Could not find matching request for primary endpoint: ${primaryUrl}`
          );
        }
      }

      context.sessionManager.addLog(
        params.sessionId,
        "info",
        `Selected primary workflow: ${primaryWorkflow.name} (${primaryWorkflow.id}) - Primary endpoint: ${extractUrlFromMasterNodeId(primaryWorkflow.masterNodeId)}`
      );
    } else {
      context.sessionManager.addLog(
        params.sessionId,
        "warn",
        `No primary workflow found from ${workflowGroups.size} discovered workflows`
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
        isPrimary: group.id === fsmContext.activeWorkflowId,
      })
    );

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            success: true,
            status: "success",
            message: "Workflow discovery completed successfully",
            workflowCount: workflowGroups.size,
            primaryWorkflowId: fsmContext.activeWorkflowId,
            actionUrl: primaryWorkflow
              ? extractUrlFromMasterNodeId(primaryWorkflow.masterNodeId)
              : null,
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
 * Handle starting primary workflow analysis using FSM events
 */
export async function handleStartPrimaryWorkflow(
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

    // Check current FSM state to ensure we can start workflow analysis
    const currentState = context.sessionManager.getFsmState(params.sessionId);
    if (!currentState || currentState === "failed") {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              error: "Session is not in a valid state for workflow analysis",
              currentState,
              message: "Session may have failed during initialization",
              suggestion: "Create a new session with session_start",
            }),
          },
        ],
      };
    }

    // Check if FSM is already past workflow selection
    if (
      currentState === "processingDependencies" ||
      currentState === "readyForCodeGen"
    ) {
      const fsmContext = context.sessionManager.getFsmContext(params.sessionId);
      const activeWorkflowId = fsmContext.activeWorkflowId;
      const workflow = activeWorkflowId
        ? fsmContext.workflowGroups.get(activeWorkflowId)
        : undefined;

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              success: true,
              message: "Primary workflow analysis already started",
              currentState,
              workflow: workflow
                ? {
                    id: workflow.id,
                    name: workflow.name,
                    description: workflow.description,
                  }
                : undefined,
              actionUrl: workflow?.masterNodeId
                ? extractUrlFromMasterNodeId(workflow.masterNodeId)
                : undefined,
              nextSteps:
                currentState === "processingDependencies"
                  ? [
                      "Use 'analysis_process_next_node' to continue dependency analysis",
                    ]
                  : ["Use 'codegen_generate_wrapper_script' to generate code"],
            }),
          },
        ],
      };
    }

    // For FSM-managed sessions, workflow discovery should happen automatically
    // We just need to wait for the FSM to complete workflow selection
    if (currentState === "awaitingWorkflowSelection") {
      // FSM should auto-select primary workflow - wait a moment and check again
      await new Promise((resolve) => setTimeout(resolve, 100));
      const newState = context.sessionManager.getFsmState(params.sessionId);

      if (newState === "processingDependencies") {
        const fsmContext = context.sessionManager.getFsmContext(
          params.sessionId
        );
        const activeWorkflow = fsmContext.activeWorkflowId
          ? fsmContext.workflowGroups.get(fsmContext.activeWorkflowId)
          : undefined;

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: true,
                message:
                  "Primary workflow analysis started successfully via FSM",
                currentState: newState,
                workflow: activeWorkflow
                  ? {
                      id: activeWorkflow.id,
                      name: activeWorkflow.name,
                      description: activeWorkflow.description,
                      category: activeWorkflow.category,
                      priority: activeWorkflow.priority,
                      complexity: activeWorkflow.complexity,
                    }
                  : undefined,
                actionUrl: activeWorkflow?.masterNodeId
                  ? extractUrlFromMasterNodeId(activeWorkflow.masterNodeId)
                  : undefined,
                nextSteps: [
                  "Use 'analysis_process_next_node' to continue dependency analysis",
                  "Use 'analysis_is_complete' to check progress",
                ],
              }),
            },
          ],
        };
      }
    }

    // Check HAR data quality before proceeding with manual workflow discovery
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
                suggestion:
                  "Ensure your HAR file contains API network requests",
              }),
            },
          ],
        };
      }

      if (validation.quality === "poor") {
        logger.warn("Proceeding with poor quality HAR file", {
          sessionId: params.sessionId,
          quality: validation.quality,
          issues: validation.issues,
        });
      }
    }

    // For sessions not managed by FSM, fall back to legacy workflow discovery
    // This will be removed in a future phase
    logger.warn("Using legacy workflow discovery - session not FSM-managed", {
      sessionId: params.sessionId,
      currentState,
    });

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            error: "Session state inconsistency",
            message:
              "Session is not in the expected state for FSM-managed workflow analysis",
            currentState,
            suggestion:
              "Create a new session with session_start to use the modern FSM-based workflow system",
            fallback:
              "The FSM should automatically handle workflow discovery and selection",
          }),
        },
      ],
    };
  } catch (error) {
    if (error instanceof HarvestError) {
      throw error;
    }

    throw new HarvestError(
      `Primary workflow analysis failed: ${error instanceof Error ? error.message : "Unknown error"}`,
      "PRIMARY_WORKFLOW_ANALYSIS_FAILED",
      { originalError: error }
    );
  }
}

/**
 * Register analysis tools with the MCP server
 */
export function registerAnalysisTools(
  server: McpServer,
  context: AnalysisToolContext
): void {
  server.tool(
    "analysis_start_primary_workflow",
    "Discover all workflows in the HAR file and automatically start analysis of the highest-priority workflow. This is the recommended way to begin analysis using the modern multi-workflow system. Configure API keys using CLI arguments: --provider and --api-key.",
    {
      sessionId: SessionIdSchema.shape.sessionId,
    },
    async (params) => handleStartPrimaryWorkflow(params, context)
  );

  server.tool(
    "analysis_process_next_node",
    "Process the next unresolved node in the dependency graph using dynamic parts and dependency analysis. This iteratively resolves dependencies and builds the complete API workflow.",
    {
      sessionId: z
        .string()
        .uuid()
        .describe(
          "UUID of the session containing nodes to process. The session must have been initialized with analysis_start_primary_workflow."
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
