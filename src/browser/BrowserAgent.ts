/**
 * Browser agent for Harvest MCP
 * Simplified from magnitude-core, removing AI/LLM dependencies
 * Provides basic browser automation interface with page and context access
 */

import type { BrowserContext, Page } from "playwright";
import {
  browserLogger,
  logBrowserError,
  logBrowserOperation,
} from "../utils/logger.js";
import type { BrowserAgent as IBrowserAgent } from "./types.js";

export class BrowserAgent implements IBrowserAgent {
  public readonly page: Page;
  public readonly context: BrowserContext;
  private isStarted = false;

  constructor(page: Page, context: BrowserContext) {
    this.page = page;
    this.context = context;

    logBrowserOperation("agent_created", {
      url: this.getCurrentUrl(),
      title: this.getCurrentTitle(),
    });
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
        title: this.getCurrentTitle(),
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

      logBrowserOperation("agent_stopped", {
        finalUrl: this.getCurrentUrl(),
        finalTitle: this.getCurrentTitle(),
      });
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
      return this.page.url();
    } catch (error) {
      logBrowserError(error as Error, { operation: "get_current_url" });
      return "";
    }
  }

  /**
   * Get the current page title (synchronous version - returns current cached title)
   */
  getCurrentTitle(): string {
    try {
      // Use the synchronous approach with empty string fallback
      // In real usage, this would need to be async, but for our interface we'll use a fallback
      return ""; // Simplified for now - in real implementation would cache the title
    } catch (error) {
      logBrowserError(error as Error, { operation: "get_current_title" });
      return "";
    }
  }

  /**
   * Check if the agent is ready for operations
   */
  isReady(): boolean {
    try {
      // Check if page and context are still valid
      return this.page !== null && this.context !== null;
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
        currentTitle: this.getCurrentTitle(),
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
