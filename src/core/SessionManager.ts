import { v4 as uuidv4 } from "uuid";
import { analyzeAuthentication } from "../agents/AuthenticationAgent.js";
import {
  type AuthenticationAnalysis,
  type CompletionAnalysis,
  type CookieData,
  type DAGNode,
  HARQualityError,
  type HarvestSession,
  type LogEntry,
  type SessionInfo,
  SessionNotFoundError,
  type SessionStartParams,
  type SessionState,
} from "../types/index.js";
import { createComponentLogger } from "../utils/logger.js";
// AuthenticationAnalyzer replaced with AuthenticationAgent
import { parseCookieFile } from "./CookieParser.js";
import { DAGManager } from "./DAGManager.js";
import { parseHARFile } from "./HARParser.js";

// Extended DAGManager interface to include our new methods
interface ExtendedDAGManager extends DAGManager {
  areAllNodesParameterClassified(): boolean;
  getNodesNeedingClassification(): string[];
  getTrulyDynamicParts(node: DAGNode): string[];
}

const logger = createComponentLogger("session-manager");

export class SessionManager {
  private sessions = new Map<string, HarvestSession>();
  private readonly MAX_SESSIONS = 100;
  private readonly SESSION_TIMEOUT = 30 * 60 * 1000; // 30 minutes

  constructor() {
    // Set up periodic cleanup
    setInterval(() => this.cleanupExpiredSessions(), 5 * 60 * 1000); // Every 5 minutes
  }

  /**
   * Create a new analysis session
   */
  async createSession(params: SessionStartParams): Promise<string> {
    // Clean up if we're at max capacity
    if (this.sessions.size >= this.MAX_SESSIONS) {
      this.cleanupExpiredSessions();

      // If still at capacity, remove oldest session
      if (this.sessions.size >= this.MAX_SESSIONS) {
        this.removeOldestSession();
      }
    }

    const sessionId = uuidv4();
    const now = new Date();

    try {
      // Parse HAR file with validation and options
      // Transform Zod schema to match HARParsingOptions interface
      const harParsingOptions = params.harParsingOptions
        ? {
            ...(params.harParsingOptions.excludeKeywords !== undefined && {
              excludeKeywords: params.harParsingOptions.excludeKeywords,
            }),
            ...(params.harParsingOptions.includeAllApiRequests !==
              undefined && {
              includeAllApiRequests:
                params.harParsingOptions.includeAllApiRequests,
            }),
            ...(params.harParsingOptions.minQualityThreshold !== undefined && {
              minQualityThreshold: params.harParsingOptions.minQualityThreshold,
            }),
            ...(params.harParsingOptions.preserveAnalyticsRequests !==
              undefined && {
              preserveAnalyticsRequests:
                params.harParsingOptions.preserveAnalyticsRequests,
            }),
          }
        : undefined;

      const harData = await parseHARFile(params.harPath, harParsingOptions);

      // Log HAR validation results
      if (harData.validation) {
        const validation = harData.validation;
        logger.info(
          `HAR validation for session ${sessionId}: quality=${validation.quality}, ` +
            `relevant=${validation.stats.relevantEntries}/${validation.stats.totalEntries} requests`
        );

        if (validation.issues.length > 0) {
          logger.warn(
            `HAR issues for session ${sessionId}: ${validation.issues.join(", ")}`
          );
        }

        // Phase 2.1: Enforce quality gates before analysis conversion
        if (validation.quality === "empty") {
          throw new HARQualityError(
            validation.quality,
            validation.issues,
            [
              ...validation.recommendations,
              "Please capture more meaningful network activity before analysis.",
            ],
            {
              harPath: params.harPath,
              sessionId,
              stats: validation.stats,
            }
          );
        }

        if (
          validation.quality === "poor" &&
          validation.stats.relevantEntries < 3
        ) {
          throw new HARQualityError(
            validation.quality,
            [
              ...validation.issues,
              `Insufficient meaningful requests: ${validation.stats.relevantEntries} entries`,
            ],
            [
              ...validation.recommendations,
              "Please interact more with the application to generate API requests.",
            ],
            {
              harPath: params.harPath,
              sessionId,
              stats: validation.stats,
            }
          );
        }

        // Warn but allow "poor" quality with some minimal content
        if (validation.quality === "poor") {
          logger.warn(
            "HAR file has poor quality but sufficient content to proceed with analysis. " +
              "Quality issues may affect code generation accuracy."
          );
        }
      }

      // Parse cookie file if provided
      let cookieData: CookieData | undefined;
      if (params.cookiePath) {
        cookieData = await parseCookieFile(params.cookiePath);
      }

      // Initialize session state
      const sessionState: SessionState = {
        toBeProcessedNodes: [],
        inProcessNodeDynamicParts: [],
        inputVariables: params.inputVariables || {},
        isComplete: false,
        logs: [],
        workflowGroups: new Map(),
      };

      // Create session
      const session: HarvestSession = {
        id: sessionId,
        prompt: params.prompt,
        harData,
        dagManager: new DAGManager(),
        state: sessionState,
        createdAt: now,
        lastActivity: now,
      };

      if (cookieData !== undefined) {
        session.cookieData = cookieData;
      }

      this.sessions.set(sessionId, session);

      // Log session creation with HAR quality info
      this.addLog(
        sessionId,
        "info",
        `Session created with prompt: "${params.prompt}" | HAR quality: ${harData.validation?.quality || "unknown"}`
      );

      // Add HAR validation warnings to session logs if needed
      if (harData.validation && harData.validation.quality === "poor") {
        this.addLog(
          sessionId,
          "warn",
          `HAR file has poor quality: ${harData.validation.issues.join(", ")}`
        );
        for (const rec of harData.validation.recommendations) {
          this.addLog(sessionId, "info", `Recommendation: ${rec}`);
        }
      }

      if (harData.validation && harData.validation.quality === "empty") {
        this.addLog(
          sessionId,
          "error",
          "HAR file is empty or contains no usable requests"
        );
        for (const rec of harData.validation.recommendations) {
          this.addLog(sessionId, "info", `Recommendation: ${rec}`);
        }
      }

      return sessionId;
    } catch (error) {
      throw new Error(
        `Failed to create session: ${error instanceof Error ? error.message : "Unknown error"}`
      );
    }
  }

