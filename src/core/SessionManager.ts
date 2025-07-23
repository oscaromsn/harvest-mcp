// Removed unused uuidv4 import since FSM service now generates IDs
import { analyzeAuthentication } from "../agents/AuthenticationAgent.js";
import { getConfig } from "../config/index.js";
import {
  type AuthenticationAnalysis,
  type CompletionAnalysis,
  type HarvestSession,
  type LogEntry,
  type SessionInfo,
  SessionNotFoundError,
  type SessionStartParams,
} from "../types/index.js";
import { createComponentLogger } from "../utils/logger.js";
import { SessionFsmService } from "./SessionFsmService.js";

const logger = createComponentLogger("session-manager");

export class SessionManager {
  private readonly maxSessions: number;
  private readonly cleanupIntervalMs: number;
  public readonly fsmService: SessionFsmService;

  constructor() {
    // Initialize FSM service
    this.fsmService = new SessionFsmService();

    // Get configuration values or use defaults
    try {
      const config = getConfig();
      this.maxSessions = config.session.maxSessions;
      this.cleanupIntervalMs =
        config.session.cleanupIntervalMinutes * 60 * 1000;
    } catch {
      // Fallback to hardcoded defaults if config not available
      this.maxSessions = 100;
      this.cleanupIntervalMs = 5 * 60 * 1000; // 5 minutes
    }

    // Set up periodic cleanup
    setInterval(() => this.cleanupExpiredSessions(), this.cleanupIntervalMs);
  }

  /**
   * Create a new analysis session using the FSM service
   */
  async createSession(params: SessionStartParams): Promise<string> {
    this.ensureCapacity();

    try {
      // Create the session using the FSM service
      const sessionId = this.fsmService.createSessionMachine(params);

      // Wait for the machine to process the START_SESSION event and transition out of initializing
      await this.waitForMachineInitialization(sessionId);

      // Session state is now managed entirely by the FSM service
      // No need to maintain a separate sessions map

      logger.info("Session created successfully", {
        sessionId,
        harPath: params.harPath,
        currentState: this.fsmService.getCurrentState(sessionId),
      });

      return sessionId;
    } catch (error) {
      throw new Error(
        `Failed to create session: ${error instanceof Error ? error.message : "Unknown error"}`
      );
    }
  }

  /**
   * Ensure session capacity by cleaning up expired sessions
   */
  private ensureCapacity(): void {
    const currentSessionCount = this.fsmService.getActiveSessionCount();
    if (currentSessionCount >= this.maxSessions) {
      this.cleanupExpiredSessions();

      if (this.fsmService.getActiveSessionCount() >= this.maxSessions) {
        this.removeOldestSession();
      }
    }
  }

  // parseHARWithValidation method removed - now handled by FSM service

  /**
   * Transform Zod schema to match HARParsingOptions interface
   */

  /**
   * Get a session by ID
   */
  getSession(sessionId: string): HarvestSession {
    // Query FSM service directly for session data
    try {
      const context = this.fsmService.getContext(sessionId);
      const state = this.fsmService.getCurrentState(sessionId);

      // Construct HarvestSession directly from FSM context
      const session: HarvestSession = {
        id: sessionId,
        prompt: context.prompt,
        harData: context.harData as any, // Keep as any for backward compatibility
        cookieData: context.cookieData as any,
        dagManager: context.dagManager as any,
        fsm: this.fsmService.getSessionMachine(sessionId),
        workflowGroups: context.workflowGroups as any,
        selectedWorkflowId: context.activeWorkflowId,
        createdAt: new Date(), // Approximation - FSM doesn't track creation time
        lastActivity: new Date(),
        state: {
          activeWorkflowId: context.activeWorkflowId,
          workflowGroups: context.workflowGroups as any,
          toBeProcessedNodes: context.toBeProcessedNodes,
          inProcessNodeDynamicParts: context.inProcessNodeDynamicParts,
          inputVariables: context.inputVariables,
          authAnalysis: context.authAnalysis as any,
          logs: context.logs as any,
          isComplete: state === "codeGenerated" || state === "readyForCodeGen",
          masterNodeId: context.activeWorkflowId
            ? (context.workflowGroups as any)?.get(context.activeWorkflowId)
                ?.masterNodeId
            : undefined,
          actionUrl: context.activeWorkflowId
            ? (context.workflowGroups as any)?.get(context.activeWorkflowId)
                ?.masterNodeId
            : undefined,
        },
      };

      return session;
    } catch (_error) {
      throw new SessionNotFoundError(sessionId);
    }
  }

