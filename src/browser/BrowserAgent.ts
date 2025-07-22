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
  private contextDestroyedCount = 0;
  private lastContextError: Date | null = null;
  private readonly maxContextErrors = 3;
  private readonly contextErrorWindow = 5000; // 5 seconds

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
   * Check if we're in a circuit breaker state due to repeated context errors
   */
  private isCircuitBreakerOpen(): boolean {
    if (this.contextDestroyedCount >= this.maxContextErrors) {
      const now = new Date();
      if (
        this.lastContextError &&
        now.getTime() - this.lastContextError.getTime() <
          this.contextErrorWindow
      ) {
        return true;
      }
      // Reset circuit breaker after window expires
      this.contextDestroyedCount = 0;
      this.lastContextError = null;
    }
    return false;
  }

  /**
   * Record a context destruction error for circuit breaker
   */
  private recordContextError(): void {
    this.contextDestroyedCount++;
    this.lastContextError = new Date();

    if (this.contextDestroyedCount >= this.maxContextErrors) {
      browserLogger.warn(
        `Circuit breaker opened: too many context destruction errors (${this.contextDestroyedCount})`
      );
    }
  }

  /**
   * Get the current page URL
   */
  getCurrentUrl(): string {
    try {
      // Circuit breaker check
      if (this.isCircuitBreakerOpen()) {
        return "";
      }

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
        this.recordContextError();
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
      // Circuit breaker check
      if (this.isCircuitBreakerOpen()) {
        return "";
      }

      // Check if the page is still valid before trying to get title
      if (!this.page || !this.context || this.page.isClosed()) {
        return "";
      }

      // Additional browser connection check
      if (!this.browser?.isConnected()) {
        return "";
      }

      // Quick context validation check first
      try {
        await this.page.evaluate(
          () =>
            (
              globalThis as typeof globalThis & {
                document?: { readyState?: string };
              }
            ).document?.readyState || "loading"
        );
      } catch (_contextError) {
        // Context is already destroyed, no point in continuing
        this.recordContextError();
        return "";
      }

      // Handle title retrieval with proper async/await and timeout
      const title = await Promise.race([
        this.page.title(),
        new Promise<string>(
          (_, reject) =>
            setTimeout(() => reject(new Error("Title fetch timeout")), 3000) // Reduced timeout
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
        this.recordContextError();
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
