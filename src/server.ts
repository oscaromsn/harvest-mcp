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
import { parseHARFile } from "./core/HARParser.js";
import { createLLMClientWithConfig } from "./core/LLMClient.js";
import { manualSessionManager } from "./core/ManualSessionManager.js";
import { validateConfiguration } from "./core/providers/ProviderFactory.js";
import { SessionManager } from "./core/SessionManager.js";
import {
  type BrowserSessionInfo,
  type CleanupResult,
  type CookieDependency,
  type HarValidationResult,
  HarvestError,
  ManualSessionStartSchema,
  ManualSessionStopSchema,
  type RequestDependency,
  type SessionConfig,
  SessionIdSchema,
  type SessionStartResponse,
  SessionStartSchema,
  type URLInfo,
} from "./types/index.js";
import { serverLogger } from "./utils/logger.js";

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

    // Validate LLM configuration at startup
    this.validateEnvironmentOnStartup();

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
   * Validate environment configuration at startup and log warnings
   */
  private validateEnvironmentOnStartup(): void {
    const config = validateConfiguration();

    if (config.isConfigured) {
      serverLogger.info(
        {
          configuredProviders: config.configuredProviders,
          warnings: config.warnings,
        },
        "LLM provider configuration validated"
      );

      // Log any warnings about configuration
      for (const warning of config.warnings) {
        serverLogger.warn(warning);
      }
    } else {
      serverLogger.warn(
        {
          availableProviders: config.availableProviders,
          configuredProviders: config.configuredProviders,
        },
        "LLM provider not configured - AI-powered analysis features will be unavailable"
      );

      // Log setup instructions
      config.recommendations.forEach((rec, index) => {
        serverLogger.info(`Setup step ${index + 1}: ${rec}`);
      });
    }
  }

  /**
   * Set up MCP tools
   */
  private setupTools(): void {
    // Session Management Tools
    this.server.tool(
      "session_start",
      "Initialize a new Harvest analysis session with HAR file and prompt. Creates a session that can be used for step-by-step API analysis and code generation.",
      {
        harPath: z
          .string()
          .min(1)
          .describe(
            "Absolute path to the HAR file to analyze. HAR files contain recorded HTTP requests and responses from browser network traffic."
          ),
        cookiePath: z
          .string()
          .optional()
          .describe(
            "Optional path to cookie file in Netscape format. Used for authentication state in generated code."
          ),
        prompt: z
          .string()
          .min(1)
          .describe(
            "Description of what the analysis should accomplish. This guides the AI analysis and code generation process. Example: 'Generate code to search for legal precedents'"
          ),
      },
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
      "Delete an analysis session and free its resources. Use this to clean up completed or unwanted sessions.",
      {
        sessionId: z
          .string()
          .uuid()
          .describe(
            "UUID of the session to delete. Use session_list to see available sessions."
          ),
      },
      async (params): Promise<CallToolResult> => {
        return await this.handleSessionDelete(params);
      }
    );

    // Analysis Tools
    this.server.tool(
      "analysis_run_initial_analysis",
      "Identify the target action URL and create the master node in the dependency graph. Supports API key parameters for client-side LLM configuration.",
      {
        sessionId: SessionIdSchema.shape.sessionId,
        // Client-side API key support
        openaiApiKey: z
          .string()
          .optional()
          .describe(
            "OpenAI API key for client-side LLM configuration (overrides environment variable)"
          ),
        googleApiKey: z
          .string()
          .optional()
          .describe(
            "Google API key for client-side LLM configuration (overrides environment variable)"
          ),
        provider: z
          .string()
          .optional()
          .describe(
            "LLM provider to use: 'openai' or 'gemini' (overrides environment variable)"
          ),
        model: z
          .string()
          .optional()
          .describe("LLM model to use (overrides environment variable)"),
      },
      async (params): Promise<CallToolResult> => {
        return await this.handleRunInitialAnalysisWithApiKeys(params);
      }
    );

    this.server.tool(
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
      async (params): Promise<CallToolResult> => {
        return await this.handleProcessNextNode(params);
      }
    );

    this.server.tool(
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
      async (params): Promise<CallToolResult> => {
        return await this.handleIsComplete(params);
      }
    );

    // Debug Tools
    this.server.tool(
      "debug_get_unresolved_nodes",
      "Get a list of all nodes in the dependency graph that still have unresolved dynamic parts. Useful for debugging analysis issues.",
      {
        sessionId: z
          .string()
          .uuid()
          .describe(
            "UUID of the session to inspect. Shows which nodes still need processing and why analysis isn't complete."
          ),
      },
      async (params): Promise<CallToolResult> => {
        return await this.handleGetUnresolvedNodes(params);
      }
    );

    this.server.tool(
      "debug_get_node_details",
      "Get detailed information about a specific node in the dependency graph. Shows request details, dependencies, and processing status.",
      {
        sessionId: z
          .string()
          .uuid()
          .describe("UUID of the session containing the node to inspect."),
        nodeId: z
          .string()
          .uuid()
          .describe(
            "UUID of the specific node to examine. Use debug_get_unresolved_nodes to find node IDs."
          ),
      },
      async (params): Promise<CallToolResult> => {
        return await this.handleGetNodeDetails(params);
      }
    );

    this.server.tool(
      "debug_list_all_requests",
      "Get the filtered list of all requests from the HAR file available for analysis. Shows URLs, methods, and basic metadata.",
      {
        sessionId: z
          .string()
          .uuid()
          .describe(
            "UUID of the session to inspect. Lists all HTTP requests found in the HAR file that are available for analysis."
          ),
      },
      async (params): Promise<CallToolResult> => {
        return await this.handleListAllRequests(params);
      }
    );

    this.server.tool(
      "debug_force_dependency",
      "Manually create a dependency link between two nodes in the DAG to override automatic analysis. Use when automatic dependency detection fails.",
      {
        sessionId: z
          .string()
          .uuid()
          .describe("UUID of the session containing the nodes to link."),
        consumerNodeId: z
          .string()
          .uuid()
          .describe("UUID of the node that depends on the provider's data."),
        providerNodeId: z
          .string()
          .uuid()
          .describe(
            "UUID of the node that provides data (must be executed first)."
          ),
        providedPart: z
          .string()
          .describe(
            "Name of the dynamic part that the provider node resolves for the consumer."
          ),
      },
      async (params): Promise<CallToolResult> => {
        return await this.handleForceDependency(params);
      }
    );

    // Code Generation Tools
    this.server.tool(
      "codegen_generate_wrapper_script",
      "Generate a complete TypeScript wrapper script from the completed dependency analysis. Only works when analysis is complete (all nodes resolved).",
      {
        sessionId: z
          .string()
          .uuid()
          .describe(
            "UUID of the session with completed analysis. Use analysis_is_complete to verify the session is ready for code generation."
          ),
      },
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
      "Stop a manual browser session and collect all artifacts (HAR files, cookies, screenshots). Generates files ready for analysis.",
      {
        sessionId: z
          .string()
          .uuid()
          .describe(
            "UUID of the manual session to stop. Use session_list_manual to see active sessions."
          ),
        takeScreenshot: z
          .boolean()
          .default(true)
          .describe(
            "Whether to take a final screenshot before stopping the session."
          ),
        reason: z
          .string()
          .optional()
          .describe(
            "Optional reason for stopping the session (for logging purposes)."
          ),
      },
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

    this.server.tool(
      "session_health_check_manual",
      "Check the health status of a manual browser session. Detects if the browser is still responsive.",
      {
        sessionId: z
          .string()
          .uuid("Session ID must be a valid UUID")
          .describe(
            "UUID of the manual session to check. Reports browser connectivity and responsiveness."
          ),
      },
      async (params): Promise<CallToolResult> => {
        return await this.handleCheckManualSessionHealth(params);
      }
    );

    this.server.tool(
      "session_recover_manual",
      "Attempt to recover an unhealthy manual browser session. Tries to restore browser functionality.",
      {
        sessionId: z
          .string()
          .uuid("Session ID must be a valid UUID")
          .describe(
            "UUID of the manual session to recover. Use after session_health_check_manual reports an unhealthy session."
          ),
      },
      async (params): Promise<CallToolResult> => {
        return await this.handleRecoverManualSession(params);
      }
    );

    // Simplified workflow tools
    this.server.tool(
      "workflow_complete_analysis",
      "Complete end-to-end analysis workflow: automatically runs initial analysis, processes all nodes, and generates code",
      {
        sessionId: z
          .string()
          .uuid()
          .describe(
            "UUID of the session to analyze. Must be a session created with session_start that hasn't been analyzed yet."
          ),
        maxIterations: z
          .number()
          .int()
          .min(1)
          .max(50)
          .default(20)
          .describe(
            "Maximum number of analysis iterations to prevent infinite loops."
          ),
        openaiApiKey: z
          .string()
          .optional()
          .describe(
            "OpenAI API key for client-side LLM configuration (overrides environment variable)"
          ),
        googleApiKey: z
          .string()
          .optional()
          .describe(
            "Google API key for client-side LLM configuration (overrides environment variable)"
          ),
        provider: z
          .string()
          .optional()
          .describe(
            "LLM provider to use: 'openai' or 'gemini' (overrides environment variable)"
          ),
        model: z
          .string()
          .optional()
          .describe("LLM model to use (overrides environment variable)"),
      },
      async (params): Promise<CallToolResult> => {
        return await this.handleCompleteAnalysis(params);
      }
    );

    this.server.tool(
      "workflow_quick_capture",
      "Simplified workflow: Start manual session, capture interactions, and prepare for analysis",
      {
        url: z.string().url("URL must be a valid HTTP/HTTPS URL").optional(),
        duration: z
          .number()
          .min(1)
          .max(30)
          .default(5)
          .describe("Session duration in minutes (1-30, default: 5)"),
        description: z
          .string()
          .min(1)
          .describe("Brief description of the workflow to capture"),
      },
      async (params): Promise<CallToolResult> => {
        return await this.handleQuickCaptureWorkflow(params);
      }
    );

    this.server.tool(
      "workflow_analyze_har",
      "Simplified workflow: Analyze HAR file with automatic fallbacks and clear feedback. Supports API key parameters for client-side LLM configuration.",
      {
        harPath: z.string().min(1).describe("Path to the HAR file"),
        cookiePath: z
          .string()
          .optional()
          .describe("Path to cookie file (optional)"),
        description: z
          .string()
          .min(1)
          .describe("Description of what the workflow should accomplish"),
        autoFix: z
          .boolean()
          .default(true)
          .describe("Automatically attempt to fix common issues"),
        // Client-side API key support
        openaiApiKey: z
          .string()
          .optional()
          .describe(
            "OpenAI API key for client-side LLM configuration (overrides environment variable)"
          ),
        googleApiKey: z
          .string()
          .optional()
          .describe(
            "Google API key for client-side LLM configuration (overrides environment variable)"
          ),
        provider: z
          .string()
          .optional()
          .describe(
            "LLM provider to use: 'openai' or 'gemini' (overrides environment variable)"
          ),
        model: z
          .string()
          .optional()
          .describe("LLM model to use (overrides environment variable)"),
      },
      async (params): Promise<CallToolResult> => {
        return await this.handleAnalyzeHarWorkflow(params);
      }
    );

    // System monitoring tools
    this.server.tool(
      "session_status",
      "Get detailed status of a specific session including progress, completion, and next recommended actions",
      {
        sessionId: z
          .string()
          .uuid()
          .describe(
            "UUID of the session to check. Provides comprehensive status information and next steps."
          ),
      },
      async (params): Promise<CallToolResult> => {
        return await this.handleSessionStatus(params);
      }
    );

    this.server.tool(
      "system_memory_status",
      "Get current memory usage and session statistics",
      {},
      async (): Promise<CallToolResult> => {
        return await this.handleMemoryStatus();
      }
    );

    this.server.tool(
      "har_validate",
      "Validate a HAR file before analysis to check quality and identify potential issues",
      {
        harPath: z
          .string()
          .min(1)
          .describe(
            "Absolute path to the HAR file to validate. Checks file format, request quality, and analysis readiness."
          ),
        detailed: z
          .boolean()
          .default(false)
          .describe(
            "Whether to provide detailed analysis including request breakdown and suggestions."
          ),
      },
      async (params): Promise<CallToolResult> => {
        return await this.handleHarValidation(params);
      }
    );

    this.server.tool(
      "system_config_validate",
      "Validate LLM provider configuration and provide setup guidance for troubleshooting",
      {
        testApiKey: z
          .string()
          .optional()
          .describe(
            "Test API key for validation without setting environment variables"
          ),
        testProvider: z
          .string()
          .optional()
          .describe("Test provider ('openai' or 'gemini') for validation"),
      },
      async (params): Promise<CallToolResult> => {
        return await this.handleConfigValidation(params);
      }
    );

    this.server.tool(
      "system_cleanup",
      "Perform system cleanup to free memory and resources. Helps with memory management and performance.",
      {
        aggressive: z
          .boolean()
          .default(false)
          .describe(
            "Perform aggressive cleanup (may close long-running sessions). Aggressive cleanup removes more data but may impact performance."
          ),
      },
      async (params): Promise<CallToolResult> => {
        return await this.handleSystemCleanup(params);
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

    // Manual session artifacts resource
    this.server.resource(
      "harvest://manual/{sessionId}/artifacts.json",
      "Real-time artifact collection status and metadata for a manual browser session",
      (_uri, args) => {
        const sessionId = args?.sessionId as string;
        if (!sessionId) {
          throw new HarvestError(
            "Session ID is required",
            "MISSING_SESSION_ID"
          );
        }

        const sessionInfo = manualSessionManager.getSessionInfo(sessionId);
        if (!sessionInfo) {
          throw new HarvestError(
            `Manual session not found: ${sessionId}`,
            "MANUAL_SESSION_NOT_FOUND",
            { sessionId }
          );
        }

        const artifactsData = {
          sessionId,
          status: "active",
          startTime: sessionInfo.startTime,
          duration: sessionInfo.duration,
          currentUrl: sessionInfo.currentUrl,
          pageTitle: sessionInfo.pageTitle,
          outputDir: sessionInfo.outputDir,
          artifactConfig: {
            enabled: sessionInfo.artifactConfig?.enabled ?? true,
            saveHar: sessionInfo.artifactConfig?.saveHar ?? true,
            saveCookies: sessionInfo.artifactConfig?.saveCookies ?? true,
            saveScreenshots:
              sessionInfo.artifactConfig?.saveScreenshots ?? true,
            autoScreenshotInterval:
              sessionInfo.artifactConfig?.autoScreenshotInterval,
          },
          expectedArtifacts: {
            har: sessionInfo.artifactConfig?.saveHar !== false ? 1 : 0,
            cookies: sessionInfo.artifactConfig?.saveCookies !== false ? 1 : 0,
            screenshots:
              sessionInfo.artifactConfig?.saveScreenshots !== false
                ? "multiple"
                : 0,
          },
          metadata: {
            lastUpdated: new Date().toISOString(),
            sessionActive: true,
            browserType: "chromium",
            viewport: {
              width: 1280,
              height: 720,
            },
          },
        };

        return {
          contents: [
            {
              uri: `harvest://manual/${sessionId}/artifacts.json`,
              text: JSON.stringify(artifactsData, null, 2),
              mimeType: "application/json",
            },
          ],
        };
      }
    );

    // Manual session activity log resource
    this.server.resource(
      "harvest://manual/{sessionId}/session-log.txt",
      "Real-time activity log for a manual browser session",
      (_uri, args) => {
        const sessionId = args?.sessionId as string;
        if (!sessionId) {
          throw new HarvestError(
            "Session ID is required",
            "MISSING_SESSION_ID"
          );
        }

        const sessionInfo = manualSessionManager.getSessionInfo(sessionId);
        if (!sessionInfo) {
          throw new HarvestError(
            `Manual session not found: ${sessionId}`,
            "MANUAL_SESSION_NOT_FOUND",
            { sessionId }
          );
        }

        // Generate activity log based on session state
        const logEntries = [
          `[${new Date(sessionInfo.startTime).toISOString()}] INFO: Manual browser session started`,
          `[${new Date(sessionInfo.startTime).toISOString()}] INFO: Session ID: ${sessionId}`,
          `[${new Date(sessionInfo.startTime).toISOString()}] INFO: Initial URL: ${sessionInfo.currentUrl || "about:blank"}`,
          `[${new Date(sessionInfo.startTime).toISOString()}] INFO: Output directory: ${sessionInfo.outputDir}`,
          `[${new Date(sessionInfo.startTime).toISOString()}] INFO: Artifact collection enabled: ${sessionInfo.artifactConfig?.enabled !== false}`,
        ];

        if (sessionInfo.artifactConfig?.enabled !== false) {
          if (sessionInfo.artifactConfig?.saveHar !== false) {
            logEntries.push(
              `[${new Date(sessionInfo.startTime).toISOString()}] INFO: HAR file collection: enabled`
            );
          }
          if (sessionInfo.artifactConfig?.saveCookies !== false) {
            logEntries.push(
              `[${new Date(sessionInfo.startTime).toISOString()}] INFO: Cookie collection: enabled`
            );
          }
          if (sessionInfo.artifactConfig?.saveScreenshots !== false) {
            logEntries.push(
              `[${new Date(sessionInfo.startTime).toISOString()}] INFO: Screenshot collection: enabled`
            );
          }
          if (sessionInfo.artifactConfig?.autoScreenshotInterval) {
            logEntries.push(
              `[${new Date(sessionInfo.startTime).toISOString()}] INFO: Auto-screenshot interval: ${sessionInfo.artifactConfig.autoScreenshotInterval}s`
            );
          }
        }

        logEntries.push(
          `[${new Date().toISOString()}] INFO: Session duration: ${Math.floor(sessionInfo.duration / 60000)}m ${Math.floor((sessionInfo.duration % 60000) / 1000)}s`
        );
        logEntries.push(
          `[${new Date().toISOString()}] INFO: Current page: ${sessionInfo.pageTitle || "Unknown"}`
        );
        logEntries.push(
          `[${new Date().toISOString()}] INFO: Current URL: ${sessionInfo.currentUrl || "Unknown"}`
        );
        logEntries.push(
          `[${new Date().toISOString()}] STATUS: Session is active and ready for manual interaction`
        );

        const logText = logEntries.join("\n");

        return {
          contents: [
            {
              uri: `harvest://manual/${sessionId}/session-log.txt`,
              text: logText,
              mimeType: "text/plain",
            },
          ],
        };
      }
    );

    // Manual sessions list resource
    this.server.resource(
      "harvest://manual/sessions.json",
      "List of all active manual browser sessions",
      () => {
        const activeSessions = manualSessionManager.listActiveSessions();

        const sessionsData = {
          totalSessions: activeSessions.length,
          lastUpdated: new Date().toISOString(),
          sessions: activeSessions.map((session) => ({
            id: session.id,
            startTime: session.startTime,
            duration: session.duration,
            currentUrl: session.currentUrl,
            pageTitle: session.pageTitle,
            outputDir: session.outputDir,
            artifactConfig: session.artifactConfig,
            status: "active",
          })),
          summary: {
            longestRunningSession:
              activeSessions.length > 0
                ? Math.max(...activeSessions.map((s) => s.duration))
                : 0,
            averageDuration:
              activeSessions.length > 0
                ? Math.round(
                    activeSessions.reduce((sum, s) => sum + s.duration, 0) /
                      activeSessions.length
                  )
                : 0,
          },
        };

        return {
          contents: [
            {
              uri: "harvest://manual/sessions.json",
              text: JSON.stringify(sessionsData, null, 2),
              mimeType: "application/json",
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
      serverLogger.error({ error }, "MCP Server Error");
    };

    // Handle graceful shutdown
    process.on("SIGINT", () => {
      serverLogger.info("Shutting down Harvest MCP server...");
      this.sessionManager.clearAllSessions();
      process.exit(0);
    });

    process.on("SIGTERM", () => {
      serverLogger.info("Shutting down Harvest MCP server...");
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

      // Get session to check HAR validation results
      const session = this.sessionManager.getSession(sessionId);
      const harValidation = session.harData.validation;

      const response: SessionStartResponse = {
        sessionId,
        message: "Session created successfully",
        harPath: validatedArgs.harPath,
        prompt: validatedArgs.prompt,
        harValidation: harValidation
          ? {
              quality: harValidation.quality,
              stats: harValidation.stats,
              isValid: harValidation.isValid,
            }
          : undefined,
      };

      // Add warnings or recommendations if HAR quality is concerning
      if (harValidation) {
        if (harValidation.quality === "empty") {
          response.warning = "HAR file is empty or contains no usable requests";
          response.recommendations = harValidation.recommendations || [];
        } else if (harValidation.quality === "poor") {
          response.warning = "HAR file has limited useful content";
          response.recommendations = (
            harValidation.recommendations || []
          ).slice(0, 3); // Limit recommendations
        }
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(response),
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
   * Handle analysis_run_initial_analysis with API key support
   */
  public async handleRunInitialAnalysisWithApiKeys(
    args: unknown
  ): Promise<CallToolResult> {
    const parsedArgs = args as {
      sessionId: string;
      openaiApiKey?: string;
      googleApiKey?: string;
      provider?: string;
      model?: string;
    };

    let apiConfig:
      | {
          openaiApiKey?: string;
          googleApiKey?: string;
          provider?: string;
          model?: string;
        }
      | undefined;

    if (
      parsedArgs.openaiApiKey ||
      parsedArgs.googleApiKey ||
      parsedArgs.provider ||
      parsedArgs.model
    ) {
      apiConfig = {};
      if (parsedArgs.openaiApiKey) {
        apiConfig.openaiApiKey = parsedArgs.openaiApiKey;
      }
      if (parsedArgs.googleApiKey) {
        apiConfig.googleApiKey = parsedArgs.googleApiKey;
      }
      if (parsedArgs.provider) {
        apiConfig.provider = parsedArgs.provider;
      }
      if (parsedArgs.model) {
        apiConfig.model = parsedArgs.model;
      }
    }

    return await this.handleRunInitialAnalysisWithConfig(
      { sessionId: parsedArgs.sessionId },
      apiConfig
    );
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
          this.sessionManager.addLog(
            argsObj.sessionId,
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
                error: "No URLs available for analysis",
                message: "HAR file contains no analyzable requests",
                recommendations: [
                  "Ensure the HAR file was captured during meaningful interactions",
                  "Try capturing network traffic while submitting forms or loading data",
                  "Check that the website makes API calls or form submissions",
                ],
                debugInfo: {
                  totalRequests: session.harData.requests.length,
                  totalUrls: session.harData.urls.length,
                  harValidation: session.harData.validation,
                },
              }),
            },
          ],
          isError: true,
        };
      }

      // Log the start of initial analysis
      this.sessionManager.addLog(
        argsObj.sessionId,
        "info",
        "Starting initial analysis - identifying action URL"
      );

      // Use URLIdentificationAgent to identify the target URL with fallback
      let actionUrl: string;
      try {
        actionUrl = await identifyEndUrl(session, session.harData.urls);
      } catch (error) {
        // If LLM-based identification fails, use heuristic fallback
        if (
          error instanceof HarvestError &&
          error.code === "NO_PROVIDER_CONFIGURED"
        ) {
          this.sessionManager.addLog(
            argsObj.sessionId,
            "warn",
            "LLM provider not configured, using heuristic URL selection"
          );
          actionUrl = this.selectUrlHeuristically(session.harData.urls);
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
                message: `No request found for identified URL: ${actionUrl}`,
                actionUrl,
                availableUrls: session.harData.requests.map((r) => r.url),
                recommendations: [
                  "The HAR file may not contain the complete workflow",
                  "Try capturing a longer interaction sequence",
                  "Ensure all form submissions and API calls are included",
                ],
                debugInfo: {
                  identifiedUrl: actionUrl,
                  totalRequests: session.harData.requests.length,
                  harQuality: session.harData.validation?.quality,
                },
              }),
            },
          ],
          isError: true,
        };
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
              harQuality: session.harData.validation?.quality,
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
   * Handle initial analysis with API key configuration support
   */
  public async handleRunInitialAnalysisWithConfig(
    args: { sessionId: string },
    apiConfig?: {
      openaiApiKey?: string;
      googleApiKey?: string;
      provider?: string;
      model?: string;
    }
  ): Promise<CallToolResult> {
    try {
      const session = this.sessionManager.getSession(args.sessionId);

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
          this.sessionManager.addLog(
            args.sessionId,
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

      // Create LLM client with API key configuration if provided
      const llmClient = apiConfig
        ? createLLMClientWithConfig(apiConfig)
        : undefined;

      // Identify end URL with optional LLM client and fallback handling
      let actionUrl: string;
      try {
        actionUrl = await identifyEndUrl(
          session,
          session.harData.urls,
          llmClient
        );
      } catch (error) {
        // If LLM-based identification fails, use heuristic fallback
        if (
          error instanceof HarvestError &&
          error.code === "NO_PROVIDER_CONFIGURED"
        ) {
          this.sessionManager.addLog(
            args.sessionId,
            "warn",
            "LLM provider not configured, using heuristic URL selection"
          );
          actionUrl = this.selectUrlHeuristically(session.harData.urls);
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

      this.sessionManager.addLog(
        args.sessionId,
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
      const argsObj = this.validateManualSessionStartArgs(args);
      const sessionConfig = this.buildSessionConfig(argsObj);
      const sessionInfo =
        await manualSessionManager.startSession(sessionConfig);

      return this.buildManualSessionStartResponse(sessionInfo, argsObj, args);
    } catch (error) {
      if (error instanceof HarvestError) {
        throw error; // Re-throw HarvestError with original context
      }

      throw new HarvestError(
        `Failed to start manual session: ${error instanceof Error ? error.message : "Unknown error"}`,
        "MANUAL_SESSION_START_FAILED",
        { originalError: error }
      );
    }
  }

  /**
   * Validate manual session start arguments
   */
  private validateManualSessionStartArgs(args: unknown) {
    const validationResult = ManualSessionStartSchema.safeParse(args);
    if (!validationResult.success) {
      const errorDetails = validationResult.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; ");

      throw new HarvestError(
        `Invalid parameters for manual session start: ${errorDetails}`,
        "MANUAL_SESSION_INVALID_PARAMS",
        {
          validationErrors: validationResult.error.issues,
          receivedArgs: args,
        }
      );
    }
    return validationResult.data;
  }

  /**
   * Build session configuration from validated arguments
   */
  private buildSessionConfig(
    argsObj: z.infer<typeof ManualSessionStartSchema>
  ): SessionConfig {
    const sessionConfig: SessionConfig = {};

    if (argsObj.url) {
      sessionConfig.url = argsObj.url;
    }

    if (argsObj.config) {
      this.applyConfigOptions(sessionConfig, argsObj.config);
    }

    return sessionConfig;
  }

  /**
   * Apply configuration options to session config
   */
  private applyConfigOptions(
    sessionConfig: SessionConfig,
    config: NonNullable<z.infer<typeof ManualSessionStartSchema>["config"]>
  ): void {
    if (config.timeout !== undefined) {
      sessionConfig.timeout = config.timeout;
    }

    if (config.browserOptions) {
      sessionConfig.browserOptions = this.buildBrowserOptions(
        config.browserOptions
      );
    }

    if (config.artifactConfig) {
      sessionConfig.artifactConfig = this.buildArtifactConfig(
        config.artifactConfig
      );
    }
  }

  /**
   * Build browser options configuration
   */
  private buildBrowserOptions(
    browserOptions: NonNullable<
      NonNullable<
        z.infer<typeof ManualSessionStartSchema>["config"]
      >["browserOptions"]
    >
  ): NonNullable<SessionConfig["browserOptions"]> {
    const options: NonNullable<SessionConfig["browserOptions"]> = {};

    if (browserOptions.headless !== undefined) {
      options.headless = browserOptions.headless;
    }
    if (browserOptions.viewport) {
      options.viewport = browserOptions.viewport;
    }
    if (browserOptions.contextOptions) {
      options.contextOptions = browserOptions.contextOptions;
    }

    return options;
  }

  /**
   * Build artifact configuration
   */
  private buildArtifactConfig(
    artifactConfig: NonNullable<
      NonNullable<
        z.infer<typeof ManualSessionStartSchema>["config"]
      >["artifactConfig"]
    >
  ): NonNullable<SessionConfig["artifactConfig"]> {
    const config: NonNullable<SessionConfig["artifactConfig"]> = {};

    if (artifactConfig.enabled !== undefined) {
      config.enabled = artifactConfig.enabled;
    }
    if (artifactConfig.outputDir !== undefined) {
      config.outputDir = artifactConfig.outputDir;
    }
    if (artifactConfig.saveHar !== undefined) {
      config.saveHar = artifactConfig.saveHar;
    }
    if (artifactConfig.saveCookies !== undefined) {
      config.saveCookies = artifactConfig.saveCookies;
    }
    if (artifactConfig.saveScreenshots !== undefined) {
      config.saveScreenshots = artifactConfig.saveScreenshots;
    }
    if (artifactConfig.autoScreenshotInterval !== undefined) {
      config.autoScreenshotInterval = artifactConfig.autoScreenshotInterval;
    }

    return config;
  }

  /**
   * Build response for manual session start
   */
  private buildManualSessionStartResponse(
    sessionInfo: BrowserSessionInfo,
    argsObj: z.infer<typeof ManualSessionStartSchema>,
    originalArgs: unknown
  ): CallToolResult {
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
            validation: {
              parametersValidated: true,
              urlSanitized:
                argsObj.url !== (originalArgs as Record<string, unknown>)?.url,
            },
          }),
        },
      ],
    };
  }

  /**
   * Handle session_stop_manual tool call
   */
  public async handleStopManualSession(args: unknown): Promise<CallToolResult> {
    try {
      // Validate and parse arguments with enhanced error handling
      const validationResult = ManualSessionStopSchema.safeParse(args);
      if (!validationResult.success) {
        const errorDetails = validationResult.error.issues
          .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
          .join("; ");

        throw new HarvestError(
          `Invalid parameters for manual session stop: ${errorDetails}`,
          "MANUAL_SESSION_STOP_INVALID_PARAMS",
          {
            validationErrors: validationResult.error.issues,
            receivedArgs: args,
          }
        );
      }

      const argsObj = validationResult.data;

      // Check if session exists before attempting to stop
      const sessionInfo = manualSessionManager.getSessionInfo(
        argsObj.sessionId
      );
      if (!sessionInfo) {
        throw new HarvestError(
          `Manual session not found: ${argsObj.sessionId}`,
          "MANUAL_SESSION_NOT_FOUND",
          { sessionId: argsObj.sessionId }
        );
      }

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
              durationFormatted: `${Math.floor(result.duration / 60000)}m ${Math.floor((result.duration % 60000) / 1000)}s`,
              finalUrl: result.finalUrl,
              finalPageTitle: result.finalPageTitle,
              artifactsCollected: result.artifacts.length,
              artifacts: result.artifacts.map((artifact) => ({
                type: artifact.type,
                path: artifact.path,
                size: artifact.size,
                sizeFormatted: this.formatFileSize(artifact.size),
                timestamp: artifact.timestamp,
              })),
              summary: result.summary,
              metadata: {
                ...result.metadata,
                parametersValidated: true,
                requestedArtifactTypes: argsObj.artifactTypes,
              },
              message: "Manual browser session stopped and artifacts collected",
            }),
          },
        ],
      };
    } catch (error) {
      if (error instanceof HarvestError) {
        throw error; // Re-throw HarvestError with original context
      }

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
              totalSessions: activeSessions.length,
              sessions: activeSessions.map((session) => ({
                id: session.id,
                startTime: session.startTime,
                startTimeFormatted: new Date(session.startTime).toISOString(),
                currentUrl: session.currentUrl,
                pageTitle: session.pageTitle,
                duration: session.duration,
                durationFormatted: `${Math.floor(session.duration / 60000)}m ${Math.floor((session.duration % 60000) / 1000)}s`,
                outputDir: session.outputDir,
                artifactConfig: {
                  enabled: session.artifactConfig?.enabled ?? true,
                  saveHar: session.artifactConfig?.saveHar ?? true,
                  saveCookies: session.artifactConfig?.saveCookies ?? true,
                  saveScreenshots:
                    session.artifactConfig?.saveScreenshots ?? true,
                  autoScreenshotInterval:
                    session.artifactConfig?.autoScreenshotInterval,
                },
                status: "active",
              })),
              summary: {
                totalActiveSessions: activeSessions.length,
                longestRunningSession:
                  activeSessions.length > 0
                    ? Math.max(...activeSessions.map((s) => s.duration))
                    : 0,
                averageDuration:
                  activeSessions.length > 0
                    ? Math.round(
                        activeSessions.reduce((sum, s) => sum + s.duration, 0) /
                          activeSessions.length
                      )
                    : 0,
              },
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
   * Handle session_health_check_manual tool call
   */
  public async handleCheckManualSessionHealth(
    args: unknown
  ): Promise<CallToolResult> {
    try {
      const argsObj = args as { sessionId: string };
      const healthCheck = await manualSessionManager.checkSessionHealth(
        argsObj.sessionId
      );

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              success: true,
              sessionId: argsObj.sessionId,
              health: healthCheck,
              message: healthCheck.isHealthy
                ? "Session is healthy"
                : `Session has ${healthCheck.issues.length} issue(s)`,
              recommendations: healthCheck.recommendations,
            }),
          },
        ],
      };
    } catch (error) {
      throw new HarvestError(
        `Failed to check session health: ${error instanceof Error ? error.message : "Unknown error"}`,
        "MANUAL_SESSION_HEALTH_CHECK_FAILED",
        { originalError: error }
      );
    }
  }

  /**
   * Handle session_recover_manual tool call
   */
  public async handleRecoverManualSession(
    args: unknown
  ): Promise<CallToolResult> {
    try {
      const argsObj = args as { sessionId: string };
      const recoveryResult = await manualSessionManager.recoverSession(
        argsObj.sessionId
      );

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              success: recoveryResult.success,
              sessionId: argsObj.sessionId,
              recovery: recoveryResult,
              message: recoveryResult.success
                ? "Session recovery successful"
                : "Session recovery failed",
              actionsPerformed: recoveryResult.actions,
              remainingIssues: recoveryResult.newIssues,
            }),
          },
        ],
      };
    } catch (error) {
      throw new HarvestError(
        `Failed to recover session: ${error instanceof Error ? error.message : "Unknown error"}`,
        "MANUAL_SESSION_RECOVERY_FAILED",
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
   * Handle workflow_quick_capture tool call
   */
  public async handleQuickCaptureWorkflow(
    args: unknown
  ): Promise<CallToolResult> {
    try {
      const argsObj = args as {
        url?: string;
        duration: number;
        description: string;
      };

      // Start a manual session with smart defaults
      const sessionConfig = {
        ...(argsObj.url && { url: argsObj.url }),
        config: {
          timeout: argsObj.duration,
          browserOptions: {
            headless: false,
            viewport: { width: 1920, height: 1080 },
          },
          artifactConfig: {
            enabled: true,
            saveHar: true,
            saveCookies: true,
            saveScreenshots: true,
            outputDir: "~/Desktop",
          },
        },
      };

      const sessionResult = await this.handleStartManualSession(sessionConfig);
      const sessionContent = sessionResult.content?.[0]?.text;
      if (typeof sessionContent !== "string") {
        throw new Error("Invalid session result format");
      }
      const sessionData = JSON.parse(sessionContent);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              success: true,
              workflow: "quick_capture",
              sessionId: sessionData.sessionId,
              duration: argsObj.duration,
              description: argsObj.description,
              message: "Quick capture session started successfully",
              instructions: [
                `🎯 Quick Capture Session: ${argsObj.description}`,
                "",
                `⏰ You have ${argsObj.duration} minutes to complete your workflow`,
                "📋 Steps to follow:",
                "1. Interact with the website normally",
                "2. Complete the workflow you described",
                "3. The session will auto-stop, or use session_stop_manual",
                "4. Use workflow_analyze_har with the generated HAR file",
                "",
                "💡 Tips:",
                "- Submit forms and click buttons to generate meaningful requests",
                "- Wait for pages to load completely",
                "- Look for API calls and network activity",
              ],
              nextSteps: [
                "Complete your workflow in the browser",
                `Session will auto-stop after ${argsObj.duration} minutes`,
                "Use workflow_analyze_har to process the captured data",
              ],
            }),
          },
        ],
      };
    } catch (error) {
      throw new HarvestError(
        `Quick capture workflow failed: ${error instanceof Error ? error.message : "Unknown error"}`,
        "QUICK_CAPTURE_WORKFLOW_FAILED",
        { originalError: error }
      );
    }
  }

  /**
   * Parse and validate arguments for complete analysis
   */
  private parseCompleteAnalysisArgs(args: unknown) {
    return args as {
      sessionId: string;
      maxIterations: number;
      openaiApiKey?: string;
      googleApiKey?: string;
      provider?: string;
      model?: string;
    };
  }

  /**
   * Build API configuration from arguments
   */
  private buildApiConfig(
    argsObj: ReturnType<typeof this.parseCompleteAnalysisArgs>
  ) {
    if (
      !argsObj.openaiApiKey &&
      !argsObj.googleApiKey &&
      !argsObj.provider &&
      !argsObj.model
    ) {
      return undefined;
    }

    const apiConfig: {
      openaiApiKey?: string;
      googleApiKey?: string;
      provider?: string;
      model?: string;
    } = {};

    if (argsObj.openaiApiKey) {
      apiConfig.openaiApiKey = argsObj.openaiApiKey;
    }
    if (argsObj.googleApiKey) {
      apiConfig.googleApiKey = argsObj.googleApiKey;
    }
    if (argsObj.provider) {
      apiConfig.provider = argsObj.provider;
    }
    if (argsObj.model) {
      apiConfig.model = argsObj.model;
    }

    return apiConfig;
  }

  /**
   * Run initial analysis step for complete workflow
   */
  private async runInitialAnalysisForWorkflow(
    argsObj: ReturnType<typeof this.parseCompleteAnalysisArgs>,
    apiConfig: ReturnType<typeof this.buildApiConfig>,
    steps: string[]
  ) {
    steps.push("📍 Step 1: Running initial analysis to identify target URL");
    return await this.handleRunInitialAnalysisWithConfig(
      { sessionId: argsObj.sessionId },
      apiConfig
    );
  }

  /**
   * Create error result for failed analysis
   */
  private createErrorResult(
    initialResult: CallToolResult,
    sessionId: string,
    steps: string[],
    startTime: number
  ): CallToolResult {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            success: false,
            error: "Initial analysis failed",
            sessionId,
            steps,
            details: initialResult.content?.[0]?.text || "Unknown error",
            elapsedTime: Date.now() - startTime,
          }),
        },
      ],
      isError: true,
    };
  }

  /**
   * Process nodes iteratively until complete or max iterations reached
   */
  private async processNodesIteratively(
    argsObj: ReturnType<typeof this.parseCompleteAnalysisArgs>,
    steps: string[],
    warnings: string[]
  ) {
    steps.push("🔄 Step 2: Processing dependency nodes");
    let iterations = 0;
    let isComplete = false;

    while (!isComplete && iterations < argsObj.maxIterations) {
      iterations++;

      // Check if analysis is complete
      const completeResult = await this.handleIsComplete({
        sessionId: argsObj.sessionId,
      });
      const completeData = JSON.parse(
        (completeResult.content?.[0]?.text as string) || '{"isComplete": false}'
      );

      if (completeData.isComplete) {
        isComplete = true;
        steps.push(`✅ Analysis complete after ${iterations} iterations`);
        break;
      }

      // Process next node
      const processResult = await this.handleProcessNextNode({
        sessionId: argsObj.sessionId,
      });
      const processData = JSON.parse(
        (processResult.content?.[0]?.text as string) || '{"message": "unknown"}'
      );

      if (processResult.isError) {
        warnings.push(
          `Iteration ${iterations}: ${processData.error || "Processing failed"}`
        );
      } else {
        steps.push(
          `📦 Processed node ${iterations}: ${processData.message || "Node processed"}`
        );
      }
    }

    if (!isComplete) {
      warnings.push(
        `Analysis incomplete after ${argsObj.maxIterations} iterations`
      );
    }

    return { isComplete, iterations };
  }

  /**
   * Generate code if analysis is complete
   */
  private async generateCodeIfComplete(
    isComplete: boolean,
    argsObj: ReturnType<typeof this.parseCompleteAnalysisArgs>,
    steps: string[],
    warnings: string[]
  ) {
    let generatedCode = "";

    if (isComplete) {
      steps.push("📝 Step 3: Generating TypeScript wrapper code");
      try {
        const codeResult = await this.handleGenerateWrapperScript({
          sessionId: argsObj.sessionId,
        });
        const codeData = JSON.parse(
          (codeResult.content?.[0]?.text as string) || '{"code": ""}'
        );

        if (codeResult.isError) {
          warnings.push("Code generation failed");
        } else {
          generatedCode = codeData.code || "";
          steps.push(
            `✅ Code generation complete - ${generatedCode.length} characters generated`
          );
        }
      } catch (error) {
        warnings.push(
          `Code generation error: ${error instanceof Error ? error.message : "Unknown error"}`
        );
      }
    }

    return generatedCode;
  }

  /**
   * Create success result for complete analysis
   */
  private createSuccessResult(params: {
    sessionId: string;
    isComplete: boolean;
    iterations: number;
    targetUrl: string;
    elapsedTime: number;
    generatedCode: string;
    steps: string[];
    warnings: string[];
  }): CallToolResult {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            success: true,
            sessionId: params.sessionId,
            result: {
              isComplete: params.isComplete,
              iterations: params.iterations,
              targetUrl: params.targetUrl,
              elapsedTime: params.elapsedTime,
              codeGenerated: !!params.generatedCode,
              codeLength: params.generatedCode.length,
            },
            steps: params.steps,
            warnings: params.warnings,
            ...(params.generatedCode && {
              generatedCode: params.generatedCode,
            }),
            summary: `Analysis ${params.isComplete ? "completed" : "partially completed"} in ${params.iterations} iterations (${params.elapsedTime}ms)`,
          }),
        },
      ],
    };
  }

  /**
   * Handle workflow_complete_analysis tool call
   */
  public async handleCompleteAnalysis(args: unknown): Promise<CallToolResult> {
    try {
      const argsObj = this.parseCompleteAnalysisArgs(args);
      const startTime = Date.now();
      const steps: string[] = [];
      const warnings: string[] = [];

      const apiConfig = this.buildApiConfig(argsObj);

      steps.push("🚀 Starting complete analysis workflow");

      // Step 1: Run initial analysis
      const initialResult = await this.runInitialAnalysisForWorkflow(
        argsObj,
        apiConfig,
        steps
      );
      if (initialResult.isError) {
        return this.createErrorResult(
          initialResult,
          argsObj.sessionId,
          steps,
          startTime
        );
      }

      const initialData = JSON.parse(
        (initialResult.content?.[0]?.text as string) ||
          '{"actionUrl": "unknown"}'
      );
      steps.push(
        `✅ Initial analysis complete - Target URL: ${initialData.actionUrl}`
      );

      // Step 2: Process all nodes iteratively
      const processingResult = await this.processNodesIteratively(
        argsObj,
        steps,
        warnings
      );
      const { isComplete, iterations } = processingResult;

      // Step 3: Generate code (if analysis is complete)
      const generatedCode = await this.generateCodeIfComplete(
        isComplete,
        argsObj,
        steps,
        warnings
      );

      const elapsedTime = Date.now() - startTime;
      steps.push(`🎯 Workflow completed in ${elapsedTime}ms`);

      return this.createSuccessResult({
        sessionId: argsObj.sessionId,
        isComplete,
        iterations,
        targetUrl: initialData.actionUrl,
        elapsedTime,
        generatedCode,
        steps,
        warnings,
      });
    } catch (error) {
      throw new HarvestError(
        `Complete analysis workflow failed: ${error instanceof Error ? error.message : "Unknown error"}`,
        "COMPLETE_ANALYSIS_FAILED",
        { originalError: error }
      );
    }
  }

  /**
   * Handle workflow_analyze_har tool call
   */
  public async handleAnalyzeHarWorkflow(
    args: unknown
  ): Promise<CallToolResult> {
    try {
      const validatedArgs = this.validateAnalysisArgs(args);
      const { sessionId, harValidation } =
        await this.createWorkflowAnalysisSession(validatedArgs);

      const harQualityCheck = this.processHarValidation(
        harValidation,
        sessionId,
        validatedArgs.autoFix
      );

      if (harQualityCheck.shouldEarlyReturn && harQualityCheck.result) {
        return harQualityCheck.result;
      }

      return await this.performWorkflowAnalysis(
        sessionId,
        validatedArgs,
        harValidation,
        harQualityCheck.analysisSteps,
        harQualityCheck.warnings,
        harQualityCheck.recommendations
      );
    } catch (error) {
      throw new HarvestError(
        `HAR analysis workflow failed: ${error instanceof Error ? error.message : "Unknown error"}`,
        "ANALYZE_HAR_WORKFLOW_FAILED",
        { originalError: error }
      );
    }
  }

  /**
   * Validate and parse arguments for analysis workflow
   */
  private validateAnalysisArgs(args: unknown) {
    return args as {
      harPath: string;
      cookiePath?: string;
      description: string;
      autoFix: boolean;
      openaiApiKey?: string;
      googleApiKey?: string;
      provider?: string;
      model?: string;
    };
  }

  /**
   * Create workflow analysis session and return session data
   */
  private async createWorkflowAnalysisSession(args: {
    harPath: string;
    cookiePath?: string;
    description: string;
  }) {
    const sessionParams = {
      harPath: args.harPath,
      cookiePath: args.cookiePath,
      prompt: `Generate TypeScript code for: ${args.description}`,
    };

    const sessionResult = await this.handleSessionStart(sessionParams);
    const sessionContent = sessionResult.content?.[0]?.text;
    if (typeof sessionContent !== "string") {
      throw new Error("Invalid session result format");
    }

    const sessionData = JSON.parse(sessionContent);
    return {
      sessionId: sessionData.sessionId,
      harValidation: sessionData.harValidation,
    };
  }

  /**
   * Process HAR validation and return early guidance if needed
   */
  private processHarValidation(
    harValidation: HarValidationResult | undefined,
    sessionId: string,
    autoFix: boolean
  ): {
    shouldEarlyReturn: boolean;
    result?: CallToolResult;
    analysisSteps: string[];
    warnings: string[];
    recommendations: string[];
  } {
    const analysisSteps: string[] = [];
    const warnings: string[] = [];
    const recommendations: string[] = [];

    if (!harValidation) {
      return {
        shouldEarlyReturn: false,
        analysisSteps,
        warnings,
        recommendations,
      };
    }

    analysisSteps.push(`✅ HAR file loaded: ${harValidation.quality} quality`);
    analysisSteps.push(
      `📊 Found ${harValidation.stats.relevantEntries} relevant requests`
    );

    if (harValidation.quality === "empty") {
      return {
        shouldEarlyReturn: true,
        result: {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: false,
                workflow: "analyze_har",
                sessionId,
                error: "HAR file is empty or unusable",
                issues: harValidation.issues,
                recommendations: [
                  "🔄 Capture a new HAR file with more interactions",
                  "📝 Ensure you complete forms or trigger API calls",
                  "🌐 Try interacting with dynamic website features",
                  ...(harValidation.recommendations || []).slice(0, 3),
                ],
                nextSteps: [
                  "Use workflow_quick_capture to capture better data",
                  "Ensure meaningful interactions are recorded",
                  "Check that network recording was enabled",
                ],
              }),
            },
          ],
          isError: true,
        },
        analysisSteps,
        warnings,
        recommendations,
      };
    }

    if (harValidation.quality === "poor" && autoFix) {
      warnings.push("HAR quality is poor, but proceeding with analysis");
      recommendations.push(
        "Consider capturing additional interactions for better results"
      );
    }

    return {
      shouldEarlyReturn: false,
      analysisSteps,
      warnings,
      recommendations,
    };
  }

  /**
   * Perform the main workflow analysis and code generation
   */
  private async performWorkflowAnalysis(
    sessionId: string,
    args: {
      harPath: string;
      description: string;
      autoFix: boolean;
      openaiApiKey?: string;
      googleApiKey?: string;
      provider?: string;
      model?: string;
    },
    harValidation: HarValidationResult | undefined,
    analysisSteps: string[],
    warnings: string[],
    recommendations: string[]
  ): Promise<CallToolResult> {
    try {
      // Attempt initial analysis with API key parameters
      let apiConfig:
        | {
            openaiApiKey?: string;
            googleApiKey?: string;
            provider?: string;
            model?: string;
          }
        | undefined;

      if (
        args.openaiApiKey ||
        args.googleApiKey ||
        args.provider ||
        args.model
      ) {
        apiConfig = {};
        if (args.openaiApiKey) {
          apiConfig.openaiApiKey = args.openaiApiKey;
        }
        if (args.googleApiKey) {
          apiConfig.googleApiKey = args.googleApiKey;
        }
        if (args.provider) {
          apiConfig.provider = args.provider;
        }
        if (args.model) {
          apiConfig.model = args.model;
        }
      }

      const initialResult = await this.handleRunInitialAnalysisWithConfig(
        { sessionId },
        apiConfig
      );
      const initialContent = initialResult.content?.[0]?.text;

      if (initialResult.isError || !initialContent) {
        return this.formatAnalysisErrorResponse(
          sessionId,
          args,
          harValidation,
          "Initial analysis failed",
          recommendations,
          "This usually indicates an LLM provider configuration issue. Try using API key parameters or run system_config_validate for setup guidance."
        );
      }

      const initialData = JSON.parse(initialContent as string);
      analysisSteps.push(`🎯 Identified target URL: ${initialData.actionUrl}`);

      // Process nodes iteratively
      const processingResult = await this.processAnalysisNodes(
        sessionId,
        analysisSteps
      );

      if (processingResult.isComplete) {
        return await this.generateAndReturnCode(
          sessionId,
          args,
          harValidation,
          analysisSteps,
          warnings
        );
      }

      return await this.formatIncompleteAnalysisResponse(
        sessionId,
        args,
        harValidation,
        analysisSteps,
        warnings,
        recommendations
      );
    } catch (analysisError) {
      return this.formatAnalysisStartErrorResponse(
        sessionId,
        harValidation,
        analysisError
      );
    }
  }

  /**
   * Process analysis nodes iteratively
   */
  private async processAnalysisNodes(
    sessionId: string,
    analysisSteps: string[]
  ) {
    let iterations = 0;
    const maxIterations = 10;
    let isComplete = false;

    while (!isComplete && iterations < maxIterations) {
      try {
        const completeResult = await this.handleIsComplete({ sessionId });
        const completeContent = completeResult.content?.[0]?.text;

        if (typeof completeContent === "string") {
          const completeData = JSON.parse(completeContent);
          isComplete = completeData.isComplete;
        }

        if (!isComplete) {
          const processResult = await this.handleProcessNextNode({ sessionId });
          const processContent = processResult.content?.[0]?.text;

          if (typeof processContent === "string") {
            const processData = JSON.parse(processContent);
            if (processData.status === "no_nodes_to_process") {
              break;
            }
            analysisSteps.push(`🔄 Processed node ${iterations + 1}`);
          }
        }

        iterations++;
      } catch (_processError) {
        analysisSteps.push(
          `⚠️ Processing iteration ${iterations + 1} had issues`
        );
        break;
      }
    }

    return { isComplete };
  }

  /**
   * Generate code and return successful response
   */
  private async generateAndReturnCode(
    sessionId: string,
    args: { description: string },
    harValidation: HarValidationResult | undefined,
    analysisSteps: string[],
    warnings: string[]
  ): Promise<CallToolResult> {
    try {
      const codeResult = await this.handleGenerateWrapperScript({ sessionId });
      const codeContent = codeResult.content?.[0]?.text;

      if (typeof codeContent === "string") {
        analysisSteps.push(
          `✅ Generated ${codeContent.length} characters of TypeScript code`
        );

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: true,
                workflow: "analyze_har",
                sessionId,
                description: args.description,
                harQuality: harValidation?.quality,
                analysisSteps,
                warnings,
                generatedCodeLength: codeContent.length,
                message: "Analysis completed successfully",
                code: codeContent,
              }),
            },
          ],
        };
      }
    } catch (_codeError) {
      analysisSteps.push("❌ Code generation failed");
    }

    // Code generation failed, return incomplete response
    return await this.formatIncompleteAnalysisResponse(
      sessionId,
      args as { description: string },
      harValidation,
      analysisSteps,
      warnings,
      []
    );
  }

  /**
   * Format response for incomplete analysis
   */
  private async formatIncompleteAnalysisResponse(
    sessionId: string,
    args: { description: string },
    harValidation: HarValidationResult | undefined,
    analysisSteps: string[],
    warnings: string[],
    recommendations: string[]
  ): Promise<CallToolResult> {
    const unresolvedResult = await this.handleGetUnresolvedNodes({ sessionId });
    const unresolvedContent = unresolvedResult.content?.[0]?.text;
    let unresolvedInfo = "Unknown";

    if (typeof unresolvedContent === "string") {
      const unresolvedData = JSON.parse(unresolvedContent);
      unresolvedInfo = `${unresolvedData.totalUnresolved} unresolved nodes`;
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            success: false,
            workflow: "analyze_har",
            sessionId,
            description: args.description,
            harQuality: harValidation?.quality,
            analysisSteps,
            warnings,
            error: "Analysis incomplete",
            unresolvedInfo,
            recommendations: [
              "🔍 Use debug tools to investigate unresolved dependencies",
              "📝 Try capturing a more complete workflow",
              "🎯 Focus on the specific action you want to automate",
              ...recommendations,
            ],
            debugSessionId: sessionId,
          }),
        },
      ],
      isError: true,
    };
  }

  /**
   * Format error response for failed analysis
   */
  private formatAnalysisErrorResponse(
    sessionId: string,
    args: { harPath: string; description: string; autoFix: boolean },
    harValidation: HarValidationResult | undefined,
    error: string,
    recommendations: string[],
    context?: string
  ): CallToolResult {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            success: false,
            workflow: "analyze_har",
            sessionId,
            error,
            ...(context && { context }),
            harQuality: harValidation?.quality,
            issues: harValidation?.issues || [],
            autoFixAttempted: args.autoFix,
            recommendations: [
              "🎯 Try workflow_quick_capture to get better HAR data",
              "📋 Ensure your workflow includes form submissions or API calls",
              "🔍 Use debug_list_all_requests to see what was captured",
              "🔧 Run system_config_validate to check LLM provider setup",
              ...recommendations,
            ],
            debugInfo: {
              sessionId,
              harPath: args.harPath,
              description: args.description,
            },
          }),
        },
      ],
      isError: true,
    };
  }

  /**
   * Format error response for analysis start failure
   */
  private formatAnalysisStartErrorResponse(
    sessionId: string,
    harValidation: HarValidationResult | undefined,
    analysisError: unknown
  ): CallToolResult {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            success: false,
            workflow: "analyze_har",
            sessionId,
            error: "Analysis failed to start",
            message:
              analysisError instanceof Error
                ? analysisError.message
                : "Unknown error",
            harQuality: harValidation?.quality,
            recommendations: [
              "🎯 Use workflow_quick_capture for better data collection",
              "📋 Ensure HAR file contains meaningful interactions",
              "🔍 Check that the workflow completes successfully",
            ],
          }),
        },
      ],
      isError: true,
    };
  }

  /**
   * Handle system_memory_status tool call
   */
  public async handleMemoryStatus(): Promise<CallToolResult> {
    try {
      const memoryStats = manualSessionManager.getMemoryStats();
      const analysisSessionsCount =
        this.sessionManager.getStats().totalSessions;

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              success: true,
              timestamp: new Date().toISOString(),
              memory: {
                current: {
                  heapUsed: this.formatFileSize(memoryStats.current.heapUsed),
                  heapTotal: this.formatFileSize(memoryStats.current.heapTotal),
                  external: this.formatFileSize(memoryStats.current.external),
                },
                peak: {
                  heapUsed: this.formatFileSize(memoryStats.peak.heapUsed),
                  heapTotal: this.formatFileSize(memoryStats.peak.heapTotal),
                },
                average: {
                  heapUsed: this.formatFileSize(memoryStats.average.heapUsed),
                },
                snapshotCount: memoryStats.snapshotCount,
              },
              sessions: {
                manualSessions: memoryStats.activeSessions,
                analysisSessions: analysisSessionsCount,
                totalSessions:
                  memoryStats.activeSessions + analysisSessionsCount,
              },
              leakDetection: memoryStats.leakDetection,
              recommendations: this.generateMemoryRecommendations(memoryStats),
              status: this.getMemoryStatus(memoryStats.current.heapUsed),
            }),
          },
        ],
      };
    } catch (error) {
      throw new HarvestError(
        `Failed to get memory status: ${error instanceof Error ? error.message : "Unknown error"}`,
        "MEMORY_STATUS_FAILED",
        { originalError: error }
      );
    }
  }

  /**
   * Handle session_status tool call
   */
  public async handleSessionStatus(args: unknown): Promise<CallToolResult> {
    try {
      const argsObj = args as { sessionId: string };
      const session = this.sessionManager.getSession(argsObj.sessionId);

      // Calculate progress metrics
      const totalNodes = session.dagManager.getNodeCount();
      const unresolvedNodes = session.dagManager.getUnresolvedNodes().length;
      const resolvedNodes = totalNodes - unresolvedNodes;
      const progressPercent =
        totalNodes > 0 ? Math.round((resolvedNodes / totalNodes) * 100) : 0;

      // Determine next actions
      const nextActions: string[] = [];
      const warnings: string[] = [];

      if (!session.state.masterNodeId) {
        nextActions.push(
          "Run analysis_run_initial_analysis to identify the target URL"
        );
      } else if (unresolvedNodes > 0) {
        nextActions.push(
          "Run analysis_process_next_node to continue resolving dependencies"
        );
        nextActions.push(`${unresolvedNodes} nodes remaining to process`);
      } else if (session.state.isComplete) {
        nextActions.push(
          "Analysis complete - run codegen_generate_wrapper_script to generate code"
        );
      } else {
        nextActions.push(
          "Run analysis_is_complete to check if analysis is finished"
        );
      }

      // Check for potential issues
      if (
        session.harData.validation &&
        session.harData.validation.quality === "poor"
      ) {
        warnings.push(
          "HAR file quality is poor - consider capturing a new one"
        );
      }

      if (totalNodes === 0) {
        warnings.push(
          "No nodes in dependency graph - may need to run initial analysis"
        );
      }

      const lastActivity = new Date(session.lastActivity);
      const minutesInactive = Math.floor(
        (Date.now() - lastActivity.getTime()) / (1000 * 60)
      );

      if (minutesInactive > 30) {
        warnings.push(
          `Session inactive for ${minutesInactive} minutes - may be stale`
        );
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              success: true,
              sessionId: argsObj.sessionId,
              status: {
                isComplete: session.state.isComplete,
                hasActionUrl: !!session.state.actionUrl,
                hasMasterNode: !!session.state.masterNodeId,
                progressPercent,
                phase: session.state.masterNodeId
                  ? session.state.isComplete
                    ? "complete"
                    : "processing"
                  : "initialization",
              },
              progress: {
                totalNodes,
                resolvedNodes,
                unresolvedNodes,
                currentlyProcessing: session.state.inProcessNodeId,
                toBeProcessed: session.state.toBeProcessedNodes.length,
              },
              sessionInfo: {
                prompt: session.prompt,
                createdAt: session.createdAt,
                lastActivity: session.lastActivity,
                minutesInactive,
                actionUrl: session.state.actionUrl,
              },
              harInfo: {
                totalRequests: session.harData.requests.length,
                totalUrls: session.harData.urls.length,
                quality: session.harData.validation?.quality || "unknown",
                hasCookies: !!session.cookieData,
              },
              nextActions,
              warnings,
              logs: session.state.logs.slice(-5), // Last 5 log entries
            }),
          },
        ],
      };
    } catch (error) {
      throw new HarvestError(
        `Failed to get session status: ${error instanceof Error ? error.message : "Unknown error"}`,
        "SESSION_STATUS_FAILED",
        { originalError: error }
      );
    }
  }

  /**
   * Calculate score for a URL based on heuristics
   */
  private calculateUrlScore(urlInfo: URLInfo): number {
    let score = 0;
    const url = urlInfo.url.toLowerCase();

    // Method preferences
    if (urlInfo.method === "POST") {
      score += 10;
    }

    // API endpoint preferences
    if (url.includes("/api/")) {
      score += 8;
    }
    if (url.includes("/v1/") || url.includes("/v2/")) {
      score += 6;
    }

    // Action keyword preferences
    const actionKeywords = [
      "search",
      "submit",
      "create",
      "update",
      "delete",
      "login",
      "auth",
    ];
    const actionScores = [7, 7, 6, 6, 6, 5, 5];

    for (let i = 0; i < actionKeywords.length; i++) {
      const keyword = actionKeywords[i];
      const actionScore = actionScores[i];
      if (keyword && actionScore !== undefined && url.includes(keyword)) {
        score += actionScore;
      }
    }

    // JSON endpoint preference
    if (url.includes(".json")) {
      score += 4;
    }

    // Static resource penalties
    const staticExtensions = [".css", ".js", ".png", ".jpg", ".ico"];
    const staticKeywords = ["favicon", "analytics", "tracking"];

    for (const ext of staticExtensions) {
      if (url.includes(ext)) {
        score -= 10;
      }
    }

    for (const keyword of staticKeywords) {
      if (url.includes(keyword)) {
        score -= 8;
      }
    }

    // URL length preference
    if (url.length < 100) {
      score += 2;
    }

    return score;
  }

  /**
   * Heuristic URL selection when LLM is not available
   */
  private selectUrlHeuristically(urls: URLInfo[]): string {
    if (urls.length === 0) {
      throw new HarvestError(
        "No URLs available for heuristic selection",
        "NO_URLS_AVAILABLE"
      );
    }

    // Score URLs based on patterns that indicate they're likely action URLs
    const scoredUrls = urls.map((urlInfo) => {
      const score = this.calculateUrlScore(urlInfo);
      return { url: urlInfo.url, score };
    });

    // Sort by score and return the highest scoring URL
    scoredUrls.sort((a, b) => b.score - a.score);

    const selectedUrl = scoredUrls[0]?.url;
    if (!selectedUrl) {
      throw new HarvestError(
        "Could not select a URL heuristically",
        "HEURISTIC_SELECTION_FAILED"
      );
    }

    return selectedUrl;
  }

  /**
   * Handle har_validate tool call
   */
  public async handleHarValidation(args: unknown): Promise<CallToolResult> {
    try {
      const argsObj = args as { harPath: string; detailed: boolean };

      // Parse HAR file to get validation results
      const harData = await parseHARFile(argsObj.harPath);

      // Calculate quality metrics
      const totalRequests = harData.requests.length;
      const totalUrls = harData.urls.length;
      const meaningfulRequests = harData.requests.filter(
        (req) =>
          req.method !== "OPTIONS" &&
          !req.url.includes("favicon") &&
          !req.url.includes("analytics") &&
          !req.url.includes("tracking")
      ).length;

      const score = meaningfulRequests / Math.max(totalRequests, 1);

      // Determine validation result
      const validation = harData.validation || {
        quality: meaningfulRequests > 0 ? "good" : "empty",
        issues: [],
        recommendations: [],
        stats: {
          totalRequests,
          meaningfulRequests,
          score: Math.round(score * 100),
        },
      };

      // Generate suggestions
      const suggestions: string[] = [];
      const issues: string[] = [];

      if (validation.quality === "empty") {
        issues.push("No meaningful requests found in HAR file");
        suggestions.push(
          "Capture a new HAR file while actively using the website"
        );
        suggestions.push(
          "Ensure you submit forms, click buttons, or trigger API calls"
        );
      } else if (validation.quality === "poor") {
        issues.push("Very few meaningful requests captured");
        suggestions.push("Try capturing more extensive interactions");
        suggestions.push(
          "Look for API calls, form submissions, or AJAX requests"
        );
      }

      if (totalRequests > 1000) {
        issues.push("HAR file is very large - may impact analysis performance");
        suggestions.push(
          "Consider filtering the HAR file to specific time periods"
        );
      }

      if (totalUrls === 0) {
        issues.push("No URLs found for analysis");
        suggestions.push("Check if HAR file contains actual network requests");
      }

      // Build detailed analysis if requested
      let detailedAnalysis = {};
      if (argsObj.detailed) {
        const requestsByMethod = harData.requests.reduce(
          (acc, req) => {
            acc[req.method] = (acc[req.method] || 0) + 1;
            return acc;
          },
          {} as Record<string, number>
        );

        const domainBreakdown = harData.requests.reduce(
          (acc, req) => {
            const domain = new URL(req.url).hostname;
            acc[domain] = (acc[domain] || 0) + 1;
            return acc;
          },
          {} as Record<string, number>
        );

        detailedAnalysis = {
          requestsByMethod,
          domainBreakdown,
          sampleUrls: harData.urls.slice(0, 10).map((u) => u.url),
          fileSize: JSON.stringify(harData).length,
          timespan:
            harData.requests.length > 0
              ? {
                  start: harData.requests[0]?.timestamp || new Date(),
                  end:
                    harData.requests[harData.requests.length - 1]?.timestamp ||
                    new Date(),
                }
              : null,
        };
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              success: true,
              harPath: argsObj.harPath,
              validation: {
                quality: validation.quality,
                score: Math.round(score * 100),
                isReady: validation.quality !== "empty",
                issues,
                suggestions,
              },
              metrics: {
                totalRequests,
                meaningfulRequests,
                totalUrls,
                requestScore: Math.round(score * 100),
              },
              ...(argsObj.detailed && { detailed: detailedAnalysis }),
              recommendations: [
                validation.quality === "good"
                  ? "✅ HAR file looks good for analysis"
                  : "⚠️ HAR file may need improvements",
                ...suggestions,
              ],
            }),
          },
        ],
      };
    } catch (error) {
      throw new HarvestError(
        `HAR validation failed: ${error instanceof Error ? error.message : "Unknown error"}`,
        "HAR_VALIDATION_FAILED",
        { originalError: error }
      );
    }
  }

  /**
   * Handle system_config_validate tool call
   */
  public async handleConfigValidation(args: unknown): Promise<CallToolResult> {
    try {
      const argsObj = args as { testApiKey?: string; testProvider?: string };

      // Get configuration status
      const config = validateConfiguration();

      // Test API key if provided
      let testResults:
        | {
            testPassed: boolean;
            testError?: string;
            testProvider?: string;
          }
        | undefined;

      if (argsObj.testApiKey && argsObj.testProvider) {
        try {
          const testClient = createLLMClientWithConfig({
            provider: argsObj.testProvider,
            ...(argsObj.testProvider === "openai" && {
              openaiApiKey: argsObj.testApiKey,
            }),
            ...(argsObj.testProvider === "gemini" && {
              googleApiKey: argsObj.testApiKey,
            }),
          });

          // Test with a simple function call
          await testClient.callFunction(
            "Test configuration",
            {
              name: "test_config",
              description: "Test function for configuration validation",
              parameters: {
                type: "object",
                properties: {
                  status: {
                    type: "string",
                    description: "Configuration test status",
                  },
                },
                required: ["status"],
              },
            },
            "test_config"
          );

          testResults = {
            testPassed: true,
            testProvider: argsObj.testProvider,
          };
        } catch (error) {
          testResults = {
            testPassed: false,
            testError: error instanceof Error ? error.message : "Unknown error",
            testProvider: argsObj.testProvider,
          };
        }
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              success: true,
              timestamp: new Date().toISOString(),
              configuration: {
                isConfigured: config.isConfigured,
                availableProviders: config.availableProviders,
                configuredProviders: config.configuredProviders,
                environmentVariables: {
                  LLM_PROVIDER: !!process.env.LLM_PROVIDER,
                  OPENAI_API_KEY: !!process.env.OPENAI_API_KEY,
                  GOOGLE_API_KEY: !!process.env.GOOGLE_API_KEY,
                  LLM_MODEL: !!process.env.LLM_MODEL,
                },
                recommendations: config.recommendations,
                warnings: config.warnings,
                ...(testResults && { testResults }),
              },
              setupInstructions: {
                forMcpClient: [
                  "Add environment variables to your MCP client configuration:",
                  "{",
                  '  "mcpServers": {',
                  '    "harvest-mcp": {',
                  '      "command": "bun",',
                  '      "args": ["run", "src/server.ts"],',
                  '      "env": {',
                  '        "OPENAI_API_KEY": "your-openai-key",',
                  '        "GOOGLE_API_KEY": "your-google-key",',
                  '        "LLM_PROVIDER": "openai"',
                  "      }",
                  "    }",
                  "  }",
                  "}",
                ],
                forEnvironment: [
                  "Set environment variables in your shell:",
                  "export OPENAI_API_KEY=your-openai-key",
                  "export GOOGLE_API_KEY=your-google-key",
                  "export LLM_PROVIDER=openai",
                ],
                forToolParameters: [
                  "Pass API keys directly to tools:",
                  "workflow_analyze_har(..., openaiApiKey: 'your-key')",
                  "analysis_run_initial_analysis(..., provider: 'openai')",
                ],
              },
            }),
          },
        ],
      };
    } catch (error) {
      throw new HarvestError(
        `Configuration validation failed: ${error instanceof Error ? error.message : "Unknown error"}`,
        "CONFIG_VALIDATION_FAILED",
        { originalError: error }
      );
    }
  }

  /**
   * Handle system_cleanup tool call
   */
  public async handleSystemCleanup(args: unknown): Promise<CallToolResult> {
    try {
      const argsObj = args as { aggressive: boolean };

      const beforeStats = manualSessionManager.getMemoryStats();
      const beforeMemory = beforeStats.current.heapUsed;

      let cleanupResult: CleanupResult;

      if (argsObj.aggressive) {
        cleanupResult = manualSessionManager.performAggressiveCleanup();
      } else {
        cleanupResult = manualSessionManager.performCleanup();
      }

      const afterStats = manualSessionManager.getMemoryStats();
      const afterMemory = afterStats.current.heapUsed;
      const totalReclaimed = beforeMemory - afterMemory;

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              success: true,
              cleanupType: argsObj.aggressive ? "aggressive" : "standard",
              timestamp: new Date().toISOString(),
              results: {
                ...cleanupResult,
                totalMemoryReclaimed: this.formatFileSize(totalReclaimed),
                memoryBefore: this.formatFileSize(beforeMemory),
                memoryAfter: this.formatFileSize(afterMemory),
              },
              newMemoryStatus: this.getMemoryStatus(afterMemory),
              message: argsObj.aggressive
                ? "Aggressive cleanup completed"
                : "Standard cleanup completed",
            }),
          },
        ],
      };
    } catch (error) {
      throw new HarvestError(
        `Failed to perform system cleanup: ${error instanceof Error ? error.message : "Unknown error"}`,
        "SYSTEM_CLEANUP_FAILED",
        { originalError: error }
      );
    }
  }

  /**
   * Generate memory usage recommendations
   */
  private generateMemoryRecommendations(
    memoryStats: ReturnType<typeof manualSessionManager.getMemoryStats>
  ): string[] {
    const recommendations: string[] = [];
    const currentMemoryMB = memoryStats.current.heapUsed / (1024 * 1024);

    if (currentMemoryMB > 500) {
      recommendations.push(
        "🔴 High memory usage detected - consider using system_cleanup"
      );
    } else if (currentMemoryMB > 300) {
      recommendations.push(
        "🟡 Moderate memory usage - monitor for continued growth"
      );
    } else {
      recommendations.push("🟢 Memory usage is within normal range");
    }

    if (memoryStats.activeSessions > 5) {
      recommendations.push(
        "📊 Many active sessions - consider closing unused sessions"
      );
    }

    if (memoryStats.leakDetection.isLeaking) {
      recommendations.push(
        `⚠️ Memory leak detected: ${memoryStats.leakDetection.recommendation}`
      );
    }

    if (memoryStats.snapshotCount > 100) {
      recommendations.push("🗑️ Many memory snapshots - cleanup may help");
    }

    return recommendations;
  }

  /**
   * Get memory status classification
   */
  private getMemoryStatus(
    heapUsed: number
  ): "healthy" | "moderate" | "high" | "critical" {
    const memoryMB = heapUsed / (1024 * 1024);

    if (memoryMB > 800) {
      return "critical";
    }
    if (memoryMB > 500) {
      return "high";
    }
    if (memoryMB > 300) {
      return "moderate";
    }
    return "healthy";
  }

  /**
   * Format file size in human readable format
   */
  private formatFileSize(bytes: number | undefined): string {
    if (!bytes || bytes === 0) {
      return "0 B";
    }

    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));

    return `${(bytes / k ** i).toFixed(1)} ${sizes[i]}`;
  }

  /**
   * Start the server
   */
  async start(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);

    serverLogger.info("Harvest MCP Server started and listening on stdio");
  }
}

// Start the server
const server = new HarvestMCPServer();
server.start().catch((error) => {
  serverLogger.error({ error }, "Failed to start server");
  process.exit(1);
});
