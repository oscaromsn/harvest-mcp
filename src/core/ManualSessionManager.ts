import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type {
  Artifact,
  ManualSession,
  SessionConfig,
  BrowserSessionInfo as SessionInfo,
  SessionStopResult,
} from "../types/index.js";
import { logger } from "../utils/logger.js";
import {
  MemoryMonitor,
  type MemoryUsage,
  memoryMonitor,
} from "../utils/memoryMonitor.js";
import { artifactCollector } from "./ArtifactCollector.js";
import {
  type BrowserAgentConfig,
  browserAgentFactory,
} from "./BrowserAgentFactory.js";

/**
 * Service for managing manual browser sessions with artifact collection
 * Adapted from magnitude-mcp for harvest-mcp integration
 */
export class ManualSessionManager {
  private static instance: ManualSessionManager;
  private activeSessions: Map<string, ManualSession> = new Map();
  private cleanupIntervals: Map<string, NodeJS.Timeout> = new Map();
  private defaultOutputDir: string;

  private constructor() {
    this.defaultOutputDir = join(process.cwd(), "manual-session-artifacts");

    // Global cleanup handler for process termination
    process.on("SIGINT", () => this.cleanupAllSessions());
    process.on("SIGTERM", () => this.cleanupAllSessions());
  }

  static getInstance(): ManualSessionManager {
    if (!ManualSessionManager.instance) {
      ManualSessionManager.instance = new ManualSessionManager();
    }
    return ManualSessionManager.instance;
  }

