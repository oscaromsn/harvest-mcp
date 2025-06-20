import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { BrowserContext, Page } from "playwright";
import type { Artifact, ArtifactCollection } from "../types/index.js";
import { logger } from "../utils/logger.js";
import type { BrowserAgent } from "./BrowserAgentFactory.js";

export interface ArtifactCollectionConfig {
  enabled?: boolean | undefined;
  outputDir?: string | undefined;
  saveHar?: boolean | undefined;
  saveCookies?: boolean | undefined;
  saveScreenshots?: boolean | undefined;
  autoScreenshotInterval?: number | undefined; // Take screenshots every N seconds
}

/**
 * Service for collecting artifacts from browser sessions
 * Adapted from magnitude-mcp for harvest-mcp integration
 */
export class ArtifactCollector {
  private static instance: ArtifactCollector;
  private networkTrackingContexts = new Set<BrowserContext>();

  private constructor() {
    logger.info("[ArtifactCollector] Initialized");
  }

  static getInstance(): ArtifactCollector {
    if (!ArtifactCollector.instance) {
      ArtifactCollector.instance = new ArtifactCollector();
    }
    return ArtifactCollector.instance;
  }

  /**
   * Start network tracking for HAR collection
   */
  startNetworkTracking(context: BrowserContext, _page: Page): void {
    if (this.networkTrackingContexts.has(context)) {
      logger.debug(
        "[ArtifactCollector] Network tracking already started for this context"
      );
      return;
    }

    logger.info("[ArtifactCollector] Starting network tracking");

    // Enable network tracking
    context.tracing
      .start({
        screenshots: true,
        snapshots: true,
        sources: true,
      })
      .catch((error) => {
        logger.error("[ArtifactCollector] Failed to start tracing:", error);
      });

    this.networkTrackingContexts.add(context);
  }

  /**
   * Stop network tracking for a context
   */
  async stopNetworkTracking(context: BrowserContext): Promise<void> {
    if (!this.networkTrackingContexts.has(context)) {
      return;
    }

    try {
      await context.tracing.stop();
      this.networkTrackingContexts.delete(context);
      logger.info("[ArtifactCollector] Network tracking stopped");
    } catch (error) {
      logger.error(
        "[ArtifactCollector] Error stopping network tracking:",
        error
      );
    }
  }

  /**
   * Collect all artifacts from a browser agent
   */
  async collectFromAgent(
    agent: BrowserAgent,
    outputDir: string,
    sessionTitle: string,
    config: ArtifactCollectionConfig = {}
  ): Promise<ArtifactCollection> {
    logger.info(`[ArtifactCollector] Collecting artifacts to: ${outputDir}`);

    // Ensure output directory exists
    await mkdir(outputDir, { recursive: true });

    const artifacts: Artifact[] = [];

    try {
      // Collect HAR file
      if (config.saveHar !== false) {
        const harArtifact = await this.collectHar(
          agent.context,
          outputDir,
          sessionTitle
        );
        if (harArtifact) {
          artifacts.push(harArtifact);
        }
      }

      // Collect cookies
      if (config.saveCookies !== false) {
        const cookieArtifact = await this.collectCookies(
          agent.context,
          outputDir,
          sessionTitle
        );
        if (cookieArtifact) {
          artifacts.push(cookieArtifact);
        }
      }

      // Take final screenshot
      if (config.saveScreenshots !== false) {
        const screenshotArtifact = await this.collectScreenshot(
          agent.page,
          outputDir,
          sessionTitle
        );
        if (screenshotArtifact) {
          artifacts.push(screenshotArtifact);
        }
      }

      const summary = this.generateCollectionSummary(artifacts, sessionTitle);

      logger.info(
        `[ArtifactCollector] Collected ${artifacts.length} artifacts`
      );

      return {
        artifacts,
        outputDir,
        summary,
      };
    } catch (error) {
      logger.error("[ArtifactCollector] Error collecting artifacts:", error);
      throw new Error(
        `Failed to collect artifacts: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Collect HAR file from browser context
   */
  private async collectHar(
    context: BrowserContext,
    outputDir: string,
    sessionTitle: string
  ): Promise<Artifact | null> {
    try {
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const harPath = join(outputDir, `${sessionTitle}-${timestamp}.har`);

      // Stop network tracking and save HAR
      await this.stopNetworkTracking(context);

      // For now, we'll create a placeholder HAR structure
      // In a full implementation, this would capture actual network traffic
      const harData = {
        log: {
          version: "1.2",
          creator: {
            name: "harvest-mcp",
            version: "1.0.0",
          },
          pages: [],
          entries: [],
        },
      };

      await writeFile(harPath, JSON.stringify(harData, null, 2));
      const stats = await stat(harPath);

      return {
        type: "har",
        path: harPath,
        size: stats.size,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      logger.error("[ArtifactCollector] Failed to collect HAR:", error);
      return null;
    }
  }

  /**
   * Collect cookies from browser context
   */
  private async collectCookies(
    context: BrowserContext,
    outputDir: string,
    sessionTitle: string
  ): Promise<Artifact | null> {
    try {
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const cookiePath = join(
        outputDir,
        `${sessionTitle}-${timestamp}.cookies.json`
      );

      const cookies = await context.cookies();
      await writeFile(cookiePath, JSON.stringify(cookies, null, 2));
      const stats = await stat(cookiePath);

      return {
        type: "cookies",
        path: cookiePath,
        size: stats.size,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      logger.error("[ArtifactCollector] Failed to collect cookies:", error);
      return null;
    }
  }

  /**
   * Take screenshot of current page
   */
  private async collectScreenshot(
    page: Page,
    outputDir: string,
    sessionTitle: string
  ): Promise<Artifact | null> {
    try {
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const screenshotPath = join(
        outputDir,
        `${sessionTitle}-${timestamp}.png`
      );

      await page.screenshot({
        path: screenshotPath,
        fullPage: true,
        type: "png",
      });

      const stats = await stat(screenshotPath);

      return {
        type: "screenshot",
        path: screenshotPath,
        size: stats.size,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      logger.error("[ArtifactCollector] Failed to take screenshot:", error);
      return null;
    }
  }

  /**
   * Generate summary of collected artifacts
   */
  private generateCollectionSummary(
    artifacts: Artifact[],
    sessionTitle: string
  ): string {
    let summary = `Artifact collection completed for: ${sessionTitle}\n\n`;
    summary += `Total artifacts collected: ${artifacts.length}\n`;

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

    return summary;
  }

  /**
   * Create a screenshot artifact from a page
   */
  async takeScreenshot(
    page: Page,
    outputDir: string,
    filename?: string
  ): Promise<Artifact> {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const screenshotPath = join(
      outputDir,
      filename || `screenshot-${timestamp}.png`
    );

    await page.screenshot({
      path: screenshotPath,
      fullPage: true,
      type: "png",
    });

    const stats = await stat(screenshotPath);

    return {
      type: "screenshot",
      path: screenshotPath,
      size: stats.size,
      timestamp: new Date().toISOString(),
    };
  }
}

// Export singleton instance
export const artifactCollector = ArtifactCollector.getInstance();
