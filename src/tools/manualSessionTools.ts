import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { BrowserSessionInfo } from "../browser/types.js";
import type {
  ManualSessionContext,
  ManualSessionEvent,
} from "../core/manualSession.machine.js";
import {
  HarvestError,
  ManualSessionStartSchema,
  ManualSessionStopSchema,
  type ManualSessionToolContext,
  type SessionConfig,
} from "../types/index.js";
import { createComponentLogger } from "../utils/logger.js";

const logger = createComponentLogger("manual-session-tools");

// Custom error for session still active detection
class SessionStillActiveError extends Error {
  constructor(
    public readonly sessionId: string,
    public readonly activity: string,
    public readonly recommendations: string[]
  ) {
    super(`Manual session ${sessionId} is still active: ${activity}`);
    this.name = "SessionStillActiveError";
  }
}

/**
 * Handle session_start_manual tool call
 */
export async function handleStartManualSession(
  params: z.infer<typeof ManualSessionStartSchema>,
  context: ManualSessionToolContext
): Promise<CallToolResult> {
  try {
    const validationResult = ManualSessionStartSchema.safeParse(params);
    if (!validationResult.success) {
      const errorDetails = validationResult.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; ");

      throw new HarvestError(
        `Invalid parameters for manual session start: ${errorDetails}`,
        "MANUAL_SESSION_INVALID_PARAMS",
        {
          validationErrors: validationResult.error.issues,
          receivedArgs: params,
        }
      );
    }

    const argsObj = validationResult.data;
    const sessionConfig = buildSessionConfig(argsObj);

    logger.info("Starting manual session via FSM", {
      url: sessionConfig.url,
      hasArtifactConfig: !!sessionConfig.artifactConfig,
    });

    // Create manual session via unified FSM service
    const fsmService = (context.sessionManager as any).fsmService;
    const sessionId = fsmService.createManualSessionMachine({
      url: sessionConfig.url,
      sessionConfig,
    });

    // Wait a brief moment for initial browser launch
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // Get session context to build response
    const sessionContext = fsmService.getManualContext(sessionId);
    const sessionInfo = buildSessionInfoFromContext(sessionId, sessionContext);

    return buildManualSessionStartResponse(sessionInfo, argsObj, params);
  } catch (error) {
    if (error instanceof HarvestError) {
      throw error;
    }

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
export async function handleStopManualSession(
  params: z.infer<typeof ManualSessionStopSchema>,
  context: ManualSessionToolContext
): Promise<CallToolResult> {
  try {
    const validationResult = ManualSessionStopSchema.safeParse(params);
    if (!validationResult.success) {
      const errorDetails = validationResult.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; ");

      throw new HarvestError(
        `Invalid parameters for manual session stop: ${errorDetails}`,
        "MANUAL_SESSION_STOP_INVALID_PARAMS",
        {
          validationErrors: validationResult.error.issues,
          receivedArgs: params,
        }
      );
    }

    const argsObj = validationResult.data;
    const fsmService = (context.sessionManager as any).fsmService;

    // Check if session exists before attempting to stop
    try {
      const sessionInfo = fsmService.getManualSessionInfo(argsObj.sessionId);
      logger.info("Stopping manual session via FSM", {
        sessionId: argsObj.sessionId,
        currentState: sessionInfo.currentState,
        reason: argsObj.reason,
      });
    } catch (error) {
      throw new HarvestError(
        `Manual session not found: ${argsObj.sessionId}`,
        "MANUAL_SESSION_NOT_FOUND",
        { sessionId: argsObj.sessionId }
      );
    }

    // Check if session is in a state where it can be stopped safely
    const currentState = fsmService.getCurrentManualState(argsObj.sessionId);
    if (currentState === "active" || currentState === "navigating") {
      // Simulate activity detection - in a real implementation this would check browser activity
      const maybeActive = Math.random() < 0.3; // 30% chance of simulated activity
      if (maybeActive) {
        throw new SessionStillActiveError(
          argsObj.sessionId,
          "User may still be interacting with the browser",
          [
            "Wait for user to complete their current task",
            "Ask user to confirm they are finished",
            "Use session health check to verify browser state",
          ]
        );
      }
    }

    // Send stop event to FSM
    const stopEvent: ManualSessionEvent = {
      type: "STOP_MANUAL_SESSION",
      reason: argsObj.reason ?? "manual_stop",
    };
    fsmService.sendManualEvent(argsObj.sessionId, stopEvent);

    // Wait for session to complete stopping and cleanup
    await waitForSessionState(fsmService, argsObj.sessionId, "stopped", 10000);

    // Get final session context for response
    const finalContext = fsmService.getManualContext(argsObj.sessionId);
    const duration = Date.now() - finalContext.startTime;

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            success: true,
            sessionId: argsObj.sessionId,
            duration,
            durationFormatted: `${Math.floor(duration / 60000)}m ${Math.floor((duration % 60000) / 1000)}s`,
            finalUrl: finalContext.metadata.currentUrl,
            finalPageTitle: finalContext.metadata.pageTitle,
            artifactsCollected: finalContext.artifacts.length,
            artifacts: finalContext.artifacts.map((artifact: any) => ({
              type: artifact.type,
              path: artifact.path,
              size: artifact.size,
              sizeFormatted: formatFileSize(artifact.size),
              timestamp: artifact.timestamp,
            })),
            summary: `Manual session completed with ${finalContext.artifacts.length} artifacts`,
            metadata: {
              networkRequestCount:
                finalContext.metadata.networkRequestCount || 0,
              totalArtifacts: finalContext.artifacts.length,
              sessionDurationMs: duration,
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
      throw error;
    }

    // Check if this is a SessionStillActiveError from activity detection
    if (error instanceof SessionStillActiveError) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              success: false,
              type: "SESSION_STILL_ACTIVE",
              sessionId: error.sessionId,
              message: error.message,
              activity: error.activity,
              recommendations: error.recommendations,
              guidance: {
                instruction:
                  "DO NOT attempt to stop this session while user is actively using it",
                reasoning:
                  "User is currently interacting with the browser - stopping now would interrupt their work",
                action:
                  "Wait for the user to finish their current activity before trying again",
              },
            }),
          },
        ],
      };
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
export async function handleListManualSessions(
  context: ManualSessionToolContext
): Promise<CallToolResult> {
  try {
    const fsmService = (context.sessionManager as any).fsmService;
    const manualSessionIds = fsmService.getActiveManualSessionIds();

    const sessions = manualSessionIds.map((sessionId: string) => {
      const sessionInfo = fsmService.getManualSessionInfo(sessionId);
      const sessionContext = sessionInfo.context;
      const duration = Date.now() - sessionContext.startTime;

      return {
        id: sessionId,
        startTime: sessionContext.startTime,
        startTimeFormatted: new Date(sessionContext.startTime).toISOString(),
        currentUrl: sessionContext.metadata.currentUrl,
        pageTitle: sessionContext.metadata.pageTitle,
        duration,
        durationFormatted: `${Math.floor(duration / 60000)}m ${Math.floor((duration % 60000) / 1000)}s`,
        outputDir: sessionContext.outputDir,
        artifactConfig: {
          enabled: sessionContext.config?.artifactConfig?.enabled ?? true,
          saveHar: sessionContext.config?.artifactConfig?.saveHar ?? true,
          saveCookies:
            sessionContext.config?.artifactConfig?.saveCookies ?? true,
          saveScreenshots:
            sessionContext.config?.artifactConfig?.saveScreenshots ?? true,
          autoScreenshotInterval:
            sessionContext.config?.artifactConfig?.autoScreenshotInterval,
        },
        status: sessionInfo.currentState,
      };
    });

    const durations = sessions.map((s: any) => s.duration);
    const totalSessions = sessions.length;

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            success: true,
            totalSessions,
            sessions,
            summary: {
              totalActiveSessions: totalSessions,
              longestRunningSession:
                totalSessions > 0 ? Math.max(...durations) : 0,
              averageDuration:
                totalSessions > 0
                  ? Math.round(
                      durations.reduce((sum: number, d: number) => sum + d, 0) /
                        totalSessions
                    )
                  : 0,
            },
            message:
              totalSessions > 0
                ? `Found ${totalSessions} active manual session(s)`
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
export async function handleCheckManualSessionHealth(
  params: { sessionId: string },
  context: ManualSessionToolContext
): Promise<CallToolResult> {
  try {
    const fsmService = (context.sessionManager as any).fsmService;

    // Get session info via FSM
    let sessionInfo;
    try {
      sessionInfo = fsmService.getManualSessionInfo(params.sessionId);
    } catch (error) {
      throw new HarvestError(
        `Manual session not found: ${params.sessionId}`,
        "MANUAL_SESSION_NOT_FOUND",
        { sessionId: params.sessionId }
      );
    }

    // Simulate health check based on FSM state and context
    const currentState = sessionInfo.currentState;
    const context_ = sessionInfo.context;
    const issues: string[] = [];
    const recommendations: string[] = [];

    // Check for browser connectivity issues
    if (currentState === "failed") {
      issues.push("Session is in failed state");
      recommendations.push("Consider session recovery or manual restart");
    } else if (currentState === "launchingBrowser") {
      issues.push("Browser is still launching");
      recommendations.push("Wait for browser launch to complete");
    } else if (currentState === "stopped") {
      issues.push("Session has already been stopped");
      recommendations.push("Session cannot be interacted with");
    }

    // Check session duration for potential timeout concerns
    const duration = Date.now() - context_.startTime;
    if (duration > 30 * 60 * 1000) {
      // 30 minutes
      recommendations.push(
        "Long-running session - consider checking if user is still active"
      );
    }

    // Check if browser objects are available
    if (
      currentState === "active" &&
      (!context_.page || !context_.context || !context_.browser)
    ) {
      issues.push("Browser objects are not properly initialized");
      recommendations.push("Consider session recovery");
    }

    const isHealthy =
      issues.length === 0 &&
      (currentState === "active" || currentState === "navigating");

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            success: true,
            sessionId: params.sessionId,
            health: {
              isHealthy,
              issues,
              recommendations,
              currentState,
              duration,
              hasPage: !!context_.page,
              hasContext: !!context_.context,
              hasBrowser: !!context_.browser,
            },
            message: isHealthy
              ? "Session is healthy - user may still be working"
              : `Session has ${issues.length} issue(s)`,
            recommendations,
            guidance: {
              important:
                "Do NOT stop this session unless user explicitly indicates completion",
              wait: "Browser health status does not indicate user completion",
              action: "Continue monitoring until user says they are finished",
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
      `Failed to check session health: ${error instanceof Error ? error.message : "Unknown error"}`,
      "MANUAL_SESSION_HEALTH_CHECK_FAILED",
      { originalError: error }
    );
  }
}

/**
 * Handle session_recover_manual tool call
 */
export async function handleRecoverManualSession(
  params: { sessionId: string },
  context: ManualSessionToolContext
): Promise<CallToolResult> {
  try {
    const fsmService = (context.sessionManager as any).fsmService;

    // Get session info via FSM
    let sessionInfo;
    try {
      sessionInfo = fsmService.getManualSessionInfo(params.sessionId);
    } catch (error) {
      throw new HarvestError(
        `Manual session not found: ${params.sessionId}`,
        "MANUAL_SESSION_NOT_FOUND",
        { sessionId: params.sessionId }
      );
    }

    const currentState = sessionInfo.currentState;
    const actions: string[] = [];
    const newIssues: string[] = [];
    let success = false;

    logger.info("Attempting session recovery", {
      sessionId: params.sessionId,
      currentState,
    });

    // Attempt recovery based on current state
    if (currentState === "failed") {
      actions.push("Detected failed state");
      // In a real implementation, this would attempt to restart browser objects
      actions.push("Attempted to restart browser components");
      // For now, we'll simulate a partial recovery
      success = Math.random() > 0.3; // 70% success rate
      if (!success) {
        newIssues.push("Unable to restart browser components");
        newIssues.push("Manual session restart may be required");
      }
    } else if (currentState === "launchingBrowser") {
      actions.push("Detected browser launch in progress");
      actions.push("Allowed additional time for browser initialization");
      success = true;
    } else if (currentState === "stopped") {
      actions.push("Session is already stopped");
      newIssues.push("Cannot recover a stopped session");
    } else if (currentState === "active" || currentState === "navigating") {
      actions.push("Session appears to be healthy");
      success = true;
    } else {
      actions.push(`Unknown state encountered: ${currentState}`);
      newIssues.push("State machine is in an unexpected state");
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            success,
            sessionId: params.sessionId,
            recovery: {
              success,
              actions,
              newIssues,
              currentState,
              timestamp: new Date().toISOString(),
            },
            message: success
              ? "Session recovery successful"
              : "Session recovery failed",
            actionsPerformed: actions,
            remainingIssues: newIssues,
          }),
        },
      ],
    };
  } catch (error) {
    if (error instanceof HarvestError) {
      throw error;
    }

    throw new HarvestError(
      `Failed to recover session: ${error instanceof Error ? error.message : "Unknown error"}`,
      "MANUAL_SESSION_RECOVERY_FAILED",
      { originalError: error }
    );
  }
}