  /**
   * Start a new manual browser session
   */
  async startSession(config: SessionConfig = {}): Promise<SessionInfo> {
    const sessionId = randomUUID();
    const startTime = Date.now();

    logger.info(`[ManualSessionManager] Starting manual session: ${sessionId}`);

    // Take memory snapshot before session start
    const preStartSnapshot = memoryMonitor.takeSnapshot(
      sessionId,
      "session_start_begin"
    );
    logger.info(
      `[ManualSessionManager] Memory before session start: ${MemoryMonitor.formatMemorySize(preStartSnapshot.usage.heapUsed)}`
    );

    try {
      // Create output directory
      const datePart = new Date().toISOString().split("T")[0];
      if (!datePart) {
        throw new Error("Failed to generate date part for output directory");
      }
      const outputDir =
        config.artifactConfig?.outputDir ||
        join(this.defaultOutputDir, datePart, sessionId);

      await import("node:fs").then((fs) =>
        fs.promises.mkdir(outputDir, { recursive: true })
      );

      // Create browser agent with manual-friendly defaults
      const agentConfig: BrowserAgentConfig = {
        ...(config.url && { url: config.url }),
        headless: config.browserOptions?.headless ?? false, // Default to visible for manual interaction
        viewport: {
          width: config.browserOptions?.viewport?.width ?? 1280,
          height: config.browserOptions?.viewport?.height ?? 720,
        },
        contextOptions: {
          deviceScaleFactor:
            config.browserOptions?.contextOptions?.deviceScaleFactor ?? 1,
        },
      };

      const coreAgent =
        await browserAgentFactory.createBrowserAgent(agentConfig);

      // Create agent adapter for ManualSession interface compatibility
      const agent = coreAgent;

      // Start network tracking for HAR collection if enabled
      if (config.artifactConfig?.enabled !== false) {
        logger.info(
          `[ManualSessionManager] Starting network tracking for session: ${sessionId}`
        );
        artifactCollector.startNetworkTracking(agent.context, agent.page);
      }

      // Get initial page state
      const currentUrl = agent.page.url();
      const pageTitle = await agent.page.title().catch(() => "Unknown");

      // Create session object
      const session: ManualSession = {
        id: sessionId,
        agent,
        startTime,
        config,
        outputDir,
        artifacts: [],
        metadata: {
          currentUrl,
          pageTitle,
          networkRequestCount: 0,
        },
      };

      this.activeSessions.set(sessionId, session);

      // Set up auto-cleanup timeout if specified
      if (config.timeout && config.timeout > 0) {
        const timeoutMs = config.timeout * 60 * 1000; // Convert minutes to milliseconds
        const timeoutId = setTimeout(() => {
          logger.warn(
            `[ManualSessionManager] Auto-cleanup timeout reached for session: ${sessionId}`
          );
          this.stopSession(sessionId, { reason: "timeout" });
        }, timeoutMs);
        this.cleanupIntervals.set(sessionId, timeoutId);
      }

      // Set up auto-screenshot interval if configured
      if (
        config.artifactConfig?.autoScreenshotInterval &&
        config.artifactConfig?.autoScreenshotInterval > 0
      ) {
        const screenshotInterval = setInterval(async () => {
          try {
            await this.takeSessionScreenshot(sessionId);
          } catch (error) {
            logger.error(
              `[ManualSessionManager] Auto-screenshot failed for session ${sessionId}:`,
              error
            );
          }
        }, config.artifactConfig.autoScreenshotInterval * 1000);

        // Store interval for cleanup (reuse cleanupIntervals map with a prefix)
        this.cleanupIntervals.set(
          `screenshot_${sessionId}`,
          screenshotInterval
        );
      }

      logger.info(
        `[ManualSessionManager] Manual session started successfully: ${sessionId}`
      );

      // Take memory snapshot after session creation
      const postStartSnapshot = memoryMonitor.takeSnapshot(
        sessionId,
        "session_start_complete"
      );
      const memoryGrowth =
        postStartSnapshot.usage.heapUsed - preStartSnapshot.usage.heapUsed;
      logger.info(
        `[ManualSessionManager] Memory after session start: ${MemoryMonitor.formatMemorySize(postStartSnapshot.usage.heapUsed)} (growth: ${MemoryMonitor.formatMemorySize(memoryGrowth)})`
      );

      return {
        id: sessionId,
        startTime,
        currentUrl,
        pageTitle,
        duration: 0,
        outputDir,
        artifactConfig: config.artifactConfig,
        instructions: this.generateSessionInstructions(sessionId, config),
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      logger.error(
        `[ManualSessionManager] Failed to start session: ${errorMessage}`
      );
      throw new Error(`Failed to start manual session: ${errorMessage}`);
    }
  }

  /**
   * Stop a manual browser session and collect artifacts
   */
  async stopSession(
    sessionId: string,
    options: {
      artifactTypes?: ("har" | "cookies" | "screenshot")[];
      takeScreenshot?: boolean;
      reason?: string;
    } = {}
  ): Promise<SessionStopResult> {
    const session = this.activeSessions.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    const stopTime = Date.now();
    const duration = stopTime - session.startTime;

    logger.info(
      `[ManualSessionManager] Stopping session: ${sessionId} (duration: ${Math.round(duration / 1000)}s, reason: ${options.reason || "manual"})`
    );

    // Take memory snapshot before cleanup
    const preStopSnapshot = memoryMonitor.takeSnapshot(
      sessionId,
      "session_stop_begin"
    );
    logger.info(
      `[ManualSessionManager] Memory before session stop: ${MemoryMonitor.formatMemorySize(preStopSnapshot.usage.heapUsed)}`
    );

    try {
      // Get final page state
      const finalUrl = session.agent.page.url();
      const finalPageTitle = await session.agent.page
        .title()
        .catch(() => "Unknown");

      // Take final screenshot if requested or if screenshots are enabled
      if (
        options.takeScreenshot !== false &&
        (options.takeScreenshot === true ||
          session.config.artifactConfig?.saveScreenshots !== false)
      ) {
        await this.takeSessionScreenshot(sessionId);
      }

      // Collect artifacts if enabled
      let artifacts: Artifact[] = [];
      if (session.config.artifactConfig?.enabled !== false) {
        logger.info(
          `[ManualSessionManager] Collecting artifacts for session: ${sessionId}`
        );

        const artifactCollection = await artifactCollector.collectFromAgent(
          session.agent,
          session.outputDir,
          `Manual Session ${sessionId}`,
          session.config.artifactConfig || {}
        );
        artifacts = artifactCollection.artifacts;

        // Filter artifacts by type if specified
        if (options.artifactTypes && options.artifactTypes.length > 0) {
          artifacts = artifacts.filter((artifact) =>
            options.artifactTypes?.includes(
              artifact.type as "har" | "cookies" | "screenshot"
            )
          );
        }
      }

      // Update session metadata
      session.metadata.sessionDuration = duration;
      session.metadata.currentUrl = finalUrl;
      session.metadata.pageTitle = finalPageTitle;

      // Generate session summary
      const summary = this.generateSessionSummary(session, duration, artifacts);

      // Clean up browser agent
      await session.agent.stop();

      // Clean up timers
      this.cleanupSessionTimers(sessionId);

      // Remove from active sessions
      this.activeSessions.delete(sessionId);

      // Take memory snapshot after cleanup
      const postStopSnapshot = memoryMonitor.takeSnapshot(
        sessionId,
        "session_stop_complete"
      );
      const memoryReclaimed =
        preStopSnapshot.usage.heapUsed - postStopSnapshot.usage.heapUsed;
      logger.info(
        `[ManualSessionManager] Memory after session stop: ${MemoryMonitor.formatMemorySize(postStopSnapshot.usage.heapUsed)} (reclaimed: ${MemoryMonitor.formatMemorySize(memoryReclaimed)})`
      );

      // Check for memory leaks
      const leakDetection = memoryMonitor.detectMemoryLeaks();
      if (leakDetection.isLeaking) {
        logger.warn(
          `[ManualSessionManager] Potential memory leak detected: ${leakDetection.recommendation}`
        );
      }

      logger.info(
        `[ManualSessionManager] Session stopped successfully: ${sessionId}`
      );

      return {
        id: sessionId,
        duration,
        finalUrl,
        finalPageTitle,
        artifacts,
        summary,
        metadata: {
          networkRequestCount: session.metadata.networkRequestCount || 0,
          totalArtifacts: artifacts.length,
          sessionDurationMs: duration,
        },
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      logger.error(
        `[ManualSessionManager] Error stopping session ${sessionId}: ${errorMessage}`
      );

      // Still try to clean up
      try {
        await session.agent.stop();
        this.cleanupSessionTimers(sessionId);
        this.activeSessions.delete(sessionId);
      } catch (cleanupError) {
        logger.error(
          `[ManualSessionManager] Error during cleanup: ${cleanupError}`
        );
      }

      throw new Error(`Failed to stop session: ${errorMessage}`);
    }
  }

  /**
   * Get information about an active session
   */
  getSessionInfo(sessionId: string): SessionInfo | null {
    const session = this.activeSessions.get(sessionId);
    if (!session) {
      return null;
    }

    const duration = Date.now() - session.startTime;

    return {
      id: sessionId,
      startTime: session.startTime,
      currentUrl: session.metadata.currentUrl || "",
      pageTitle: session.metadata.pageTitle || "",
      duration,
      outputDir: session.outputDir,
      artifactConfig: session.config.artifactConfig,
      instructions: this.generateSessionInstructions(sessionId, session.config),
    };
  }

  /**
   * List all active sessions
   */
  listActiveSessions(): SessionInfo[] {
    return Array.from(this.activeSessions.values()).map((session) => {
      const duration = Date.now() - session.startTime;
      return {
        id: session.id,
        startTime: session.startTime,
        currentUrl: session.metadata.currentUrl || "",
        pageTitle: session.metadata.pageTitle || "",
        duration,
        outputDir: session.outputDir,
        artifactConfig: session.config.artifactConfig,
        instructions: [],
      };
    });
  }

  /**
   * Take a screenshot for an active session
   */
  private async takeSessionScreenshot(sessionId: string): Promise<void> {
    const session = this.activeSessions.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const artifact = await artifactCollector.takeScreenshot(
      session.agent.page,
      session.outputDir,
      `manual-screenshot-${timestamp}.png`
    );

    session.artifacts.push(artifact);
    logger.info(
      `[ManualSessionManager] Screenshot taken for session ${sessionId}: ${artifact.path}`
    );
  }

  /**
   * Generate helpful instructions for manual interaction
   */
  private generateSessionInstructions(
    sessionId: string,
    config: SessionConfig
  ): string[] {
    const instructions = [
      "🎯 Manual Browser Session Started",
      "",
      `Session ID: ${sessionId}`,
      "A browser window should now be open for manual interaction.",
      "",
      "📋 What you can do:",
      "- Navigate to any website by typing URLs in the address bar",
      "- Interact with web pages manually (click, type, scroll, etc.)",
      "- Use browser developer tools if needed",
      "",
      "📊 Artifact Collection:",
    ];

    if (config.artifactConfig?.enabled !== false) {
      instructions.push("- ✅ Network traffic is being recorded (HAR file)");
      if (config.artifactConfig?.saveCookies !== false) {
        instructions.push("- 🍪 Cookies will be captured");
      }
      if (config.artifactConfig?.saveScreenshots !== false) {
        instructions.push("- 📸 Screenshots will be taken");
      }
      if (config.artifactConfig?.autoScreenshotInterval) {
        instructions.push(
          `- 📸 Auto-screenshots every ${config.artifactConfig.autoScreenshotInterval}s`
        );
      }
    } else {
      instructions.push("- ❌ Artifact collection is disabled");
    }

    instructions.push("");

    if (config.timeout) {
      instructions.push(`⏰ Auto-cleanup in ${config.timeout} minutes`);
    } else {
      instructions.push(
        "⏰ No auto-cleanup timeout (remember to stop the session)"
      );
    }

    instructions.push("");
    instructions.push("🛑 When finished, use the session_stop_manual tool to:");
    instructions.push("- Collect all artifacts");
    instructions.push("- Get session summary");
    instructions.push("- Clean up browser resources");

    return instructions;
  }

  /**
   * Generate session summary
   */
  private generateSessionSummary(
    session: ManualSession,
    duration: number,
    artifacts: Artifact[]
  ): string {
    const durationSec = Math.round(duration / 1000);
    const durationMin = Math.round(duration / 60000);

    let summary = "Manual browser session completed:\n\n";
    summary += `Duration: ${durationMin > 0 ? `${durationMin}m ` : ""}${durationSec % 60}s\n`;
    summary += `Final URL: ${session.metadata.currentUrl || "Unknown"}\n`;
    summary += `Final Page: ${session.metadata.pageTitle || "Unknown"}\n`;
    summary += `Artifacts Collected: ${artifacts.length}\n\n`;

    if (artifacts.length > 0) {
      summary += "Artifact breakdown:\n";
      const harFiles = artifacts.filter((a) => a.type === "har");
      const cookieFiles = artifacts.filter((a) => a.type === "cookies");
      const screenshots = artifacts.filter((a) => a.type === "screenshot");

      if (harFiles.length > 0) {
        summary += `- HAR files: ${harFiles.length}\n`;
      }
      if (cookieFiles.length > 0) {
        summary += `- Cookie files: ${cookieFiles.length}\n`;
      }
      if (screenshots.length > 0) {
        summary += `- Screenshots: ${screenshots.length}\n`;
      }

      summary += `\nArtifacts saved to: ${session.outputDir}`;
    }

    return summary;
  }

  /**
   * Clean up timers for a session
   */
  private cleanupSessionTimers(sessionId: string): void {
    // Clean up timeout timer
    const timeoutId = this.cleanupIntervals.get(sessionId);
    if (timeoutId) {
      clearTimeout(timeoutId);
      this.cleanupIntervals.delete(sessionId);
    }

    // Clean up screenshot interval
    const screenshotIntervalId = this.cleanupIntervals.get(
      `screenshot_${sessionId}`
    );
    if (screenshotIntervalId) {
      clearInterval(screenshotIntervalId);
      this.cleanupIntervals.delete(`screenshot_${sessionId}`);
    }
  }

  /**
   * Clean up all active sessions (called on process exit)
   */
  private async cleanupAllSessions(): Promise<void> {
    logger.info(
      `[ManualSessionManager] Cleaning up ${this.activeSessions.size} active sessions`
    );

    const cleanupPromises = Array.from(this.activeSessions.keys()).map(
      (sessionId) =>
        this.stopSession(sessionId, { reason: "process_exit" }).catch((error) =>
          logger.error(
            `[ManualSessionManager] Error cleaning up session ${sessionId}:`,
            error
          )
        )
    );

    await Promise.allSettled(cleanupPromises);
    logger.info("[ManualSessionManager] All sessions cleaned up");
  }

  /**
   * Force stop a session (emergency cleanup)
   */
  async forceStopSession(sessionId: string): Promise<void> {
    const session = this.activeSessions.get(sessionId);
    if (!session) {
      return;
    }

    logger.warn(`[ManualSessionManager] Force stopping session: ${sessionId}`);

    try {
      await session.agent.stop();
    } catch (error) {
      logger.error("[ManualSessionManager] Error force stopping agent:", error);
    }

    this.cleanupSessionTimers(sessionId);
    this.activeSessions.delete(sessionId);
  }

  /**
   * Get memory usage statistics for all sessions
   */
  getMemoryStats(): {
    current: MemoryUsage;
    peak: MemoryUsage;
    average: MemoryUsage;
    snapshotCount: number;
    activeSessions: number;
    leakDetection: ReturnType<typeof memoryMonitor.detectMemoryLeaks>;
  } {
    const stats = memoryMonitor.getMemoryStats();
    const leakDetection = memoryMonitor.detectMemoryLeaks();

    return {
      ...stats,
      activeSessions: this.activeSessions.size,
      leakDetection,
    };
  }

  /**
   * Force garbage collection and cleanup
   */
  performCleanup(): {
    gcForced: boolean;
    memoryBefore: number;
    memoryAfter: number;
    memoryReclaimed: number;
  } {
    const memoryBefore = memoryMonitor.getCurrentMemoryUsage().heapUsed;
    const gcForced = memoryMonitor.forceGarbageCollection();

    // Give GC time to work
    setTimeout(() => {
      // Intentionally empty - just waiting for GC
    }, 100);

    const memoryAfter = memoryMonitor.getCurrentMemoryUsage().heapUsed;
    const memoryReclaimed = memoryBefore - memoryAfter;

    logger.info(
      `[ManualSessionManager] Cleanup performed - GC: ${gcForced ? "forced" : "not available"}, Memory reclaimed: ${MemoryMonitor.formatMemorySize(memoryReclaimed)}`
    );

    return {
      gcForced,
      memoryBefore,
      memoryAfter,
      memoryReclaimed,
    };
  }

  /**
   * Get session-specific memory usage
   */
  getSessionMemoryUsage(sessionId: string) {
    return memoryMonitor.getSessionMemoryUsage(sessionId);
  }
}

// Export singleton instance
export const manualSessionManager = ManualSessionManager.getInstance();
