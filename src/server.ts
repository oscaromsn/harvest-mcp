#!/usr/bin/env bun

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  findDependencies,
  isJavaScriptOrHtml,
} from "./agents/DependencyAgent.js";
import { identifyDynamicParts } from "./agents/DynamicPartsAgent.js";
import { identifyInputVariables } from "./agents/InputVariablesAgent.js";
import { identifyEndUrl } from "./agents/URLIdentificationAgent.js";
import { generateWrapperScript } from "./core/CodeGenerator.js";
import { manualSessionManager } from "./core/ManualSessionManager.js";
import { SessionManager } from "./core/SessionManager.js";
import {
  type CookieDependency,
  HarvestError,
  type ManualSessionStartParams,
  ManualSessionStartSchema,
  type ManualSessionStopParams,
  ManualSessionStopSchema,
  type RequestDependency,
  type SessionConfig,
  SessionIdSchema,
  SessionStartSchema,
} from "./types/index.js";

/**
 * Harvest MCP Server
 *
 * A Model Context Protocol server that provides granular access to Harvest's
 * API Analysis capabilities through stateful sessions.
 */

export class HarvestMCPServer {
  public server: McpServer;
  public sessionManager: SessionManager;

  constructor() {
    this.sessionManager = new SessionManager();

    this.server = new McpServer(
      {
        name: "harvest-mcp-server",
        version: "1.0.0",
        description:
          "Set of tools to analyzse web interactions and generate integration code with granular control and debugging capabilities for agentic engineering",
      },
      {
        capabilities: {
          tools: {
            listChanged: true,
          },
          resources: {
            subscribe: true,
            listChanged: true,
          },
          prompts: {
            listChanged: true,
          },
        },
      }
    );

    this.setupTools();
    this.setupResources();
    this.setupPrompts();
    this.setupErrorHandling();
  }

  /**
   * Set up MCP tools
   */
  private setupTools(): void {
    // Session Management Tools
    this.server.tool(
      "session_start",
      "Initialize a new Harvest analysis session with HAR file and prompt",
      SessionStartSchema.shape,
      async (params): Promise<CallToolResult> => {
        return await this.handleSessionStart(params);
      }
    );

    this.server.tool(
      "session_list",
      "List all active analysis sessions with their status",
      {},
      async (): Promise<CallToolResult> => {
        return await this.handleSessionList();
      }
    );

    this.server.tool(
      "session_delete",
      "Delete an analysis session and free its resources",
      SessionIdSchema.shape,
      async (params): Promise<CallToolResult> => {
        return await this.handleSessionDelete(params);
      }
    );

    // Analysis Tools
    this.server.tool(
      "analysis_run_initial_analysis",
      "Identify the target action URL and create the master node in the dependency graph",
      SessionIdSchema.shape,
      async (params): Promise<CallToolResult> => {
        return await this.handleRunInitialAnalysis(params);
      }
    );

    this.server.tool(
      "analysis_process_next_node",
      "Process the next unresolved node in the dependency graph using dynamic parts and dependency analysis",
      SessionIdSchema.shape,
      async (params): Promise<CallToolResult> => {
        return await this.handleProcessNextNode(params);
      }
    );

    this.server.tool(
      "analysis_is_complete",
      "Check if the analysis workflow is complete by verifying all nodes are resolved",
      SessionIdSchema.shape,
      async (params): Promise<CallToolResult> => {
        return await this.handleIsComplete(params);
      }
    );

    // Debug Tools
    this.server.tool(
      "debug_get_unresolved_nodes",
      "Get a list of all nodes in the dependency graph that still have unresolved dynamic parts",
      SessionIdSchema.shape,
      async (params): Promise<CallToolResult> => {
        return await this.handleGetUnresolvedNodes(params);
      }
    );

    this.server.tool(
      "debug_get_node_details",
      "Get detailed information about a specific node in the dependency graph",
      SessionIdSchema.extend({ nodeId: z.string().uuid() }).shape,
      async (params): Promise<CallToolResult> => {
        return await this.handleGetNodeDetails(params);
      }
    );

    this.server.tool(
      "debug_list_all_requests",
      "Get the filtered list of all requests from the HAR file available for analysis",
      SessionIdSchema.shape,
      async (params): Promise<CallToolResult> => {
        return await this.handleListAllRequests(params);
      }
    );

    this.server.tool(
      "debug_force_dependency",
      "Manually create a dependency link between two nodes in the DAG to override automatic analysis",
      SessionIdSchema.extend({
        consumerNodeId: z.string().uuid(),
        providerNodeId: z.string().uuid(),
        providedPart: z.string(),
      }).shape,
      async (params): Promise<CallToolResult> => {
        return await this.handleForceDependency(params);
      }
    );

    // Code Generation Tools
    this.server.tool(
      "codegen_generate_wrapper_script",
      "Generate a complete TypeScript wrapper script from the completed dependency analysis",
      SessionIdSchema.shape,
      async (params): Promise<CallToolResult> => {
        return await this.handleGenerateWrapperScript(params);
      }
    );

    // Manual Session Tools
    this.server.tool(
      "session_start_manual",
      "Start a manual browser session for interactive exploration with automatic artifact collection",
      ManualSessionStartSchema.shape,
      async (params): Promise<CallToolResult> => {
        return await this.handleStartManualSession(params);
      }
    );

    this.server.tool(
      "session_stop_manual",
      "Stop a manual browser session and collect all artifacts (HAR files, cookies, screenshots)",
      ManualSessionStopSchema.shape,
      async (params): Promise<CallToolResult> => {
        return await this.handleStopManualSession(params);
      }
    );

    this.server.tool(
      "session_list_manual",
      "List all active manual browser sessions with their current status",
      {},
      async (): Promise<CallToolResult> => {
        return await this.handleListManualSessions();
      }
    );
  }

