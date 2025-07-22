/**
 * Browser agent for Harvest MCP
 * Simplified from magnitude-core, removing AI/LLM dependencies
 * Provides basic browser automation interface with page and context access
 */

import type { Browser, BrowserContext, Page } from "playwright";
import {
  browserLogger,
  logBrowserError,
  logBrowserOperation,
} from "../utils/logger.js";
import type { BrowserAgent as IBrowserAgent } from "./types.js";

export class BrowserAgent implements IBrowserAgent {
  public readonly page: Page;
  public readonly context: BrowserContext;
  public readonly browser: Browser;
  private isStarted = false;

  constructor(page: Page, context: BrowserContext) {
    this.page = page;
    this.context = context;
    const browser = context.browser();
    if (!browser) {
      throw new Error(
        "Browser context must have an associated browser instance"
      );
    }
    this.browser = browser;

    // Use a try-catch for logging to avoid crashes during construction
    try {
      logBrowserOperation("agent_created", {
        url: this.getCurrentUrl(),
        title: "", // Skip title during construction to avoid context issues
      });
    } catch (_error) {
      // Ignore logging errors during construction
    }
  }

  /**
   * Start the browser agent
   */
  start(): void {
    try {
      if (this.isStarted) {
        browserLogger.debug("Agent already started");
        return;
      }

      logBrowserOperation("agent_start", {
        url: this.getCurrentUrl(),
      });

      // Setup any initial configuration or event listeners here
      // For now, this is a simple implementation

      this.isStarted = true;

      logBrowserOperation("agent_started", {
        url: this.getCurrentUrl(),
        title: "", // Skip title during start to avoid context issues
      });
    } catch (error) {
      logBrowserError(error as Error, { operation: "agent_start" });
      throw error;
    }
  }

  /**
   * Stop the browser agent
   */
  async stop(): Promise<void> {
    try {
      if (!this.isStarted) {
        browserLogger.debug("Agent already stopped");
        return;
      }

      logBrowserOperation("agent_stop", {
        url: this.getCurrentUrl(),
      });

      // Cleanup any event listeners or resources here
      // For now, this is a simple implementation

      this.isStarted = false;

      try {
        logBrowserOperation("agent_stopped", {
          finalUrl: this.getCurrentUrl(),
          finalTitle: "", // Skip title during stop to avoid context issues
        });
      } catch (_error) {
        // Ignore logging errors during shutdown
      }
    } catch (error) {
      logBrowserError(error as Error, { operation: "agent_stop" });
      throw error;
    }
  }

  /**
   * Get the current page URL
   */
  getCurrentUrl(): string {
    try {
      // Check if the page is still valid before trying to get URL
      if (!this.page || !this.context || this.page.isClosed()) {
        return "";
      }

      // Additional browser connection check
      if (!this.browser?.isConnected()) {
        return "";
      }

      return this.page.url();
    } catch (error) {
      // Handle context destruction gracefully
      if (
        error instanceof Error &&
        (error.message.includes("Execution context was destroyed") ||
          error.message.includes(
            "Target page, context or browser has been closed"
          ) ||
          error.message.includes("TargetClosedError") ||
          error.message.includes("Protocol error") ||
          error.message.includes("Navigation"))
      ) {
        browserLogger.debug("Context destroyed while getting URL", {
          error: error.message,
        });
        return "";
      }
      logBrowserError(error as Error, { operation: "get_current_url" });
      return "";
    }
  }

  /**
   * Get the current page title (async version to handle navigation properly)
   */
  async getCurrentTitle(): Promise<string> {
    try {
      // Check if the page is still valid before trying to get title
      if (!this.page || !this.context || this.page.isClosed()) {
        return "";
      }

      // Additional browser connection check
      if (!this.browser?.isConnected()) {
        return "";
      }

      // Handle title retrieval with timeout for robustness
      const title = await Promise.race([
        this.page.title(),
        new Promise<string>((_, reject) =>
          setTimeout(() => reject(new Error("Title fetch timeout")), 3000)
        ),
      ]);

      return title;
    } catch (error) {
      // Handle context destruction gracefully
      if (
        error instanceof Error &&
        (error.message.includes("Execution context was destroyed") ||
          error.message.includes(
            "Target page, context or browser has been closed"
          ) ||
          error.message.includes("TargetClosedError") ||
          error.message.includes("Title fetch timeout") ||
          error.message.includes("Protocol error") ||
          error.message.includes("Navigation"))
      ) {
        browserLogger.debug("Context destroyed while getting title", {
          error: error.message,
        });
        return "";
      }
      logBrowserError(error as Error, { operation: "get_current_title" });
      return "";
    }
  }

  /**
   * Check if the agent is ready for operations
   */
  isReady(): boolean {
    try {
      // Check if page and context are still valid and not closed
      return (
        this.page !== null &&
        this.context !== null &&
        !this.page.isClosed() &&
        this.browser?.isConnected() === true
      );
    } catch (error) {
      logBrowserError(error as Error, { operation: "is_ready_check" });
      return false;
    }
  }

  /**
   * Check if the agent is started
   */
  isAgentStarted(): boolean {
    return this.isStarted;
  }

  /**
   * Get session metadata
   */
  getSessionMetadata(): Record<string, unknown> {
    try {
      return {
        currentUrl: this.getCurrentUrl(),
        currentTitle: "", // Skip title to avoid context issues
        isStarted: this.isStarted,
        isReady: this.isReady(),
        contextId: this.context ? "context-present" : "context-missing",
        pageId: this.page ? "page-present" : "page-missing",
      };
    } catch (error) {
      logBrowserError(error as Error, { operation: "get_session_metadata" });
      return {
        error: "Failed to get session metadata",
        isStarted: this.isStarted,
      };
    }
  }
}