  /**
   * Check if a session exists
   */
  hasSession(sessionId: string): boolean {
    try {
      this.fsmService.getSessionMachine(sessionId);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Delete a session
   */
  deleteSession(sessionId: string): boolean {
    return this.fsmService.removeSession(sessionId);
  }

  /**
   * List all active sessions
   */
  listSessions(): SessionInfo[] {
    const sessionInfos: SessionInfo[] = [];
    const activeSessionIds = this.fsmService.getActiveSessionIds();

    for (const sessionId of activeSessionIds) {
      try {
        const context = this.fsmService.getContext(sessionId);
        sessionInfos.push({
          id: sessionId,
          prompt: context.prompt,
          createdAt: new Date(), // Approximation - FSM doesn't track creation time
          lastActivity: new Date(),
          isComplete: this.fsmService.isAnalysisComplete(sessionId),
          nodeCount: (context.dagManager as any)?.getNodeCount() || 0,
        });
      } catch (_error) {
        // Skip invalid sessions
        logger.warn("Skipping invalid session in listSessions", { sessionId });
      }
    }

    // Sort by last activity (most recent first)
    return sessionInfos.sort(
      (a, b) => b.lastActivity.getTime() - a.lastActivity.getTime()
    );
  }

  /**
   * Get all session IDs
   */
  getAllSessionIds(): string[] {
    return this.fsmService.getActiveSessionIds();
  }

  /**
   * Add a log entry to a session
   */
  addLog(
    sessionId: string,
    level: LogEntry["level"],
    message: string,
    data?: unknown
  ): void {
    try {
      // Get current FSM context
      const context = this.fsmService.getContext(sessionId);

      const logEntry: LogEntry = {
        timestamp: new Date(),
        level,
        message,
        data,
      };

      // Add log directly to FSM context
      // Note: This is a temporary approach until we implement proper log events
      const updatedLogs = [...context.logs, logEntry];

      // Keep only last 1000 log entries to prevent memory bloat
      if (updatedLogs.length > 1000) {
        updatedLogs.splice(0, updatedLogs.length - 1000);
      }

      // Update the FSM context logs directly (this is a known limitation)
      context.logs = updatedLogs;
    } catch (_error) {
      // Session doesn't exist, ignore the log
      logger.warn("Failed to add log to non-existent session", { sessionId });
    }
  }

  /**
   * Get session logs
   */
  getSessionLogs(sessionId: string): LogEntry[] {
    try {
      const context = this.fsmService.getContext(sessionId);
      return [...context.logs]; // Return a copy
    } catch (_error) {
      throw new SessionNotFoundError(sessionId);
    }
  }

  /**
   * Clean up expired sessions
   */
  private cleanupExpiredSessions(): void {
    // TODO: Implement cleanup based on FSM session timestamps
    // For now, cleanup is disabled as FSM doesn't track lastActivity
    logger.debug(
      "Session cleanup temporarily disabled - needs FSM-based implementation"
    );
  }

  /**
   * Remove the oldest session to make room for new ones
   */
  private removeOldestSession(): void {
    // TODO: Implement FSM-based oldest session removal
    // For now, remove a random session as fallback
    const sessionIds = this.fsmService.getActiveSessionIds();
    if (sessionIds.length > 0) {
      const sessionToRemove = sessionIds[0];
      if (sessionToRemove) {
        this.fsmService.removeSession(sessionToRemove);
        logger.info(
          { sessionId: sessionToRemove },
          "Removed session to make room (FSM-based cleanup needs improvement)"
        );
      }
    }
  }

  /**
   * Get session statistics
   */
  getStats(): {
    totalSessions: number;
    completedSessions: number;
    activeSessions: number;
    averageNodeCount: number;
  } {
    const sessionIds = this.fsmService.getActiveSessionIds();
    const totalSessions = sessionIds.length;
    let completedSessions = 0;
    let totalNodes = 0;

    for (const sessionId of sessionIds) {
      try {
        const isComplete = this.fsmService.isAnalysisComplete(sessionId);
        const context = this.fsmService.getContext(sessionId);

        if (isComplete) {
          completedSessions++;
        }
        totalNodes += context.dagManager.getNodeCount();
      } catch (_error) {
        // Skip invalid sessions
        logger.warn("Skipping invalid session in getStats", { sessionId });
      }
    }

    const activeSessions = totalSessions - completedSessions;
    const averageNodeCount = totalNodes / Math.max(totalSessions, 1);

    return {
      totalSessions,
      completedSessions,
      activeSessions,
      averageNodeCount: Math.round(averageNodeCount * 100) / 100,
    };
  }

  /**
   * Repopulate processing queue with unresolved nodes
   */
  repopulateProcessingQueue(sessionId: string): {
    success: boolean;
    addedNodes: number;
    message: string;
  } {
    try {
      const session = this.getSession(sessionId);
      const unresolvedNodes = session.dagManager.getUnresolvedNodes();

      // Clear current queue and repopulate
      session.state.toBeProcessedNodes = [];
      for (const node of unresolvedNodes) {
        session.state.toBeProcessedNodes.push(node.nodeId);
      }

      this.addLog(
        sessionId,
        "info",
        `Repopulated processing queue with ${unresolvedNodes.length} unresolved nodes`
      );

      return {
        success: true,
        addedNodes: unresolvedNodes.length,
        message: `Successfully added ${unresolvedNodes.length} nodes to processing queue`,
      };
    } catch (error) {
      this.addLog(
        sessionId,
        "error",
        `Failed to repopulate queue: ${error instanceof Error ? error.message : "Unknown error"}`
      );

      return {
        success: false,
        addedNodes: 0,
        message: `Failed to repopulate queue: ${error instanceof Error ? error.message : "Unknown error"}`,
      };
    }
  }

  /**
   * Manually add a specific node to the processing queue
   */
  addNodeToQueue(
    sessionId: string,
    nodeId: string
  ): {
    success: boolean;
    message: string;
  } {
    try {
      const session = this.getSession(sessionId);

      // Check if node exists in DAG by checking unresolved nodes and DAG
      const allNodes = session.dagManager
        .getUnresolvedNodes()
        .map((n) => n.nodeId);
      const nodeExists = allNodes.includes(nodeId);
      if (!nodeExists) {
        return {
          success: false,
          message: `Node ${nodeId} not found in dependency graph`,
        };
      }

      // Check if node is already in queue
      if (session.state.toBeProcessedNodes.includes(nodeId)) {
        return {
          success: false,
          message: `Node ${nodeId} is already in processing queue`,
        };
      }

      // Add to queue
      session.state.toBeProcessedNodes.push(nodeId);

      this.addLog(
        sessionId,
        "info",
        `Manually added node ${nodeId} to processing queue`
      );

      return {
        success: true,
        message: `Successfully added node ${nodeId} to processing queue`,
      };
    } catch (error) {
      return {
        success: false,
        message: `Failed to add node to queue: ${error instanceof Error ? error.message : "Unknown error"}`,
      };
    }
  }

  /**
   * Get queue status and recovery options
   */
  getQueueStatus(sessionId: string): {
    queueLength: number;
    unresolvedNodeCount: number;
    canRepopulate: boolean;
    recommendations: string[];
  } {
    try {
      const session = this.getSession(sessionId);
      const unresolvedNodes = session.dagManager.getUnresolvedNodes();
      const queueLength = session.state.toBeProcessedNodes.length;
      const unresolvedNodeCount = unresolvedNodes.length;

      const recommendations: string[] = [];

      if (queueLength === 0 && unresolvedNodeCount > 0) {
        recommendations.push(
          "Queue is empty but unresolved nodes exist - use repopulateProcessingQueue"
        );
      }

      if (queueLength > 0 && unresolvedNodeCount === 0) {
        recommendations.push(
          "Queue has nodes but all nodes are resolved - clear queue or investigate"
        );
      }

      if (queueLength === 0 && unresolvedNodeCount === 0) {
        recommendations.push(
          "Analysis appears complete - use codegen_generate_wrapper_script"
        );
      }

      return {
        queueLength,
        unresolvedNodeCount,
        canRepopulate: unresolvedNodeCount > 0,
        recommendations,
      };
    } catch (_error) {
      return {
        queueLength: 0,
        unresolvedNodeCount: 0,
        canRepopulate: false,
        recommendations: [
          `Error getting queue status: ${_error instanceof Error ? _error.message : "Unknown error"}`,
        ],
      };
    }
  }

  /**
   * Enhanced completion state analysis using FSM service
   * This replaces the complex imperative logic with deterministic state machine queries
   */
  analyzeCompletionState(sessionId: string): CompletionAnalysis {
    try {
      // Use the FSM service to get completion analysis
      return this.fsmService.getCompletionAnalysis(sessionId);
    } catch (error) {
      logger.error("Failed to analyze completion state", {
        sessionId,
        error: error instanceof Error ? error.message : "Unknown error",
      });

      // Return default analysis on error
      return {
        isComplete: false,
        blockers: ["Failed to analyze session state"],
        recommendations: ["Check session exists and is properly initialized"],
        diagnostics: {
          hasMasterNode: false,
          dagComplete: false,
          queueEmpty: false,
          totalNodes: 0,
          unresolvedNodes: 0,
          pendingInQueue: 0,
          hasActionUrl: false,
          authAnalysisComplete: false,
          authReadiness: false,
          authErrors: 0,
          allNodesClassified: false,
          nodesNeedingClassification: 0,
          bootstrapAnalysisComplete: false,
          sessionConstantsCount: 0,
          unresolvedSessionConstants: 0,
        },
      };
    }
  }

  /**
   * Check if a session is complete using FSM state
   */
  isComplete(sessionId: string): boolean {
    try {
      return this.fsmService.isAnalysisComplete(sessionId);
    } catch (error) {
      logger.error("Failed to check session completion", {
        sessionId,
        error: error instanceof Error ? error.message : "Unknown error",
      });
      return false;
    }
  }

  /**
   * Set master node ID in both legacy state and workflow groups
   */
  setMasterNodeId(sessionId: string, nodeId: string): void {
    try {
      const session = this.getSession(sessionId);
      session.state.masterNodeId = nodeId;

      // Also update the workflow groups if active workflow exists
      if (session.state.activeWorkflowId) {
        const workflow = session.state.workflowGroups.get(
          session.state.activeWorkflowId
        );
        if (workflow) {
          workflow.masterNodeId = nodeId;
        }
      }

      logger.debug("Master node ID updated", { sessionId, nodeId });
    } catch (error) {
      logger.error("Failed to set master node ID", {
        sessionId,
        nodeId,
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }

  /**
   * Set action URL in both legacy state and workflow groups
   */
  setActionUrl(sessionId: string, actionUrl: string): void {
    try {
      const session = this.getSession(sessionId);
      session.state.actionUrl = actionUrl;

      logger.debug("Action URL updated", { sessionId, actionUrl });
    } catch (error) {
      logger.error("Failed to set action URL", {
        sessionId,
        actionUrl,
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }

  /**
   * Send an event to the session's FSM
   */
  sendFsmEvent(
    sessionId: string,
    event: { type: string; [key: string]: unknown }
  ): void {
    try {
      this.fsmService.sendEvent(
        sessionId,
        event as unknown as Parameters<typeof this.fsmService.sendEvent>[1]
      );

      logger.debug("FSM event sent", { sessionId, eventType: event.type });
    } catch (error) {
      logger.error("Failed to send FSM event", {
        sessionId,
        eventType: event.type,
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }

  /**
   * Get the current FSM state of a session
   */
  getFsmState(sessionId: string): string {
    try {
      return this.fsmService.getCurrentState(sessionId);
    } catch (error) {
      logger.error("Failed to get FSM state", {
        sessionId,
        error: error instanceof Error ? error.message : "Unknown error",
      });
      return "unknown";
    }
  }

  /**
   * Get FSM context directly - preferred over accessing session.state
   */
  getFsmContext(sessionId: string) {
    return this.fsmService.getContext(sessionId);
  }

  /**
   * Get FSM service for direct access - useful for tool handlers migrating from legacy patterns
   */
  getFsmService() {
    return this.fsmService;
  }

  /**
   * Analyze authentication readiness for code generation
   */
  private analyzeAuthenticationReadiness(session: HarvestSession): {
    analysisComplete: boolean;
    isReady: boolean;
    errorCount: number;
    blockers: string[];
    recommendations: string[];
    warnings: string[];
  } {
    const analysis = {
      analysisComplete: false,
      isReady: false,
      errorCount: 0,
      blockers: [] as string[],
      recommendations: [] as string[],
      warnings: [] as string[],
    };

    // Check if authentication analysis has been performed
    const authAnalysis = session.state.authAnalysis;
    const harValidation = session.harData.validation;

    if (authAnalysis) {
      // Full authentication analysis has been performed
      analysis.analysisComplete = true;

      // Check for authentication failures
      if (authAnalysis.failedAuthRequests.length > 0) {
        analysis.errorCount = authAnalysis.failedAuthRequests.length;
        analysis.blockers.push(
          `Found ${authAnalysis.failedAuthRequests.length} authentication failures`
        );
        analysis.recommendations.push(
          "Fix authentication failures before code generation"
        );
        analysis.recommendations.push(
          "Ensure all authentication tokens are valid and not expired"
        );
      }

      // Check code generation readiness
      if (!authAnalysis.codeGeneration.isReady) {
        analysis.blockers.push("Authentication not ready for code generation");
        analysis.recommendations.push(
          ...authAnalysis.codeGeneration.requiredSetup
        );
      }

      // Add security warnings
      if (authAnalysis.securityIssues.length > 0) {
        analysis.warnings.push(...authAnalysis.securityIssues);
      }

      // Check for hardcoded tokens that need manual setup
      if (authAnalysis.codeGeneration.hardcodedTokens.length > 0) {
        analysis.warnings.push(
          `Found ${authAnalysis.codeGeneration.hardcodedTokens.length} authentication tokens that require manual configuration`
        );
        analysis.recommendations.push(
          "Configure authentication tokens before using generated code"
        );
      }

      analysis.isReady = analysis.blockers.length === 0;
    } else if (harValidation?.authAnalysis) {
      // Check if HAR validation detected authentication issues
      const harAuthAnalysis = harValidation.authAnalysis;

      if (harAuthAnalysis.failedAuthRequests.length > 0) {
        analysis.errorCount = harAuthAnalysis.failedAuthRequests.length;
        analysis.blockers.push(
          `Found ${harAuthAnalysis.failedAuthRequests.length} authentication errors in HAR data`
        );
        analysis.recommendations.push(
          "Verify authentication tokens are valid and not expired"
        );
        analysis.recommendations.push(
          "Re-capture HAR data with valid authentication"
        );
      }

      if (harAuthAnalysis.tokens.length > 0) {
        analysis.warnings.push(
          "Authentication tokens detected in requests - ensure they are handled dynamically"
        );
      }

      if (!harAuthAnalysis.hasAuthentication) {
        analysis.warnings.push(
          "No authentication mechanisms detected - API may be public or authentication was not captured"
        );
      }

      analysis.analysisComplete = true;
      analysis.isReady = analysis.blockers.length === 0;
    } else {
      analysis.blockers.push("Authentication analysis not performed");
      analysis.recommendations.push(
        "Run authentication analysis to detect requirements"
      );
    }

    return analysis;
  }

  /**
   * Run comprehensive authentication analysis on a session
   */
  async runAuthenticationAnalysis(sessionId: string): Promise<{
    success: boolean;
    authAnalysis?: AuthenticationAnalysis;
    error?: string;
  }> {
    try {
      const session = this.getSession(sessionId);

      this.addLog(
        sessionId,
        "info",
        "Starting comprehensive authentication analysis"
      );

      // Run authentication analysis using the new AuthenticationAgent
      const authAnalysis = await analyzeAuthentication(session);

      // Store the analysis in session state
      session.state.authAnalysis = authAnalysis;

      // Update authentication readiness
      const readiness = this.analyzeAuthenticationReadiness(session);
      session.state.authReadiness = {
        isAuthComplete: readiness.isReady,
        authBlockers: readiness.blockers,
        authRecommendations: readiness.recommendations,
      };

      this.addLog(
        sessionId,
        "info",
        `Authentication analysis complete: ${authAnalysis.authTypes.join(", ")} detected, ` +
          `${authAnalysis.tokens.length} tokens found, ` +
          `${authAnalysis.failedAuthRequests.length} auth failures`
      );

      return {
        success: true,
        authAnalysis,
      };
    } catch (_error) {
      const errorMessage =
        _error instanceof Error ? _error.message : "Unknown error";
      this.addLog(
        sessionId,
        "error",
        `Authentication analysis failed: ${errorMessage}`
      );

      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  /**
   * Get detailed state transition guidance for users
   */
  getStateTransitionGuidance(sessionId: string): {
    currentState: string;
    nextActions: string[];
    progressSummary: string;
    estimatedCompletion: number; // 0-100 percentage
  } {
    try {
      const analysis = this.analyzeCompletionState(sessionId);
      this.getSession(sessionId);

      let currentState: string;
      let nextActions: string[] = [];
      let estimatedCompletion = 0;

      if (!analysis.diagnostics.hasMasterNode) {
        currentState = "NEEDS_INITIAL_ANALYSIS";
        nextActions = [
          "Run 'analysis_start_primary_workflow' to identify target action URL",
        ];
        estimatedCompletion = 10;
      } else if (
        analysis.diagnostics.unresolvedNodes > 0 ||
        analysis.diagnostics.pendingInQueue > 0
      ) {
        currentState = "PROCESSING_DEPENDENCIES";
        nextActions = [
          "Continue with 'analysis_process_next_node' to resolve dependencies",
        ];
        estimatedCompletion =
          30 +
          Math.floor(
            ((analysis.diagnostics.totalNodes -
              analysis.diagnostics.unresolvedNodes) /
              analysis.diagnostics.totalNodes) *
              50
          );
      } else if (!analysis.diagnostics.authAnalysisComplete) {
        currentState = "NEEDS_AUTH_ANALYSIS";
        nextActions = ["Run authentication analysis before code generation"];
        estimatedCompletion = 80;
      } else if (analysis.isComplete) {
        currentState = "READY_FOR_CODE_GENERATION";
        nextActions = ["Generate code with 'codegen_generate_wrapper_script'"];
        estimatedCompletion = 100;
      } else {
        currentState = "BLOCKED";
        nextActions = analysis.recommendations.slice(0, 2); // Top 2 recommendations
        estimatedCompletion = 60;
      }

      const progressSummary =
        `Session has ${analysis.diagnostics.totalNodes} nodes, ` +
        `${analysis.diagnostics.unresolvedNodes} unresolved, ` +
        `${analysis.diagnostics.pendingInQueue} queued for processing`;

      return {
        currentState,
        nextActions,
        progressSummary,
        estimatedCompletion,
      };
    } catch (_error) {
      return {
        currentState: "ERROR",
        nextActions: ["Check session exists and is properly initialized"],
        progressSummary: "Unable to determine session progress",
        estimatedCompletion: 0,
      };
    }
  }

  /**
   * Provide smart recovery suggestions for common stuck states
   */
  getRecoverySuggestions(sessionId: string): {
    isStuck: boolean;
    commonIssues: string[];
    recoverActions: string[];
    debugCommands: string[];
  } {
    try {
      const analysis = this.analyzeCompletionState(sessionId);
      this.getSession(sessionId);
      const queueStatus = this.getQueueStatus(sessionId);

      const commonIssues: string[] = [];
      const recoverActions: string[] = [];
      const debugCommands: string[] = [];

      // Check for empty queue with unresolved nodes
      if (
        queueStatus.queueLength === 0 &&
        queueStatus.unresolvedNodeCount > 0
      ) {
        commonIssues.push(
          "Processing queue is empty but unresolved nodes exist"
        );
        recoverActions.push(
          "Use 'debug_repopulate_queue' to restore queue from unresolved nodes"
        );
        debugCommands.push("debug_get_unresolved_nodes");
      }

      // Check for nodes in queue but nothing happening
      if (
        queueStatus.queueLength > 0 &&
        analysis.diagnostics.unresolvedNodes === 0
      ) {
        commonIssues.push("Queue has nodes but all dependencies are resolved");
        recoverActions.push(
          "Clear processing queue or investigate queue contents"
        );
        debugCommands.push("debug_get_node_details for queue contents");
      }

      // Check for missing master node
      if (!analysis.diagnostics.hasMasterNode) {
        commonIssues.push("Target action URL not identified");
        recoverActions.push(
          "Re-run initial analysis or manually set master node"
        );
        debugCommands.push("debug_list_all_requests", "debug_set_master_node");
      }

      // Check for authentication issues
      if (analysis.diagnostics.authErrors > 0) {
        commonIssues.push("Authentication failures detected in session data");
        recoverActions.push("Re-capture HAR with valid authentication tokens");
        debugCommands.push("auth_analyze_session");
      }

      const isStuck =
        commonIssues.length > 0 ||
        (queueStatus.queueLength === 0 &&
          queueStatus.unresolvedNodeCount === 0 &&
          !analysis.isComplete);

      return {
        isStuck,
        commonIssues,
        recoverActions,
        debugCommands,
      };
    } catch (_error) {
      return {
        isStuck: true,
        commonIssues: ["Unable to analyze session state"],
        recoverActions: ["Verify session exists and restart if necessary"],
        debugCommands: ["session_list"],
      };
    }
  }

  /**
   * Wait for the FSM to initialize properly after creation
   */
  private async waitForMachineInitialization(
    sessionId: string,
    timeoutMs = 10000
  ): Promise<void> {
    const startTime = Date.now();

    return new Promise((resolve, reject) => {
      const checkInitialization = () => {
        try {
          const currentState = this.fsmService.getCurrentState(sessionId);

          // Wait for HAR parsing to complete (need harData available)
          if (
            currentState === "awaitingWorkflowSelection" ||
            currentState === "processingDependencies" ||
            currentState === "readyForCodeGen" ||
            currentState === "codeGenerated"
          ) {
            resolve();
            return;
          }

          // Handle failed state
          if (currentState === "failed") {
            const context = this.fsmService.getContext(sessionId);
            reject(
              new Error(
                `FSM initialization failed: ${context.error?.message || "Unknown error"}`
              )
            );
            return;
          }

          // Check for timeout
          if (Date.now() - startTime > timeoutMs) {
            reject(
              new Error(
                `FSM initialization timeout after ${timeoutMs}ms for session ${sessionId}. Current state: ${currentState}`
              )
            );
            return;
          }

          // Continue checking
          setTimeout(checkInitialization, 100);
        } catch (error) {
          reject(error);
        }
      };

      checkInitialization();
    });
  }

  /**
   * Force cleanup of all sessions (useful for testing)
   */
  clearAllSessions(): void {
    this.fsmService.cleanup();
  }
}