  /**
   * Set up MCP resources for session state inspection
   */
  private setupResources(): void {
    // Session DAG resource
    this.server.resource(
      "harvest://{sessionId}/dag.json",
      "Real-time JSON representation of the dependency graph for a session",
      (_uri, args) => {
        const sessionId = args?.sessionId as string;
        if (!sessionId) {
          throw new HarvestError(
            "Session ID is required",
            "MISSING_SESSION_ID"
          );
        }

        const session = this.sessionManager.getSession(sessionId);
        const dagData = session.dagManager.toJSON();

        return {
          contents: [
            {
              uri: `harvest://${sessionId}/dag.json`,
              text: JSON.stringify(dagData, null, 2),
              mimeType: "application/json",
            },
          ],
        };
      }
    );

    // Session logs resource
    this.server.resource(
      "harvest://{sessionId}/log.txt",
      "Plain-text log of analysis steps performed for a session",
      async (_uri, args) => {
        const sessionId = args?.sessionId as string;
        if (!sessionId) {
          throw new HarvestError(
            "Session ID is required",
            "MISSING_SESSION_ID"
          );
        }

        const session = this.sessionManager.getSession(sessionId);
        const logText = session.state.logs
          .map(
            (log) =>
              `[${log.timestamp.toISOString()}] ${log.level.toUpperCase()}: ${log.message}`
          )
          .join("\n");

        return {
          contents: [
            {
              uri: `harvest://${sessionId}/log.txt`,
              text: logText || "No logs available for this session",
              mimeType: "text/plain",
            },
          ],
        };
      }
    );

    // Session status resource
    this.server.resource(
      "harvest://{sessionId}/status.json",
      "Current analysis status and progress for a session",
      (_uri, args) => {
        const sessionId = args?.sessionId as string;
        if (!sessionId) {
          throw new HarvestError(
            "Session ID is required",
            "MISSING_SESSION_ID"
          );
        }

        const session = this.sessionManager.getSession(sessionId);
        const isComplete = session.dagManager.isComplete();
        const unresolvedNodes = session.dagManager.getUnresolvedNodes();

        const statusData = {
          sessionId,
          isComplete,
          nodesRemaining: session.state.toBeProcessedNodes.length,
          totalNodes: session.dagManager.getNodeCount(),
          unresolvedNodes: unresolvedNodes.length,
          createdAt: session.createdAt.toISOString(),
          lastActivity: session.lastActivity.toISOString(),
          prompt: session.prompt,
          hasHARData: session.harData.requests.length > 0,
          hasCookieData: Object.keys(session.cookieData || {}).length > 0,
          inputVariables: session.state.inputVariables,
          logs: session.state.logs.length,
        };

        return {
          contents: [
            {
              uri: `harvest://${sessionId}/status.json`,
              text: JSON.stringify(statusData, null, 2),
              mimeType: "application/json",
            },
          ],
        };
      }
    );

    // Generated code resource
    this.server.resource(
      "harvest://{sessionId}/generated_code.ts",
      "Generated TypeScript wrapper script for the completed analysis",
      (_uri, args) => {
        const sessionId = args?.sessionId as string;
        if (!sessionId) {
          throw new HarvestError(
            "Session ID is required",
            "MISSING_SESSION_ID"
          );
        }

        const session = this.sessionManager.getSession(sessionId);

        // Check if code has been generated
        if (!session.state.generatedCode) {
          throw new HarvestError(
            "Generated code not available. Run codegen.generate_wrapper_script first.",
            "CODE_NOT_GENERATED",
            { sessionId }
          );
        }

        return {
          contents: [
            {
              uri: `harvest://${sessionId}/generated_code.ts`,
              text: session.state.generatedCode,
              mimeType: "text/typescript",
            },
          ],
        };
      }
    );
  }

  /**
   * Set up MCP prompts for user convenience
   */
  private setupPrompts(): void {
    // One-shot automated analysis prompt
    this.server.prompt(
      "harvest_full_run",
      "Run a complete Harvest analysis and generate a wrapper script",
      {
        har_path: z
          .string()
          .describe("Path to the HAR file containing network traffic"),
        cookie_path: z
          .string()
          .optional()
          .describe("Path to the cookie file (optional)"),
        prompt: z
          .string()
          .describe(
            "Description of the action to analyze and generate code for"
          ),
        input_variables: z
          .string()
          .optional()
          .describe("Optional input variables as JSON string"),
      },
      async (request) => {
        return await this.executeFullAnalysisWorkflow(request);
      }
    );
  }

  /**
   * Set up error handling
   */
  private setupErrorHandling(): void {
    this.server.server.onerror = (error) => {
      console.error("[MCP Server Error]", error);
    };

    // Handle graceful shutdown
    process.on("SIGINT", () => {
      console.log("Shutting down Harvest MCP server...");
      this.sessionManager.clearAllSessions();
      process.exit(0);
    });

    process.on("SIGTERM", () => {
      console.log("Shutting down Harvest MCP server...");
      this.sessionManager.clearAllSessions();
      process.exit(0);
    });
  }

