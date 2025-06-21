import {
  type Browser,
  type BrowserContext,
  type Page,
  chromium,
} from "playwright";
import { logger } from "../utils/logger.js";

export interface BrowserAgent {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  stop(): Promise<void>;
}

export interface BrowserAgentConfig {
  url?: string;
  headless?: boolean;
  viewport?: {
    width?: number;
    height?: number;
  };
  contextOptions?: {
    deviceScaleFactor?: number;
  };
}

/**
 * Factory for creating and managing browser agent instances
 * Simplified version adapted from magnitude-mcp for harvest-mcp needs
 */
export class BrowserAgentFactory {
  private static instance: BrowserAgentFactory;

  private constructor() {
    logger.info("[BrowserAgentFactory] Initialized for harvest-mcp");
  }

  static getInstance(): BrowserAgentFactory {
    if (!BrowserAgentFactory.instance) {
      BrowserAgentFactory.instance = new BrowserAgentFactory();
    }
    return BrowserAgentFactory.instance;
  }

  /**
   * Create a configured browser agent instance
   */
  async createBrowserAgent(
    config: BrowserAgentConfig = {}
  ): Promise<BrowserAgent> {
    logger.info(
      "[BrowserAgentFactory] Creating browser agent with config",
      config
    );

    try {
      // Configure browser options
      const launchOptions = {
        headless: config.headless ?? false, // Default to headed for manual interaction
        args: [
          "--disable-gpu",
          "--disable-blink-features=AutomationControlled",
          "--force-device-scale-factor=1", // Ensure coordinate accuracy
        ],
      };

      // Launch browser
      const browser = await chromium.launch(launchOptions);

      // Configure context
      const contextOptions = {
        viewport: {
          width: config.viewport?.width ?? 1280,
          height: config.viewport?.height ?? 720,
        },
        deviceScaleFactor: config.contextOptions?.deviceScaleFactor ?? 1,
        hasTouch: false, // Disable touch for precise coordinate mapping
        isMobile: false, // Ensure desktop viewport behavior
      };

      const context = await browser.newContext(contextOptions);

      // Create initial page
      const page = await context.newPage();

      // Note: Navigation is now handled by the calling code after network tracking is set up
      // This prevents the issue where network requests complete before tracking starts

      // Create agent wrapper
      const agent: BrowserAgent = {
        browser,
        context,
        page,
        async stop() {
          try {
            await context.close();
            await browser.close();
            logger.info("[BrowserAgent] Browser agent stopped successfully");
          } catch (error) {
            logger.error("[BrowserAgent] Error stopping browser agent:", error);
            throw error;
          }
        },
      };

      logger.info("[BrowserAgentFactory] Browser agent created successfully");
      return agent;
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      logger.error(
        `[BrowserAgentFactory] Failed to create browser agent: ${errorMessage}`
      );
      throw new Error(`Failed to create browser agent: ${errorMessage}`);
    }
  }

  /**
   * Clean up resources
   */
  cleanup(): void {
    logger.info("[BrowserAgentFactory] Cleanup completed");
  }
}

// Export singleton instance
export const browserAgentFactory = BrowserAgentFactory.getInstance();
