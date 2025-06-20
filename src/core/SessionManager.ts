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
      // Parse HAR file
      const harData = await parseHARFile(params.harPath);

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

      // Log session creation
      this.addLog(
        sessionId,
        "info",
        `Session created with prompt: "${params.prompt}"`
      );

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
   * Force cleanup of all sessions (useful for testing)
   */
  clearAllSessions(): void {
    this.sessions.clear();
  }
}