  /**
   * Handle session.start tool
   */
  public async handleSessionStart(args: unknown): Promise<CallToolResult> {
    try {
      const validatedArgs = SessionStartSchema.parse(args);
      const sessionId = await this.sessionManager.createSession(validatedArgs);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              sessionId,
              message: "Session created successfully",
              harPath: validatedArgs.harPath,
              prompt: validatedArgs.prompt,
            }),
          },
        ],
      };
    } catch (error) {
      throw new HarvestError(
        `Failed to create session: ${error instanceof Error ? error.message : "Unknown error"}`,
        "SESSION_CREATE_ERROR"
      );
    }
  }

  /**
   * Handle session.list tool
   */
  public handleSessionList(): CallToolResult {
    try {
      const sessions = this.sessionManager.listSessions();
      const stats = this.sessionManager.getStats();

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                sessions,
                stats,
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (error) {
      throw new HarvestError(
        `Failed to list sessions: ${error instanceof Error ? error.message : "Unknown error"}`,
        "SESSION_LIST_ERROR"
      );
    }
  }

  /**
   * Handle session.delete tool
   */
  public handleSessionDelete(args: unknown): CallToolResult {
    try {
      const argsObj = args as { sessionId: string };
      const deleted = this.sessionManager.deleteSession(argsObj.sessionId);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              success: deleted,
              sessionId: argsObj.sessionId,
              message: deleted
                ? "Session deleted successfully"
                : "Session not found",
            }),
          },
        ],
      };
    } catch (error) {
      throw new HarvestError(
        `Failed to delete session: ${error instanceof Error ? error.message : "Unknown error"}`,
        "SESSION_DELETE_ERROR"
      );
    }
  }

  /**
   * Handle analysis.process_next_node tool
   */
  public async handleProcessNextNode(args: unknown): Promise<CallToolResult> {
    try {
      const argsObj = args as { sessionId: string };
      const session = this.sessionManager.getSession(argsObj.sessionId);

      // Check if there are nodes available for processing
      const noNodesResult = this.checkNoNodesToProcess(session);
      if (noNodesResult) {
        return noNodesResult;
      }

      // Extract and validate the next node
      const { nodeId, curlCommand } = this.extractNextNodeForProcessing(
        session,
        argsObj.sessionId
      );

      // Handle JavaScript file skipping
      const jsSkipResult = this.handleJavaScriptFileSkip(
        curlCommand,
        nodeId,
        session,
        argsObj.sessionId
      );
      if (jsSkipResult) {
        return jsSkipResult;
      }

      // Process dynamic parts and input variables
      const { dynamicParts, finalDynamicParts, identifiedInputVars } =
        await this.processDynamicPartsAndInputVariables(
          curlCommand,
          session,
          argsObj.sessionId
        );

      // Update node with processed information
      session.dagManager.updateNode(nodeId, {
        dynamicParts: finalDynamicParts,
        inputVariables: identifiedInputVars,
      });

      // Process dependencies and add new nodes
      const newNodesAdded = await this.processDependenciesAndAddNodes(
        finalDynamicParts,
        nodeId,
        session,
        argsObj.sessionId
      );

      // Generate final response
      return this.generateNodeProcessingResponse(
        nodeId,
        dynamicParts,
        identifiedInputVars,
        finalDynamicParts,
        newNodesAdded,
        session,
        argsObj.sessionId
      );
    } catch (error) {
      return this.handleNodeProcessingError(error);
    }
  }

  /**
   * Handle analysis.is_complete tool
   */
  public async handleIsComplete(args: unknown): Promise<CallToolResult> {
    try {
      const argsObj = args as { sessionId: string };
      const session = this.sessionManager.getSession(argsObj.sessionId);

      // Check completion status
      const isComplete = session.dagManager.isComplete();
      const nodeCount = session.dagManager.getNodeCount();
      const unresolvedNodes = session.dagManager.getUnresolvedNodes();
      const remainingToProcess = session.state.toBeProcessedNodes.length;

      // Determine next steps
      let nextStep = "";
      let status = "";

      if (isComplete && remainingToProcess === 0) {
        status = "complete";
        nextStep =
          "Analysis is complete. Use codegen.generate_wrapper_script to generate integration code.";
      } else if (remainingToProcess > 0) {
        status = "processing";
        nextStep = `Continue with analysis.process_next_node to process ${remainingToProcess} remaining nodes.`;
      } else if (unresolvedNodes.length > 0) {
        status = "needs_intervention";
        nextStep =
          "Some dynamic parts remain unresolved. Use debug tools for manual intervention.";
      } else {
        status = "unknown";
        nextStep = "Analysis state is unclear. Check session logs for details.";
      }

      // Log the completion check
      this.sessionManager.addLog(
        argsObj.sessionId,
        "info",
        `Completion check: ${status} - ${unresolvedNodes.length} unresolved nodes, ${remainingToProcess} nodes to process`
      );

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              isComplete,
              status,
              nodeCount,
              unresolvedNodesCount: unresolvedNodes.length,
              unresolvedNodes: unresolvedNodes.map((node) => ({
                nodeId: node.nodeId,
                unresolvedParts: node.unresolvedParts,
                nodeType: session.dagManager.getNode(node.nodeId)?.nodeType,
              })),
              remainingToProcess,
              nextStep,
              message:
                status === "complete"
                  ? "Analysis workflow completed successfully"
                  : `Analysis is ${status} - see nextStep for guidance`,
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
   * Handle analysis.run_initial_analysis tool
   */
  public async handleRunInitialAnalysis(
    args: unknown
  ): Promise<CallToolResult> {
    try {
      const argsObj = args as { sessionId: string };
      const session = this.sessionManager.getSession(argsObj.sessionId);

      // Log the start of initial analysis
      this.sessionManager.addLog(
        argsObj.sessionId,
        "info",
        "Starting initial analysis - identifying action URL"
      );

      // Use URLIdentificationAgent to identify the target URL
      const actionUrl = await identifyEndUrl(session, session.harData.urls);

      // Find the corresponding request in HAR data
      const targetRequest = session.harData.requests.find(
        (req) => req.url === actionUrl
      );
      if (!targetRequest) {
        throw new HarvestError(
          `No request found for identified URL: ${actionUrl}`,
          "TARGET_REQUEST_NOT_FOUND",
          {
            actionUrl,
            availableUrls: session.harData.requests.map((r) => r.url),
          }
        );
      }

      // Create master node in DAG
      const masterNodeId = session.dagManager.addNode(
        "master_curl",
        {
          key: targetRequest,
          value: targetRequest.response || null,
        },
        {
          dynamicParts: ["None"], // Will be updated in next step
          extractedParts: ["None"],
        }
      );

      // Update session state
      session.state.actionUrl = actionUrl;
      session.state.masterNodeId = masterNodeId;
      session.state.toBeProcessedNodes.push(masterNodeId);

      this.sessionManager.addLog(
        argsObj.sessionId,
        "info",
        `Initial analysis complete - identified URL: ${actionUrl}, created master node: ${masterNodeId}`
      );

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              masterNodeId,
              actionUrl,
              message: "Initial analysis completed successfully",
              nodeCount: session.dagManager.getNodeCount(),
              nextStep:
                "Use analysis.process_next_node to begin dependency analysis",
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
   * Check if there are nodes available for processing
   */
  private checkNoNodesToProcess(
    session: ReturnType<typeof this.sessionManager.getSession>
  ): CallToolResult | null {
    if (session.state.toBeProcessedNodes.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              status: "no_nodes_to_process",
              message: "No nodes available for processing",
              isComplete: session.dagManager.isComplete(),
              totalNodes: session.dagManager.getNodeCount(),
            }),
          },
        ],
      };
    }
    return null;
  }

  /**
   * Extract and validate the next node for processing
   */
  private extractNextNodeForProcessing(
    session: ReturnType<typeof this.sessionManager.getSession>,
    sessionId: string
  ): {
    nodeId: string;
    curlCommand: string;
  } {
    const nodeId = session.state.toBeProcessedNodes.shift();
    if (nodeId === undefined) {
      throw new HarvestError(
        "No nodes available for processing",
        "NO_NODES_TO_PROCESS",
        {
          sessionId,
        }
      );
    }

    const node = session.dagManager.getNode(nodeId);
    if (!node) {
      throw new HarvestError(
        `Node ${nodeId} not found in DAG`,
        "NODE_NOT_FOUND",
        { nodeId }
      );
    }

    this.sessionManager.addLog(sessionId, "info", `Processing node ${nodeId}`);

    // Validate node type and extract request
    if (
      node.nodeType !== "curl" &&
      node.nodeType !== "master_curl" &&
      node.nodeType !== "master"
    ) {
      throw new Error(
        `Cannot process node ${nodeId}: expected request node type, got ${node.nodeType}`
      );
    }

    const request = node.content.key;
    const curlCommand = request.toCurlCommand();

    return { nodeId, curlCommand };
  }

  /**
   * Handle JavaScript file skipping logic
   */
  private handleJavaScriptFileSkip(
    curlCommand: string,
    nodeId: string,
    session: ReturnType<typeof this.sessionManager.getSession>,
    sessionId: string
  ): CallToolResult | null {
    if (curlCommand.endsWith(".js'")) {
      session.dagManager.updateNode(nodeId, { dynamicParts: [] });
      this.sessionManager.addLog(
        sessionId,
        "info",
        `Skipped JavaScript file: ${nodeId}`
      );

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              nodeId,
              status: "skipped_javascript",
              message: "Skipped JavaScript file",
              remainingNodes: session.state.toBeProcessedNodes.length,
              nextStep:
                session.state.toBeProcessedNodes.length > 0
                  ? "Continue with analysis.process_next_node"
                  : "Analysis may be complete",
            }),
          },
        ],
      };
    }
    return null;
  }

  /**
   * Process dynamic parts and input variables
   */
  private async processDynamicPartsAndInputVariables(
    curlCommand: string,
    session: ReturnType<typeof this.sessionManager.getSession>,
    sessionId: string
  ): Promise<{
    dynamicParts: string[];
    finalDynamicParts: string[];
    identifiedInputVars: Record<string, string>;
  }> {
    // Step 1: Identify dynamic parts
    const dynamicParts = await identifyDynamicParts(
      curlCommand,
      session.state.inputVariables || {}
    );

    this.sessionManager.addLog(
      sessionId,
      "info",
      `Identified ${dynamicParts.length} dynamic parts: ${dynamicParts.join(", ")}`
    );

    // Step 2: Check for input variables in the dynamic parts
    let finalDynamicParts = dynamicParts;
    let identifiedInputVars: Record<string, string> = {};

    if (
      session.state.inputVariables &&
      Object.keys(session.state.inputVariables).length > 0
    ) {
      const inputVarResult = await identifyInputVariables(
        curlCommand,
        session.state.inputVariables,
        dynamicParts
      );

      identifiedInputVars = inputVarResult.identifiedVariables;
      finalDynamicParts = inputVarResult.removedDynamicParts;

      if (Object.keys(identifiedInputVars).length > 0) {
        this.sessionManager.addLog(
          sessionId,
          "info",
          `Identified input variables: ${Object.keys(identifiedInputVars).join(", ")}`
        );
      }
    }

    return { dynamicParts, finalDynamicParts, identifiedInputVars };
  }

  /**
   * Process dependencies and add new nodes to the DAG
   */
  private async processDependenciesAndAddNodes(
    finalDynamicParts: string[],
    nodeId: string,
    session: ReturnType<typeof this.sessionManager.getSession>,
    sessionId: string
  ): Promise<number> {
    let newNodesAdded = 0;

    if (finalDynamicParts.length === 0) {
      return newNodesAdded;
    }

    const dependencies = await findDependencies(
      finalDynamicParts,
      session.harData,
      session.cookieData || {}
    );

    this.sessionManager.addLog(
      sessionId,
      "info",
      `Found ${dependencies.cookieDependencies.length} cookie deps, ${dependencies.requestDependencies.length} request deps, ${dependencies.notFoundParts.length} unresolved`
    );

    // Add cookie dependencies
    newNodesAdded += this.addCookieDependencies(
      dependencies.cookieDependencies,
      nodeId,
      session
    );

    // Add request dependencies
    newNodesAdded += await this.addRequestDependencies(
      dependencies.requestDependencies,
      nodeId,
      finalDynamicParts,
      session,
      sessionId
    );

    // Add "not found" nodes for unresolved parts
    newNodesAdded += this.addNotFoundNodes(
      dependencies.notFoundParts,
      nodeId,
      session
    );

    // Check for cycles after adding dependencies
    this.validateNoCycles(session, sessionId);

    return newNodesAdded;
  }

  /**
   * Add cookie dependencies to the DAG
   */
  private addCookieDependencies(
    cookieDependencies: CookieDependency[],
    nodeId: string,
    session: ReturnType<typeof this.sessionManager.getSession>
  ): number {
    let addedCount = 0;

    for (const cookieDep of cookieDependencies) {
      const cookieNodeId = session.dagManager.addNode(
        "cookie",
        {
          key: cookieDep.cookieKey,
          value: cookieDep.dynamicPart,
        },
        {
          extractedParts: [cookieDep.dynamicPart],
        }
      );

      session.dagManager.addEdge(nodeId, cookieNodeId);
      addedCount++;
    }

    return addedCount;
  }

  /**
   * Add request dependencies to the DAG
   */
  private async addRequestDependencies(
    requestDependencies: RequestDependency[],
    nodeId: string,
    finalDynamicParts: string[],
    session: ReturnType<typeof this.sessionManager.getSession>,
    sessionId: string
  ): Promise<number> {
    let addedCount = 0;

    for (const reqDep of requestDependencies) {
      // Check if this request is already in the DAG
      let depNodeId = session.dagManager.findNodeByRequest(
        reqDep.sourceRequest
      );

      if (depNodeId) {
        // Update existing node's extracted parts
        const existingNode = session.dagManager.getNode(depNodeId);
        if (!existingNode) {
          throw new HarvestError(
            `Existing dependency node ${depNodeId} not found`,
            "DEPENDENCY_NODE_NOT_FOUND",
            { depNodeId, sessionId }
          );
        }
        const currentExtracted = existingNode.extractedParts || [];
        if (!currentExtracted.includes(reqDep.dynamicPart)) {
          session.dagManager.updateNode(depNodeId, {
            extractedParts: [...currentExtracted, reqDep.dynamicPart],
          });
        }
      } else {
        // Skip JavaScript files and HTML responses
        if (isJavaScriptOrHtml(reqDep.sourceRequest)) {
          // Remove this dynamic part from the current node
          const updatedParts = finalDynamicParts.filter(
            (part) => part !== reqDep.dynamicPart
          );
          session.dagManager.updateNode(nodeId, { dynamicParts: updatedParts });
          continue;
        }

        depNodeId = session.dagManager.addNode(
          "curl",
          {
            key: reqDep.sourceRequest,
            value: reqDep.sourceRequest.response || null,
          },
          {
            extractedParts: [reqDep.dynamicPart],
          }
        );

        // Add to processing queue
        session.state.toBeProcessedNodes.push(depNodeId);
        addedCount++;
      }

      session.dagManager.addEdge(nodeId, depNodeId);
    }

    return addedCount;
  }

  /**
   * Add "not found" nodes for unresolved parts
   */
  private addNotFoundNodes(
    notFoundParts: string[],
    nodeId: string,
    session: ReturnType<typeof this.sessionManager.getSession>
  ): number {
    let addedCount = 0;

    for (const notFoundPart of notFoundParts) {
      const notFoundNodeId = session.dagManager.addNode("not_found", {
        key: notFoundPart,
      });

      session.dagManager.addEdge(nodeId, notFoundNodeId);
      addedCount++;
    }

    return addedCount;
  }

  /**
   * Validate that no cycles exist in the DAG
   */
  private validateNoCycles(
    session: ReturnType<typeof this.sessionManager.getSession>,
    sessionId: string
  ): void {
    const cycles = session.dagManager.detectCycles();
    if (cycles) {
      this.sessionManager.addLog(
        sessionId,
        "error",
        `Cycles detected in dependency graph: ${cycles.join(", ")}`
      );

      throw new HarvestError(
        "Circular dependencies detected in the analysis graph",
        "CIRCULAR_DEPENDENCIES",
        { cycles }
      );
    }
  }

  /**
   * Generate the final response for node processing
   */
  private generateNodeProcessingResponse(
    nodeId: string,
    dynamicParts: string[],
    identifiedInputVars: Record<string, string>,
    finalDynamicParts: string[],
    newNodesAdded: number,
    session: ReturnType<typeof this.sessionManager.getSession>,
    sessionId: string
  ): CallToolResult {
    const remainingNodes = session.state.toBeProcessedNodes.length;
    const nextStep =
      remainingNodes > 0
        ? "Continue with analysis.process_next_node to process remaining nodes"
        : "Use analysis.is_complete to check if analysis is finished";

    this.sessionManager.addLog(
      sessionId,
      "info",
      `Completed processing node ${nodeId}. Added ${newNodesAdded} new nodes. ${remainingNodes} nodes remaining.`
    );

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            nodeId,
            status: "completed",
            dynamicPartsFound: dynamicParts.length,
            inputVariablesFound: Object.keys(identifiedInputVars).length,
            finalDynamicParts: finalDynamicParts.length,
            newNodesAdded,
            remainingNodes,
            totalNodes: session.dagManager.getNodeCount(),
            nextStep,
          }),
        },
      ],
    };
  }

  /**
   * Handle errors in node processing
   */
  private handleNodeProcessingError(error: unknown): never {
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
   * Handle debug_get_unresolved_nodes tool call
   */
  public async handleGetUnresolvedNodes(
    args: unknown
  ): Promise<CallToolResult> {
    try {
      const argsObj = args as { sessionId: string };
      const session = this.sessionManager.getSession(argsObj.sessionId);

      const unresolvedNodes = session.dagManager.getUnresolvedNodes();

      this.sessionManager.addLog(
        argsObj.sessionId,
        "info",
        `Retrieved ${unresolvedNodes.length} unresolved nodes for debugging`
      );

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              unresolvedNodes: unresolvedNodes.map((node) => ({
                nodeId: node.nodeId,
                unresolvedParts: node.unresolvedParts,
                nodeType: session.dagManager.getNode(node.nodeId)?.nodeType,
                content: (() => {
                  const dagNode = session.dagManager.getNode(node.nodeId);
                  if (
                    dagNode &&
                    (dagNode.nodeType === "curl" ||
                      dagNode.nodeType === "master_curl" ||
                      dagNode.nodeType === "master")
                  ) {
                    return dagNode.content.key.url || "Unknown";
                  }
                  return "Unknown";
                })(),
              })),
              totalUnresolved: unresolvedNodes.length,
              message:
                unresolvedNodes.length > 0
                  ? "These nodes require manual intervention or additional analysis"
                  : "All nodes have been resolved successfully",
            }),
          },
        ],
      };
    } catch (error) {
      if (error instanceof HarvestError) {
        throw error;
      }

      throw new HarvestError(
        `Failed to get unresolved nodes: ${error instanceof Error ? error.message : "Unknown error"}`,
        "GET_UNRESOLVED_NODES_FAILED",
        { originalError: error }
      );
    }
  }

  /**
   * Handle debug_get_node_details tool call
   */
  public async handleGetNodeDetails(args: unknown): Promise<CallToolResult> {
    try {
      const argsObj = args as { sessionId: string; nodeId: string };
      const session = this.sessionManager.getSession(argsObj.sessionId);

      const node = session.dagManager.getNode(argsObj.nodeId);
      if (!node) {
        throw new HarvestError(
          `Node ${argsObj.nodeId} not found in DAG`,
          "NODE_NOT_FOUND",
          {
            nodeId: argsObj.nodeId,
          }
        );
      }

      this.sessionManager.addLog(
        argsObj.sessionId,
        "info",
        `Retrieved detailed information for node ${argsObj.nodeId}`
      );

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              nodeId: argsObj.nodeId,
              nodeType: node.nodeType,
              content: (() => {
                if (
                  node.nodeType === "curl" ||
                  node.nodeType === "master_curl" ||
                  node.nodeType === "master"
                ) {
                  return {
                    url: node.content.key.url || "N/A",
                    method: node.content.key.method || "N/A",
                    headers: Object.keys(node.content.key.headers || {}).length,
                    bodySize: node.content.key.body
                      ? JSON.stringify(node.content.key.body).length
                      : 0,
                  };
                }
                if (node.nodeType === "cookie") {
                  return {
                    cookieKey: node.content.key,
                    cookieValue: node.content.value,
                  };
                }
                if (node.nodeType === "not_found") {
                  return {
                    missingPart: node.content.key,
                  };
                }
                // This should never happen with the current types, but handle it gracefully
                const unknownNode = node as { nodeType?: string };
                return {
                  type: "unknown",
                  nodeType: unknownNode.nodeType || "unknown",
                };
              })(),
              dynamicParts: node.dynamicParts || [],
              extractedParts: node.extractedParts || [],
              inputVariables: node.inputVariables || {},
              dependencies: {
                incoming: session.dagManager
                  .toJSON()
                  .edges.filter((e) => e.to === argsObj.nodeId).length,
                outgoing: session.dagManager
                  .toJSON()
                  .edges.filter((e) => e.from === argsObj.nodeId).length,
              },
              timestamp: (() => {
                if (
                  node.nodeType === "curl" ||
                  node.nodeType === "master_curl" ||
                  node.nodeType === "master"
                ) {
                  return node.content.key.timestamp?.toISOString() || "Unknown";
                }
                return "N/A";
              })(),
            }),
          },
        ],
      };
    } catch (error) {
      if (error instanceof HarvestError) {
        throw error;
      }

      throw new HarvestError(
        `Failed to get node details: ${error instanceof Error ? error.message : "Unknown error"}`,
        "GET_NODE_DETAILS_FAILED",
        { originalError: error }
      );
    }
  }

  /**
   * Handle debug_list_all_requests tool call
   */
  public async handleListAllRequests(args: unknown): Promise<CallToolResult> {
    try {
      const argsObj = args as { sessionId: string };
      const session = this.sessionManager.getSession(argsObj.sessionId);

      const requests = session.harData.requests.map((req, index) => ({
        index,
        method: req.method,
        url: req.url,
        responsePreview: req.response?.text?.substring(0, 100) || "No response",
        hasResponse: !!req.response,
        contentType: Array.isArray(req.response?.headers)
          ? req.response.headers.find(
              (h) => h.name?.toLowerCase() === "content-type"
            )?.value || "Unknown"
          : "Unknown",
        statusCode: req.response?.status || 0,
        timestamp: req.timestamp || "Unknown",
      }));

      this.sessionManager.addLog(
        argsObj.sessionId,
        "info",
        `Listed ${requests.length} requests from HAR file for manual analysis`
      );

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              requests,
              totalRequests: requests.length,
              summary: {
                getMethods: requests.filter((r) => r.method === "GET").length,
                postMethods: requests.filter((r) => r.method === "POST").length,
                otherMethods: requests.filter(
                  (r) => !["GET", "POST"].includes(r.method)
                ).length,
                withResponses: requests.filter((r) => r.hasResponse).length,
              },
              message:
                "Use this list to manually identify dependencies if automatic analysis fails",
            }),
          },
        ],
      };
    } catch (error) {
      if (error instanceof HarvestError) {
        throw error;
      }

      throw new HarvestError(
        `Failed to list requests: ${error instanceof Error ? error.message : "Unknown error"}`,
        "LIST_REQUESTS_FAILED",
        { originalError: error }
      );
    }
  }

  /**
   * Handle debug_force_dependency tool call
   */
  public async handleForceDependency(args: unknown): Promise<CallToolResult> {
    try {
      const argsObj = args as {
        sessionId: string;
        consumerNodeId: string;
        providerNodeId: string;
        providedPart: string;
      };
      const session = this.sessionManager.getSession(argsObj.sessionId);

      // Validate that both nodes exist
      const consumerNode = session.dagManager.getNode(argsObj.consumerNodeId);
      const providerNode = session.dagManager.getNode(argsObj.providerNodeId);

      if (!consumerNode) {
        throw new HarvestError(
          `Consumer node ${argsObj.consumerNodeId} not found in DAG`,
          "NODE_NOT_FOUND",
          { nodeId: argsObj.consumerNodeId }
        );
      }

      if (!providerNode) {
        throw new HarvestError(
          `Provider node ${argsObj.providerNodeId} not found in DAG`,
          "NODE_NOT_FOUND",
          { nodeId: argsObj.providerNodeId }
        );
      }

      // Check if the consumer node actually needs this part
      const consumerDynamicParts = consumerNode.dynamicParts || [];
      if (!consumerDynamicParts.includes(argsObj.providedPart)) {
        this.sessionManager.addLog(
          argsObj.sessionId,
          "warn",
          `Consumer node ${argsObj.consumerNodeId} does not have '${argsObj.providedPart}' as an unresolved dynamic part`
        );
      }

      // Add the edge in the DAG
      session.dagManager.addEdge(
        argsObj.consumerNodeId,
        argsObj.providerNodeId
      );

      // Update consumer node to remove the resolved part
      const updatedConsumerParts = consumerDynamicParts.filter(
        (part) => part !== argsObj.providedPart
      );
      session.dagManager.updateNode(argsObj.consumerNodeId, {
        dynamicParts: updatedConsumerParts,
      });

      // Update provider node to add the extracted part
      const currentExtracted = providerNode.extractedParts || [];
      if (!currentExtracted.includes(argsObj.providedPart)) {
        session.dagManager.updateNode(argsObj.providerNodeId, {
          extractedParts: [...currentExtracted, argsObj.providedPart],
        });
      }

      // Check for cycles after adding the dependency
      const cycles = session.dagManager.detectCycles();
      if (cycles) {
        // Rollback the changes
        session.dagManager.updateNode(argsObj.consumerNodeId, {
          dynamicParts: consumerDynamicParts,
        });
        session.dagManager.updateNode(argsObj.providerNodeId, {
          extractedParts: currentExtracted,
        });

        throw new HarvestError(
          "Manual dependency would create circular dependencies in the graph",
          "CIRCULAR_DEPENDENCIES",
          { cycles }
        );
      }

      this.sessionManager.addLog(
        argsObj.sessionId,
        "info",
        `Manually created dependency: ${argsObj.consumerNodeId} -> ${argsObj.providerNodeId} (provides: ${argsObj.providedPart})`
      );

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              success: true,
              message: "Dependency successfully created between nodes",
              consumerNodeId: argsObj.consumerNodeId,
              providerNodeId: argsObj.providerNodeId,
              providedPart: argsObj.providedPart,
              consumerRemainingParts: updatedConsumerParts,
              totalEdges: session.dagManager.toJSON().edges.length,
              nextStep:
                updatedConsumerParts.length > 0
                  ? "Consumer node still has unresolved parts"
                  : "Consumer node is now fully resolved",
            }),
          },
        ],
      };
    } catch (error) {
      if (error instanceof HarvestError) {
        throw error;
      }

      throw new HarvestError(
        `Failed to force dependency: ${error instanceof Error ? error.message : "Unknown error"}`,
        "FORCE_DEPENDENCY_FAILED",
        { originalError: error }
      );
    }
  }

  /**
   * Handle codegen.generate_wrapper_script tool call
   */
  public async handleGenerateWrapperScript(
    args: unknown
  ): Promise<CallToolResult> {
    try {
      const argsObj = args as { sessionId: string };
      const session = this.sessionManager.getSession(argsObj.sessionId);

      // Validate that analysis is complete
      if (!session.state.isComplete || !session.dagManager.isComplete()) {
        const unresolvedNodes = session.dagManager.getUnresolvedNodes();
        throw new HarvestError(
          `Cannot generate code - analysis not complete. ${unresolvedNodes.length} nodes have unresolved dependencies`,
          "ANALYSIS_INCOMPLETE",
          {
            unresolvedNodes: unresolvedNodes.map((n) => ({
              nodeId: n.nodeId,
              unresolvedParts: n.unresolvedParts,
            })),
          }
        );
      }

      this.sessionManager.addLog(
        argsObj.sessionId,
        "info",
        "Starting code generation for completed analysis"
      );

      // Generate the wrapper script
      const generatedCode = generateWrapperScript(session);

      // Store the generated code in session state for resource access
      session.state.generatedCode = generatedCode;

      this.sessionManager.addLog(
        argsObj.sessionId,
        "info",
        `Code generation completed successfully - ${generatedCode.length} characters generated`
      );

      return {
        content: [
          {
            type: "text",
            text: generatedCode,
          },
        ],
      };
    } catch (error) {
      if (error instanceof HarvestError) {
        throw error;
      }

      // Handle cycle detection errors specifically
      if (
        error instanceof Error &&
        error.message.includes("Graph contains cycles")
      ) {
        throw new HarvestError(error.message, "GRAPH_CONTAINS_CYCLES", {
          originalError: error,
        });
      }

      throw new HarvestError(
        `Code generation failed: ${error instanceof Error ? error.message : "Unknown error"}`,
        "CODE_GENERATION_FAILED",
        { originalError: error }
      );
    }
  }

  /**
   * Handle session_start_manual tool call
   */
  public async handleStartManualSession(
    args: unknown
  ): Promise<CallToolResult> {
    try {
      const argsObj = args as ManualSessionStartParams;

      // Start the manual session
      const sessionInfo = await manualSessionManager.startSession(
        (argsObj.config as SessionConfig) ?? {}
      );

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              success: true,
              sessionId: sessionInfo.id,
              startTime: sessionInfo.startTime,
              currentUrl: sessionInfo.currentUrl,
              pageTitle: sessionInfo.pageTitle,
              outputDir: sessionInfo.outputDir,
              message: "Manual browser session started successfully",
              instructions: sessionInfo.instructions,
              artifactConfig: sessionInfo.artifactConfig,
            }),
          },
        ],
      };
    } catch (error) {
      throw new HarvestError(
        `Failed to start manual session: ${error instanceof Error ? error.message : "Unknown error"}`,
        "MANUAL_SESSION_START_FAILED",
        { originalError: error }
      );
    }
  }

  /**
   * Handle session_stop_manual tool call
   */
  public async handleStopManualSession(args: unknown): Promise<CallToolResult> {
    try {
      const argsObj = args as ManualSessionStopParams;

      // Stop the manual session and collect artifacts
      const result = await manualSessionManager.stopSession(argsObj.sessionId, {
        ...(argsObj.artifactTypes && { artifactTypes: argsObj.artifactTypes }),
        ...(argsObj.takeScreenshot !== undefined && {
          takeScreenshot: argsObj.takeScreenshot,
        }),
        reason: argsObj.reason ?? "manual_stop",
      });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              success: true,
              sessionId: result.id,
              duration: result.duration,
              finalUrl: result.finalUrl,
              finalPageTitle: result.finalPageTitle,
              artifactsCollected: result.artifacts.length,
              artifacts: result.artifacts.map((artifact) => ({
                type: artifact.type,
                path: artifact.path,
                size: artifact.size,
                timestamp: artifact.timestamp,
              })),
              summary: result.summary,
              metadata: result.metadata,
              message: "Manual browser session stopped and artifacts collected",
            }),
          },
        ],
      };
    } catch (error) {
      throw new HarvestError(
        `Failed to stop manual session: ${error instanceof Error ? error.message : "Unknown error"}`,
        "MANUAL_SESSION_STOP_FAILED",
        { originalError: error }
      );
    }
  }

  /**
   * Handle session_list_manual tool call
   */
  public async handleListManualSessions(): Promise<CallToolResult> {
    try {
      const activeSessions = manualSessionManager.listActiveSessions();

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              success: true,
              activeSessions: activeSessions.length,
              sessions: activeSessions.map((session) => ({
                id: session.id,
                startTime: session.startTime,
                currentUrl: session.currentUrl,
                pageTitle: session.pageTitle,
                duration: session.duration,
                outputDir: session.outputDir,
                artifactConfig: session.artifactConfig,
              })),
              message:
                activeSessions.length > 0
                  ? `Found ${activeSessions.length} active manual session(s)`
                  : "No active manual sessions",
            }),
          },
        ],
      };
    } catch (error) {
      throw new HarvestError(
        `Failed to list manual sessions: ${error instanceof Error ? error.message : "Unknown error"}`,
        "MANUAL_SESSION_LIST_FAILED",
        { originalError: error }
      );
    }
  }

  /**
   * Execute full analysis workflow for the prompt
   */
  private async executeFullAnalysisWorkflow(request: {
    har_path: string;
    cookie_path?: string | undefined;
    prompt: string;
    input_variables?: string | undefined;
  }): Promise<{
    messages: Array<{
      role: "user" | "assistant";
      content: {
        type: "text";
        text: string;
      };
    }>;
  }> {
    const { har_path, cookie_path, prompt, input_variables } = request;

    try {
      // Step 1: Create session
      const sessionId = await this.createAnalysisSession({
        har_path,
        cookie_path,
        prompt,
        input_variables,
      });

      const analysisResults = [];
      analysisResults.push(`✅ Session created: ${sessionId}`);

      // Step 2: Run initial analysis
      await this.runInitialAnalysisStep(sessionId, analysisResults);

      // Step 3: Process nodes iteratively
      await this.runIterativeNodeProcessing(sessionId, analysisResults);

      // Step 4: Generate code or handle incomplete analysis
      return await this.generateFinalCodeOrHandleIncomplete(
        sessionId,
        analysisResults
      );
    } catch (error) {
      return this.handleWorkflowError(error);
    }
  }

  /**
   * Create analysis session from request parameters
   */
  private async createAnalysisSession(params: {
    har_path: string;
    cookie_path?: string | undefined;
    prompt: string;
    input_variables?: string | undefined;
  }): Promise<string> {
    const sessionResult = await this.handleSessionStart({
      harPath: params.har_path,
      cookiePath: params.cookie_path,
      prompt: params.prompt,
      inputVariables: params.input_variables
        ? JSON.parse(params.input_variables as string)
        : undefined,
    });

    const sessionContent = sessionResult.content?.[0]?.text;
    if (typeof sessionContent !== "string") {
      throw new Error("Invalid session result format");
    }
    const sessionData = JSON.parse(sessionContent);
    return sessionData.sessionId;
  }

  /**
   * Run initial analysis step
   */
  private async runInitialAnalysisStep(
    sessionId: string,
    analysisResults: string[]
  ): Promise<boolean> {
    try {
      const initialResult = await this.handleRunInitialAnalysis({ sessionId });
      const initialContent = initialResult.content?.[0]?.text;
      if (typeof initialContent !== "string") {
        throw new Error("Invalid initial analysis result format");
      }
      const initialData = JSON.parse(initialContent);
      analysisResults.push(
        `✅ Initial analysis complete - Action URL: ${initialData.actionUrl}`
      );
      return true;
    } catch (error) {
      analysisResults.push(
        `⚠️ Initial analysis failed: ${error instanceof Error ? error.message : "Unknown error"}`
      );
      analysisResults.push("📋 Proceeding with manual session setup...");
      return false;
    }
  }

  /**
   * Run iterative node processing
   */
  private async runIterativeNodeProcessing(
    sessionId: string,
    analysisResults: string[]
  ): Promise<boolean> {
    let iterations = 0;
    const maxIterations = 20;
    let isComplete = false;

    while (!isComplete && iterations < maxIterations) {
      try {
        // Check completion status first
        isComplete = await this.checkAnalysisComplete(sessionId);

        if (isComplete) {
          analysisResults.push(
            `✅ Analysis completed after ${iterations} iterations`
          );
          break;
        }

        // Process next node
        const nodeProcessed = await this.processNextNodeInWorkflow(sessionId);
        if (!nodeProcessed) {
          analysisResults.push(
            "⚠️ No more nodes to process - analysis may be incomplete"
          );
          break;
        }

        analysisResults.push(
          `🔄 Iteration ${iterations + 1}: Processed node successfully`
        );
        iterations++;
      } catch (error) {
        analysisResults.push(
          `❌ Error in iteration ${iterations + 1}: ${
            error instanceof Error ? error.message : "Unknown error"
          }`
        );
        break;
      }
    }

    if (iterations >= maxIterations) {
      analysisResults.push(
        `⚠️ Analysis stopped after ${maxIterations} iterations - may need manual intervention`
      );
    }

    return isComplete;
  }

  /**
   * Check if analysis is complete
   */
  private async checkAnalysisComplete(sessionId: string): Promise<boolean> {
    const completeResult = await this.handleIsComplete({ sessionId });
    const completeContent = completeResult.content?.[0]?.text;
    if (typeof completeContent !== "string") {
      throw new Error("Invalid completion result format");
    }
    const completeData = JSON.parse(completeContent);
    return completeData.isComplete;
  }

  /**
   * Process next node in workflow
   */
  private async processNextNodeInWorkflow(sessionId: string): Promise<boolean> {
    const processResult = await this.handleProcessNextNode({ sessionId });
    const processContent = processResult.content?.[0]?.text;
    if (typeof processContent !== "string") {
      throw new Error("Invalid process result format");
    }
    const processData = JSON.parse(processContent);

    return processData.status !== "no_nodes_to_process";
  }

  /**
   * Generate final code or handle incomplete analysis
   */
  private async generateFinalCodeOrHandleIncomplete(
    sessionId: string,
    analysisResults: string[]
  ): Promise<{
    messages: Array<{
      role: "user" | "assistant";
      content: {
        type: "text";
        text: string;
      };
    }>;
  }> {
    try {
      const codeResult = await this.handleGenerateWrapperScript({ sessionId });
      const codeContent = codeResult.content?.[0]?.text;
      if (typeof codeContent !== "string") {
        throw new Error("Invalid code generation result format");
      }
      const generatedCode = codeContent;

      analysisResults.push(
        `✅ Code generation successful - ${generatedCode.length} characters generated`
      );

      return {
        messages: [
          {
            role: "assistant",
            content: {
              type: "text",
              text: `# Harvest Complete Analysis Results\n\n## Workflow Summary\n${analysisResults.join(
                "\n"
              )}\n\n## Generated TypeScript Code\n\n\`\`\`typescript\n${generatedCode}\n\`\`\``,
            },
          },
        ],
      };
    } catch (codeError) {
      return await this.handleIncompleteAnalysis(
        sessionId,
        analysisResults,
        codeError
      );
    }
  }

  /**
   * Handle incomplete analysis with debug information
   */
  private async handleIncompleteAnalysis(
    sessionId: string,
    analysisResults: string[],
    codeError: unknown
  ): Promise<{
    messages: Array<{
      role: "user" | "assistant";
      content: {
        type: "text";
        text: string;
      };
    }>;
  }> {
    analysisResults.push(
      `❌ Code generation failed: ${codeError instanceof Error ? codeError.message : "Unknown error"}`
    );

    // Attempt debug information
    try {
      const unresolvedResult = await this.handleGetUnresolvedNodes({
        sessionId,
      });
      const unresolvedContent = unresolvedResult.content?.[0]?.text;
      if (typeof unresolvedContent !== "string") {
        throw new Error("Invalid unresolved result format");
      }
      const unresolvedData = JSON.parse(unresolvedContent);

      if (unresolvedData.totalUnresolved > 0) {
        analysisResults.push("\n## Debug Information");
        analysisResults.push(
          `🔍 ${unresolvedData.totalUnresolved} unresolved nodes found:`
        );
        unresolvedData.unresolvedNodes.forEach(
          (
            node: { nodeId: string; unresolvedParts: string[] },
            index: number
          ) => {
            analysisResults.push(
              `  ${index + 1}. Node ${node.nodeId}: ${node.unresolvedParts.join(", ")}`
            );
          }
        );
        analysisResults.push("\n💡 Use debug tools for manual intervention");
      }
    } catch (_debugError) {
      analysisResults.push("⚠️ Could not retrieve debug information");
    }

    return {
      messages: [
        {
          role: "assistant",
          content: {
            type: "text",
            text: `# Harvest Analysis Results (Incomplete)\n\n## Workflow Summary\n${analysisResults.join(
              "\n"
            )}\n\n❌ **Analysis could not be completed automatically.**\n\nUse the session ID \`${sessionId}\` with debug tools for manual intervention.`,
          },
        },
      ],
    };
  }

  /**
   * Handle workflow error
   */
  private handleWorkflowError(error: unknown): {
    messages: Array<{
      role: "user" | "assistant";
      content: {
        type: "text";
        text: string;
      };
    }>;
  } {
    return {
      messages: [
        {
          role: "assistant",
          content: {
            type: "text",
            text: `# Harvest Analysis Failed\n\n❌ **Error**: ${
              error instanceof Error ? error.message : "Unknown error"
            }\n\nPlease check your HAR file path and try again.`,
          },
        },
      ],
    };
  }

  /**
   * Start the server
   */
  async start(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);

    console.error("Harvest MCP Server started and listening on stdio");
  }
}

// Start the server
const server = new HarvestMCPServer();
server.start().catch((error) => {
  console.error("Failed to start server:", error);
  process.exit(1);
});