  /**
   * Get a session by ID
   */
  getSession(sessionId: string): HarvestSession {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new SessionNotFoundError(sessionId);
    }

    // Update last activity
    session.lastActivity = new Date();
    return session;
  }

  /**
   * Check if a session exists
   */
  hasSession(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  /**
   * Delete a session
   */
  deleteSession(sessionId: string): boolean {
    return this.sessions.delete(sessionId);
  }

  /**
   * List all active sessions
   */
  listSessions(): SessionInfo[] {
    const sessionInfos: SessionInfo[] = [];

    for (const [id, session] of this.sessions) {
      sessionInfos.push({
        id,
        prompt: session.prompt,
        createdAt: session.createdAt,
        lastActivity: session.lastActivity,
        isComplete: session.state.isComplete,
        nodeCount: session.dagManager.getNodeCount(),
      });
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
    return Array.from(this.sessions.keys());
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
    const session = this.sessions.get(sessionId);
    if (session) {
      const logEntry: LogEntry = {
        timestamp: new Date(),
        level,
        message,
        data,
      };

      session.state.logs.push(logEntry);
      session.lastActivity = new Date();

      // Keep only last 1000 log entries to prevent memory bloat
      if (session.state.logs.length > 1000) {
        session.state.logs = session.state.logs.slice(-1000);
      }
    }
  }

  /**
   * Get session logs
   */
  getSessionLogs(sessionId: string): LogEntry[] {
    const session = this.getSession(sessionId);
    return [...session.state.logs]; // Return a copy
  }

  /**
   * Clean up expired sessions
   */
  private cleanupExpiredSessions(): void {
    const now = Date.now();
    const expiredSessions: string[] = [];

    for (const [id, session] of this.sessions) {
      if (now - session.lastActivity.getTime() > this.SESSION_TIMEOUT) {
        expiredSessions.push(id);
      }
    }

    for (const sessionId of expiredSessions) {
      this.sessions.delete(sessionId);
      logger.info({ sessionId }, "Cleaned up expired session");
    }
  }

  /**
   * Remove the oldest session to make room for new ones
   */
  private removeOldestSession(): void {
    let oldestSession: { id: string; lastActivity: Date } | null = null;

    for (const [id, session] of this.sessions) {
      if (!oldestSession || session.lastActivity < oldestSession.lastActivity) {
        oldestSession = { id, lastActivity: session.lastActivity };
      }
    }

    if (oldestSession) {
      this.sessions.delete(oldestSession.id);
      logger.info(
        { sessionId: oldestSession.id },
        "Removed oldest session to make room"
      );
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
    const sessions = Array.from(this.sessions.values());
    const totalSessions = sessions.length;
    const completedSessions = sessions.filter((s) => s.state.isComplete).length;
    const activeSessions = sessions.filter((s) => !s.state.isComplete).length;
    const averageNodeCount =
      sessions.reduce((sum, s) => sum + s.dagManager.getNodeCount(), 0) /
      Math.max(totalSessions, 1);

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
   * Enhanced completion state analysis with comprehensive validation
   * This replaces the simple syncCompletionState with thorough checking
   */
  analyzeCompletionState(sessionId: string): CompletionAnalysis {
    try {
      const session = this.getSession(sessionId);

      // Ensure DAG state is refreshed before analysis to reflect latest parameter classifications
      this.refreshDAGStateForParameterClassifications(sessionId);

      // Gather diagnostic information
      const dagComplete = session.dagManager.isComplete();
      const unresolvedNodes = session.dagManager.getUnresolvedNodes();
      const hasMasterNode = !!session.state.masterNodeId;
      let hasActionUrl = !!session.state.actionUrl;
      const queueEmpty = session.state.toBeProcessedNodes.length === 0;

      // Enhanced debugging for actionUrl state tracking
      logger.debug("analyzeCompletionState - actionUrl diagnostic details", {
        sessionId,
        actionUrlValue: session.state.actionUrl,
        actionUrlType: typeof session.state.actionUrl,
        actionUrlLength: session.state.actionUrl?.length || 0,
        hasActionUrl,
        masterNodeId: session.state.masterNodeId,
        hasMasterNode,
      });
      const totalNodes = session.dagManager.getNodeCount();
      const allNodesClassified = (
        session.dagManager as ExtendedDAGManager
      ).areAllNodesParameterClassified();
      const nodesNeedingClassification = (
        session.dagManager as ExtendedDAGManager
      ).getNodesNeedingClassification();

      // Analyze authentication readiness
      const authReadinessAnalysis =
        this.analyzeAuthenticationReadiness(session);

      // Analyze bootstrap readiness
      const bootstrapAnalysis = this.analyzeBootstrapReadiness(session);

      const blockers: string[] = [];
      const recommendations: string[] = [];

      // Condition 1: Master node must be identified and exist in DAG
      if (hasMasterNode && session.state.masterNodeId) {
        // Verify master node actually exists in DAG
        const masterNode = session.dagManager.getNode(
          session.state.masterNodeId
        );
        if (!masterNode) {
          blockers.push("Master node ID is set but node does not exist in DAG");
          recommendations.push(
            "Re-run 'analysis_run_initial_analysis' to properly create master node"
          );
        }
      } else {
        blockers.push("Master node has not been identified");
        recommendations.push(
          "Run 'analysis_run_initial_analysis' to identify the target action URL"
        );

        // Also check for actionUrl when there's no master node at all
        if (!hasActionUrl) {
          blockers.push("Target action URL has not been identified");
        }
      }

      // Condition 2: Action URL must be identified (but avoid duplication with master node check)
      if (!hasActionUrl && hasMasterNode && session.state.masterNodeId) {
        // Only add this blocker if master node exists but action URL is missing
        // This prevents contradictory status when initial analysis succeeded
        const masterNode = session.dagManager.getNode(
          session.state.masterNodeId
        );
        if (masterNode) {
          // Get the URL from the master node content
          const masterNodeUrl = (
            masterNode.content as { key?: { url?: string } }
          )?.key?.url;

          logger.debug("Master node found, checking for actionUrl recovery", {
            sessionId,
            masterNodeUrl,
            sessionActionUrl: session.state.actionUrl,
            hasUrl: !!masterNodeUrl,
            hasSessionActionUrl: !!session.state.actionUrl,
            nodeType: masterNode.nodeType,
            contentStructure: {
              hasContent: !!masterNode.content,
              hasKey: !!(masterNode.content as { key?: unknown })?.key,
              hasUrl: !!(masterNode.content as { key?: { url?: string } })?.key
                ?.url,
            },
          });

          // Defensive fix: Check if we can recover the actionUrl from the master node
          if (masterNodeUrl && !session.state.actionUrl) {
            logger.warn(
              "State synchronization issue detected: actionUrl missing but master node has URL, recovering",
              {
                sessionId,
                masterNodeUrl,
                sessionActionUrl: session.state.actionUrl,
              }
            );

            // Recover the actionUrl from the master node
            session.state.actionUrl = masterNodeUrl;

            // Recalculate hasActionUrl with the recovered value
            hasActionUrl = !!session.state.actionUrl;

            logger.info("Successfully recovered actionUrl from master node", {
              sessionId,
              recoveredUrl: session.state.actionUrl,
            });

            // Don't add the blocker since we recovered the state
          } else {
            // Genuine case where actionUrl is missing and can't be recovered
            blockers.push("Target action URL has not been identified");
            recommendations.push(
              "Ensure initial analysis successfully identifies the main workflow URL"
            );
          }
        }
      }

      // Condition 3: All nodes with dynamic parts must have parameter classification
      if (!allNodesClassified) {
        blockers.push(
          `${nodesNeedingClassification.length} nodes still need parameter classification`
        );
        recommendations.push(
          "Continue processing with 'analysis_process_next_node' to classify parameters"
        );
        recommendations.push(
          "Node IDs needing classification: " +
            nodesNeedingClassification.join(", ")
        );
      }

      // Condition 4: DAG must be fully resolved (after parameter classification)
      if (!dagComplete) {
        blockers.push(
          `${unresolvedNodes.length} nodes still have unresolved dynamic parts`
        );
        recommendations.push(
          "Continue processing with 'analysis_process_next_node'"
        );
        recommendations.push(
          "Use 'debug_get_unresolved_nodes' to see specific unresolved parts"
        );
      }

      // Condition 5: Processing queue must be empty
      if (!queueEmpty) {
        blockers.push(
          `${session.state.toBeProcessedNodes.length} nodes are still pending in the processing queue`
        );
        recommendations.push(
          "Continue processing with 'analysis_process_next_node' until queue is empty"
        );
      }

      // Condition 6: Must have at least one node (not an empty analysis)
      if (totalNodes === 0) {
        blockers.push("No nodes found in dependency graph");
        recommendations.push("Verify HAR file contains valid HTTP requests");
        recommendations.push("Re-run initial analysis if needed");
      }

      // Condition 7: Authentication must be analyzed and ready for code generation
      if (!authReadinessAnalysis.analysisComplete) {
        blockers.push("Authentication analysis has not been completed");
        recommendations.push(
          "Run authentication analysis before code generation"
        );
        recommendations.push(
          "Use 'auth_analyze_session' tool to analyze authentication requirements"
        );
      } else if (!authReadinessAnalysis.isReady) {
        blockers.push(...authReadinessAnalysis.blockers);
        recommendations.push(...authReadinessAnalysis.recommendations);
      }

      // Add authentication-specific warnings even if not blocking
      if (authReadinessAnalysis.warnings.length > 0) {
        for (const warning of authReadinessAnalysis.warnings) {
          this.addLog(sessionId, "warn", `Authentication warning: ${warning}`);
        }
      }

      // Condition 8: Session constants must have bootstrap sources resolved
      if (
        !bootstrapAnalysis.isComplete &&
        bootstrapAnalysis.sessionConstantsCount > 0
      ) {
        blockers.push(
          `${bootstrapAnalysis.unresolvedCount} session constants need bootstrap source resolution`
        );
        recommendations.push(
          "Continue processing with 'analysis_process_next_node' to resolve bootstrap sources"
        );
        recommendations.push(
          "Session constants require initialization from the main page load"
        );
      }

      const isComplete = blockers.length === 0;

      // Update session state if it has changed
      if (session.state.isComplete !== isComplete) {
        session.state.isComplete = isComplete;

        if (isComplete) {
          this.addLog(
            sessionId,
            "info",
            "Analysis completion validated: all prerequisites met, ready for code generation"
          );
        } else {
          this.addLog(
            sessionId,
            "info",
            `Analysis not complete: ${blockers.length} blockers identified: ${blockers.join(", ")}`
          );
        }
      }

      // Recreate diagnostics with updated values (especially hasActionUrl after recovery)
      const finalDiagnostics = {
        hasMasterNode,
        dagComplete,
        queueEmpty,
        totalNodes,
        unresolvedNodes: unresolvedNodes.length,
        pendingInQueue: session.state.toBeProcessedNodes.length,
        hasActionUrl, // This now reflects any recovery that occurred
        authAnalysisComplete: authReadinessAnalysis.analysisComplete,
        authReadiness: authReadinessAnalysis.isReady,
        authErrors: authReadinessAnalysis.errorCount,
        allNodesClassified,
        nodesNeedingClassification: nodesNeedingClassification.length,
        bootstrapAnalysisComplete: bootstrapAnalysis.isComplete,
        sessionConstantsCount: bootstrapAnalysis.sessionConstantsCount,
        unresolvedSessionConstants: bootstrapAnalysis.unresolvedCount,
      };

      return {
        isComplete,
        blockers,
        recommendations,
        diagnostics: finalDiagnostics,
      };
    } catch (_error) {
      logger.error(
        {
          sessionId,
          error: _error instanceof Error ? _error.message : "Unknown error",
        },
        "Failed to analyze completion state"
      );

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
   * Analyze bootstrap readiness for session constants
   */
  private analyzeBootstrapReadiness(session: HarvestSession): {
    isComplete: boolean;
    sessionConstantsCount: number;
    unresolvedCount: number;
    resolvedCount: number;
  } {
    let sessionConstantsCount = 0;
    let resolvedCount = 0;
    let unresolvedCount = 0;

    // Iterate through all nodes to find session constants
    const allNodes = session.dagManager.getAllNodes();

    for (const [, node] of allNodes) {
      if (node.classifiedParameters) {
        for (const param of node.classifiedParameters) {
          if (param.classification === "sessionConstant") {
            sessionConstantsCount++;

            if (param.metadata.bootstrapSource) {
              resolvedCount++;
            } else {
              unresolvedCount++;
            }
          }
        }
      }
    }

    const isComplete = sessionConstantsCount === 0 || unresolvedCount === 0;

    return {
      isComplete,
      sessionConstantsCount,
      unresolvedCount,
      resolvedCount,
    };
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
   * Backward-compatible sync method that uses enhanced validation
   * This maintains existing API while providing enhanced functionality
   */
  syncCompletionState(sessionId: string): void {
    // Force refresh of DAG state before analysis to ensure parameter classifications are reflected
    this.refreshDAGStateForParameterClassifications(sessionId);
    this.analyzeCompletionState(sessionId);
    // The state is already updated in analyzeCompletionState
    // This method now just provides the legacy interface
  }

  /**
   * Refresh DAG state to ensure all parameter classifications are properly reflected
   * This ensures completion state analysis is based on the most recent classification results
   */
  private refreshDAGStateForParameterClassifications(sessionId: string): void {
    try {
      const session = this.getSession(sessionId);

      // Check all nodes to ensure their classification state is up to date
      const allNodes = session.dagManager.getAllNodes();
      for (const [nodeId, node] of allNodes) {
        if (
          node?.classifiedParameters &&
          node.classifiedParameters.length > 0
        ) {
          // Ensure the node's dynamic parts are filtered based on current classifications
          const trulyDynamicParts = (
            session.dagManager as ExtendedDAGManager
          ).getTrulyDynamicParts(node);

          // If the filtered dynamic parts differ from stored dynamic parts, log the difference
          if (
            node.dynamicParts &&
            trulyDynamicParts.length !== node.dynamicParts.length
          ) {
            logger.debug(
              "DAG node dynamic parts filtered by parameter classification",
              {
                sessionId,
                nodeId,
                originalDynamicParts: node.dynamicParts.length,
                filteredDynamicParts: trulyDynamicParts.length,
                classifiedParameters: node.classifiedParameters.length,
              }
            );
          }
        }
      }
    } catch (_error) {
      logger.warn("Failed to refresh DAG state for parameter classifications", {
        sessionId,
        error: _error instanceof Error ? _error.message : "Unknown error",
      });
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
          "Run 'analysis_run_initial_analysis' to identify target action URL",
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
   * Force cleanup of all sessions (useful for testing)
   */
  clearAllSessions(): void {
    this.sessions.clear();
  }
}
