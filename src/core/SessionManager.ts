import { v4 as uuidv4 } from "uuid";
import {
  type CookieData,
  type HarvestSession,
  type LogEntry,
  type SessionInfo,
  SessionNotFoundError,
  type SessionStartParams,
  type SessionState,
} from "../types/index.js";
import { createComponentLogger } from "../utils/logger.js";
import { parseCookieFile } from "./CookieParser.js";
import { DAGManager } from "./DAGManager.js";
import { parseHARFile } from "./HARParser.js";

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
    } catch (error) {
      return {
        queueLength: 0,
        unresolvedNodeCount: 0,
        canRepopulate: false,
        recommendations: [
          `Error getting queue status: ${error instanceof Error ? error.message : "Unknown error"}`,
        ],
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