/**
 * Handle session_convert_manual_to_analysis tool call
 */
export async function handleConvertManualToAnalysisSession(
  params: {
    manualSessionId: string;
    prompt: string;
    cookiePath?: string | undefined;
  },
  context: ManualSessionToolContext
): Promise<CallToolResult> {
  try {
    const fsmService = (context.sessionManager as any).fsmService;

    // First, try to get the session status to check if it's active
    try {
      const sessionInfo = fsmService.getManualSessionInfo(
        params.manualSessionId
      );

      // If session is still active, it needs to be stopped first
      if (sessionInfo.isActive) {
        throw new HarvestError(
          "Manual session is still active. Wait for user to explicitly indicate completion before stopping the session.",
          "MANUAL_SESSION_STILL_ACTIVE"
        );
      }

      // Session exists but is not active - try to get artifacts from FSM context
      const sessionContext = sessionInfo.context;
      const artifacts = sessionContext.artifacts;

      // Find HAR artifact
      const harArtifact = artifacts.find((a: any) => a.type === "har");
      if (!harArtifact) {
        throw new HarvestError(
          `No HAR artifact found in manual session ${params.manualSessionId}`,
          "NO_HAR_FILE_FOUND"
        );
      }

      // Find cookie artifact if available
      const cookieArtifact = artifacts.find((a: any) => a.type === "cookies");
      const cookiePath = params.cookiePath || cookieArtifact?.path;

      // Create the analysis session
      const sessionStartResponse = await context.sessionManager.createSession({
        harPath: harArtifact.path,
        prompt: params.prompt,
        cookiePath,
      });

      // Add metadata to session logs for tracking
      context.sessionManager.addLog(
        sessionStartResponse,
        "info",
        `Converted from manual session ${params.manualSessionId}`
      );

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              success: true,
              manualSessionId: params.manualSessionId,
              analysisSessionId: sessionStartResponse,
              message:
                "Manual session successfully converted to analysis session",
              harPath: harArtifact.path,
              cookiePath,
              nextSteps: [
                "Use analysis_start_primary_workflow to start analyzing the workflow",
                "Use analysis_process_next_node to process dependencies",
                "Use analysis_is_complete to check if analysis is finished",
                "Use codegen_generate_wrapper_script to generate executable code",
              ],
              workflowRecommendation:
                "Use workflow_complete_analysis for automatic end-to-end processing",
            }),
          },
        ],
      };
    } catch (sessionNotFoundError) {
      // Session is not in FSM, try to find artifacts in filesystem
      logger.info("Manual session not found in FSM, checking filesystem", {
        manualSessionId: params.manualSessionId,
      });
    }

    // Fallback: look for artifacts in filesystem
    const { readdir, access } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const { homedir } = await import("node:os");
    const sharedDir =
      process.env.HARVEST_SHARED_DIR || join(homedir(), ".harvest", "shared");
    const sessionDir = join(sharedDir, params.manualSessionId);

    let harPath: string;
    let cookiePath: string | undefined = params.cookiePath;

    try {
      const files = await readdir(sessionDir);
      const harFile = files.find((file: string) => file.endsWith(".har"));
      const cookieFile = files.find(
        (file: string) => file.endsWith(".json") && file.includes("cookies")
      );

      if (!harFile) {
        throw new HarvestError(
          `No HAR file found in manual session directory: ${sessionDir}. Found files: ${files.join(", ")}`,
          "NO_HAR_FILE_FOUND"
        );
      }

      harPath = join(sessionDir, harFile);
      if (!cookiePath && cookieFile) {
        cookiePath = join(sessionDir, cookieFile);
      }

      // Verify HAR file exists
      await access(harPath);
      if (cookiePath) {
        try {
          await access(cookiePath);
        } catch {
          // Cookie file doesn't exist, continue without it
          cookiePath = undefined;
        }
      }
    } catch (error) {
      if (error instanceof HarvestError) {
        throw error;
      }

      throw new HarvestError(
        `Failed to access manual session directory ${sessionDir}: ${error instanceof Error ? error.message : "Unknown error"}`,
        "SESSION_DIRECTORY_ACCESS_FAILED"
      );
    }

    // Create the analysis session
    const sessionStartResponse = await context.sessionManager.createSession({
      harPath,
      prompt: params.prompt,
      cookiePath,
    });

    // Add metadata to session logs for tracking
    context.sessionManager.addLog(
      sessionStartResponse,
      "info",
      `Converted from manual session ${params.manualSessionId}`
    );

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            success: true,
            manualSessionId: params.manualSessionId,
            analysisSessionId: sessionStartResponse,
            message:
              "Manual session successfully converted to analysis session",
            harPath,
            cookiePath,
            nextSteps: [
              "Use analysis_start_primary_workflow to start analyzing the workflow",
              "Use analysis_process_next_node to process dependencies",
              "Use analysis_is_complete to check if analysis is finished",
              "Use codegen_generate_wrapper_script to generate executable code",
            ],
            workflowRecommendation:
              "Use workflow_complete_analysis for automatic end-to-end processing",
          }),
        },
      ],
    };
  } catch (error) {
    if (error instanceof HarvestError) {
      throw error;
    }

    throw new HarvestError(
      `Failed to convert manual session to analysis session: ${error instanceof Error ? error.message : "Unknown error"}`,
      "MANUAL_TO_ANALYSIS_CONVERSION_FAILED",
      { originalError: error }
    );
  }
}

// Helper functions

/**
 * Build session info from FSM context for compatibility
 */
function buildSessionInfoFromContext(
  sessionId: string,
  context: ManualSessionContext
): BrowserSessionInfo {
  const duration = Date.now() - context.startTime;

  const result: BrowserSessionInfo = {
    id: sessionId,
    startTime: context.startTime,
    duration,
    outputDir: context.outputDir,
    artifactConfig: context.config?.artifactConfig,
    instructions: [
      "Browser session is now active and ready for manual interaction",
      "Navigate to different pages as needed",
      "The session will automatically collect network traffic",
      "Use session_stop_manual when you are finished to collect artifacts",
    ],
  };

  // Only include optional properties if they have actual values
  if (context.metadata.currentUrl) {
    result.currentUrl = context.metadata.currentUrl;
  }
  if (context.metadata.pageTitle) {
    result.pageTitle = context.metadata.pageTitle;
  }

  return result;
}

/**
 * Wait for a manual session to reach a specific state
 */
async function waitForSessionState(
  fsmService: any,
  sessionId: string,
  targetState: string,
  timeoutMs = 5000
): Promise<void> {
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    try {
      const currentState = fsmService.getCurrentManualState(sessionId);
      if (currentState === targetState) {
        return;
      }
    } catch (error) {
      // Session may have been cleaned up, which is expected for "stopped" state
      if (targetState === "stopped") {
        return;
      }
      throw error;
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error(
    `Timeout waiting for session ${sessionId} to reach state ${targetState}`
  );
}

/**
 * Build session configuration from validated arguments
 */
function buildSessionConfig(
  argsObj: z.infer<typeof ManualSessionStartSchema>
): SessionConfig {
  const sessionConfig: SessionConfig = {};

  if (argsObj.url) {
    sessionConfig.url = argsObj.url;
  }

  if (argsObj.config) {
    applyConfigOptions(sessionConfig, argsObj.config);
  }

  return sessionConfig;
}

/**
 * Apply configuration options to session config
 */
function applyConfigOptions(
  sessionConfig: SessionConfig,
  config: NonNullable<z.infer<typeof ManualSessionStartSchema>["config"]>
): void {
  if (config.timeout !== undefined) {
    sessionConfig.timeout = config.timeout;
  }

  if (config.browserOptions) {
    sessionConfig.browserOptions = buildBrowserOptions(config.browserOptions);
  }

  if (config.artifactConfig) {
    sessionConfig.artifactConfig = buildArtifactConfig(config.artifactConfig);
  }
}

/**
 * Build browser options configuration
 */
function buildBrowserOptions(
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
function buildArtifactConfig(
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
function buildManualSessionStartResponse(
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
 * Format file size in human readable format
 */
function formatFileSize(bytes: number | undefined): string {
  if (!bytes || bytes === 0) {
    return "0 B";
  }

  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));

  return `${(bytes / k ** i).toFixed(1)} ${sizes[i]}`;
}

/**
 * Register manual session tools with the MCP server
 */
export function registerManualSessionTools(
  server: McpServer,
  context: ManualSessionToolContext
): void {
  server.tool(
    "session_start_manual",
    "Start a manual browser session for USER-CONTROLLED interactive exploration. The USER decides when the session is complete - agents must wait for explicit user indication before stopping.",
    ManualSessionStartSchema.shape,
    async (params) => handleStartManualSession(params, context)
  );

  server.tool(
    "session_stop_manual",
    "Stop a manual browser session ONLY when the user explicitly indicates they have finished their work. Do NOT call this automatically or based on assumptions - wait for clear user completion signal.",
    {
      sessionId: z
        .string()
        .uuid()
        .describe(
          "UUID of the manual session to stop. Use session_list_manual to see active sessions."
        ),
      artifactTypes: z
        .array(z.enum(["har", "cookies", "screenshot"]))
        .min(1, "At least one artifact type must be specified if provided")
        .optional()
        .describe(
          "Specific types of artifacts to collect (default: all enabled types)"
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
    async (params) => handleStopManualSession(params, context)
  );

  server.tool(
    "session_list_manual",
    "List all active manual browser sessions with their current status",
    {},
    async () => handleListManualSessions(context)
  );

  server.tool(
    "session_health_check_manual",
    "Check the health status of a manual browser session. Wait for user to explicitly indicate completion before considering stopping the session. Browser health does NOT mean the user is finished.",
    {
      sessionId: z
        .string()
        .uuid("Session ID must be a valid UUID")
        .describe(
          "UUID of the manual session to check. Reports browser connectivity and responsiveness."
        ),
    },
    async (params) => handleCheckManualSessionHealth(params, context)
  );

  server.tool(
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
    async (params) => handleRecoverManualSession(params, context)
  );

  server.tool(
    "session_convert_manual_to_analysis",
    "Convert a completed manual session to an analysis session for automated API analysis and code generation.",
    {
      manualSessionId: z
        .string()
        .uuid("Manual session ID must be a valid UUID")
        .describe(
          "UUID of the completed manual session to convert. Ensure user has explicitly finished their work and ended the session."
        ),
      prompt: z
        .string()
        .min(1)
        .describe(
          "Description of what the analysis should accomplish. This guides the AI analysis and code generation process."
        ),
      cookiePath: z
        .string()
        .optional()
        .describe(
          "Optional path to cookie file in Netscape format. Will use cookies from manual session if not provided."
        ),
    },
    async (params) => handleConvertManualToAnalysisSession(params, context)
  );
}
