/**
 * Artifact collector for Harvest MCP
 * Ported from magnitude-mcp, adapted for harvest-mcp use case
 * Collects HAR files, cookies, and screenshots from browser sessions
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { BrowserContext, Page, Request, Response } from "playwright";
import { logBrowserError, logBrowserOperation } from "../utils/logger.js";
import type { Artifact, ArtifactCollection } from "./types.js";

export interface HarEntry {
  startedDateTime: string;
  time: number;
  request: {
    method: string;
    url: string;
    httpVersion: string;
    headers: Array<{ name: string; value: string }>;
    cookies: Array<{ name: string; value: string }>;
    postData?:
      | {
          mimeType: string;
          text: string;
        }
      | undefined;
  };
  response: {
    status: number;
    statusText: string;
    httpVersion: string;
    headers: Array<{ name: string; value: string }>;
    cookies: Array<{ name: string; value: string }>;
    content: {
      size: number;
      mimeType: string;
      text?: string;
    };
  };
  cache: Record<string, unknown>;
  timings: {
    send: number;
    wait: number;
    receive: number;
  };
}

export interface HarData {
  log: {
    version: string;
    creator: {
      name: string;
      version: string;
    };
    pages: Array<{
      startedDateTime: string;
      id: string;
      title: string;
      pageTimings: {
        onContentLoad: number;
        onLoad: number;
      };
    }>;
    entries: HarEntry[];
  };
}

export interface ScreenshotOptions {
  type?: "png" | "jpeg";
  quality?: number;
  fullPage?: boolean;
  clip?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
}

export class ArtifactCollector {
  private harEntries: HarEntry[] = [];
  private isNetworkTracking = false;
  private requestHandler?: ((request: Request) => void) | undefined;
  private responseHandler?: ((response: Response) => void) | undefined;
  private currentPage?: Page | undefined;
  private intervalScreenshots = new Map<
    string,
    { intervalId: NodeJS.Timeout; artifacts: Artifact[] }
  >();

  constructor() {
    logBrowserOperation("artifact_collector_created");
  }

  /**
   * Get the current number of HAR entries
   */
  getHarEntryCount(): number {
    return this.harEntries.length;
  }

  /**
   * Check if network tracking is active
   */
  isTrackingNetwork(): boolean {
    return this.isNetworkTracking;
  }

  /**
   * Start tracking network requests and responses
   */
  startNetworkTracking(page: Page): void {
    try {
      logBrowserOperation("network_tracking_start", {
        url: page.url(),
      });

      this.currentPage = page;
      this.isNetworkTracking = true;

      // Create request handler
      this.requestHandler = (request: Request) => {
        const harEntry: HarEntry = {
          startedDateTime: new Date().toISOString(),
          time: 0,
          request: {
            method: request.method(),
            url: request.url(),
            httpVersion: "HTTP/1.1", // Default to HTTP/1.1 since Playwright doesn't always expose this
            headers: Object.entries(request.headers()).map(([name, value]) => ({
              name,
              value,
            })),
            cookies: [], // TODO: Extract cookies from headers if needed
            postData: request.postData()
              ? {
                  mimeType:
                    request.headers()["content-type"] ||
                    request.headers()["Content-Type"] ||
                    "application/octet-stream",
                  text: request.postData() || "",
                }
              : undefined,
          },
          response: {
            status: 0,
            statusText: "",
            httpVersion: "HTTP/1.1",
            headers: [],
            cookies: [],
            content: {
              size: 0,
              mimeType: "",
            },
          },
          cache: {},
          timings: {
            send: 0,
            wait: 0,
            receive: 0,
          },
        };

        // Store reference to HAR entry on request for response handler
        (request as Request & { _harEntry: HarEntry })._harEntry = harEntry;
        this.harEntries.push(harEntry);

        logBrowserOperation("network_request_tracked", {
          method: request.method(),
          url: request.url(),
          entryCount: this.harEntries.length,
        });
      };

      // Create response handler
      this.responseHandler = (response: Response) => {
        const harEntry = (
          response.request() as Request & { _harEntry?: HarEntry }
        )._harEntry;
        if (harEntry) {
          harEntry.response = {
            status: response.status(),
            statusText: response.statusText(),
            httpVersion: "HTTP/1.1", // Default to HTTP/1.1 since Playwright doesn't always expose this
            headers: Object.entries(response.headers()).map(
              ([name, value]) => ({
                name,
                value,
              })
            ),
            cookies: [], // TODO: Extract cookies from set-cookie headers if needed
            content: {
              size: Number.parseInt(
                response.headers()["content-length"] || "0",
                10
              ),
              mimeType:
                response.headers()["content-type"] ||
                "application/octet-stream",
            },
          };

          logBrowserOperation("network_response_tracked", {
            status: response.status(),
            url: response.url(),
          });
        }
      };

      // Attach event listeners
      page.on("request", this.requestHandler);
      page.on("response", this.responseHandler);

      logBrowserOperation("network_tracking_started", {
        url: page.url(),
      });
    } catch (error) {
      logBrowserError(error as Error, {
        operation: "start_network_tracking",
        url: page.url(),
      });
      throw error;
    }
  }

  /**
   * Stop tracking network requests and responses
   */
  stopNetworkTracking(): void {
    try {
      if (this.currentPage && this.requestHandler && this.responseHandler) {
        this.currentPage.off("request", this.requestHandler);
        this.currentPage.off("response", this.responseHandler);
      }

      this.isNetworkTracking = false;
      this.currentPage = undefined;
      this.requestHandler = undefined;
      this.responseHandler = undefined;

      logBrowserOperation("network_tracking_stopped", {
        harEntryCount: this.harEntries.length,
      });
    } catch (error) {
      logBrowserError(error as Error, {
        operation: "stop_network_tracking",
      });
      throw error;
    }
  }

  /**
   * Generate HAR file from collected network data
   */
  async generateHarFile(outputPath: string): Promise<Artifact> {
    try {
      logBrowserOperation("har_generation_start", {
        entryCount: this.harEntries.length,
        outputPath,
      });

      // Get page title if available (safely handle destroyed contexts)
      let pageTitle = "Session";
      if (this.currentPage) {
        try {
          // Check if the page context is still alive before getting title
          if (!this.currentPage.isClosed()) {
            const title = await this.currentPage.title();
            pageTitle = typeof title === "string" && title ? title : "Session";
          }
        } catch {
          pageTitle = "Session";
        }
      }

      const harData: HarData = {
        log: {
          version: "1.2",
          creator: {
            name: "harvest-mcp",
            version: "1.0.0",
          },
          pages: [
            {
              startedDateTime: new Date().toISOString(),
              id: "page_1",
              title: pageTitle,
              pageTimings: {
                onContentLoad: -1,
                onLoad: -1,
              },
            },
          ],
          entries: this.harEntries,
        },
      };

      // Ensure output directory exists
      await mkdir(dirname(outputPath), { recursive: true });

      // Write HAR file
      await writeFile(outputPath, JSON.stringify(harData, null, 2), "utf-8");

      const artifact: Artifact = {
        type: "har",
        path: outputPath,
        timestamp: new Date().toISOString(),
      };

      logBrowserOperation("har_generation_complete", {
        entryCount: this.harEntries.length,
        outputPath,
        size: JSON.stringify(harData).length,
      });

      return artifact;
    } catch (error) {
      logBrowserError(error as Error, {
        operation: "har_generation",
        outputPath,
      });
      throw error;
    }
  }

  /**
   * Extract cookies from browser context
   */
  async extractCookies(
    context: BrowserContext,
    outputPath: string
  ): Promise<Artifact> {
    try {
      logBrowserOperation("cookie_extraction_start", {
        outputPath,
      });

      const cookies = await context.cookies();

      const cookieData = {
        collectedAt: new Date().toISOString(),
        totalCookies: cookies.length,
        domains: Array.from(new Set(cookies.map((c) => c.domain))),
        cookies: cookies.map((cookie) => ({
          name: cookie.name,
          value: cookie.value,
          domain: cookie.domain,
          path: cookie.path,
          expires: cookie.expires,
          httpOnly: cookie.httpOnly,
          secure: cookie.secure,
          sameSite: cookie.sameSite,
        })),
      };

      // Ensure output directory exists
      await mkdir(dirname(outputPath), { recursive: true });

      // Write cookie file
      await writeFile(outputPath, JSON.stringify(cookieData, null, 2), "utf-8");

      const artifact: Artifact = {
        type: "cookies",
        path: outputPath,
        timestamp: new Date().toISOString(),
      };

      logBrowserOperation("cookie_extraction_complete", {
        cookieCount: cookies.length,
        outputPath,
        domains: cookieData.domains.length,
      });

      return artifact;
    } catch (error) {
      logBrowserError(error as Error, {
        operation: "cookie_extraction",
        outputPath,
      });
      throw error;
    }
  }

  /**
   * Capture screenshot from page
   */
  async captureScreenshot(page: Page, outputPath: string): Promise<Artifact> {
    try {
      logBrowserOperation("screenshot_capture_start", {
        url: page.url(),
        outputPath,
      });

      // Ensure output directory exists
      await mkdir(dirname(outputPath), { recursive: true });

      // Capture screenshot
      await page.screenshot({
        path: outputPath,
        fullPage: true,
        type: "png",
      });

      const artifact: Artifact = {
        type: "screenshot",
        path: outputPath,
        timestamp: new Date().toISOString(),
      };

      logBrowserOperation("screenshot_capture_complete", {
        url: page.url(),
        outputPath,
      });

      return artifact;
    } catch (error) {
      logBrowserError(error as Error, {
        operation: "screenshot_capture",
        url: page.url(),
        outputPath,
      });
      throw error;
    }
  }

  /**
   * Collect all artifacts (HAR, cookies, screenshot)
   */
  async collectAllArtifacts(
    page: Page,
    context: BrowserContext,
    outputDir: string
  ): Promise<ArtifactCollection> {
    try {
      logBrowserOperation("artifact_collection_start", {
        outputDir,
        url: page.url(),
      });

      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const artifacts: Artifact[] = [];

      // Generate HAR file
      const harPath = join(outputDir, `network-${timestamp}.har`);
      const harArtifact = await this.generateHarFile(harPath);
      artifacts.push(harArtifact);

      // Extract cookies
      const cookiePath = join(outputDir, `cookies-${timestamp}.json`);
      const cookieArtifact = await this.extractCookies(context, cookiePath);
      artifacts.push(cookieArtifact);

      // Capture screenshot
      const screenshotPath = join(outputDir, `screenshot-${timestamp}.png`);
      const screenshotArtifact = await this.captureScreenshot(
        page,
        screenshotPath
      );
      artifacts.push(screenshotArtifact);

      const collection: ArtifactCollection = {
        artifacts,
        outputDir,
        summary: `Collected ${artifacts.length} artifacts to ${outputDir}`,
      };

      logBrowserOperation("artifact_collection_complete", {
        outputDir,
        artifactCount: artifacts.length,
        harEntries: this.harEntries.length,
      });

      return collection;
    } catch (error) {
      logBrowserError(error as Error, {
        operation: "artifact_collection",
        outputDir,
        url: page.url(),
      });
      throw error;
    }
  }

  /**
   * Clear all HAR entries
   */
  clearHarEntries(): void {
    logBrowserOperation("har_entries_cleared", {
      previousCount: this.harEntries.length,
    });
    this.harEntries = [];
  }

  /**
   * Get current HAR entries (for debugging)
   */
  getHarEntries(): readonly HarEntry[] {
    return this.harEntries;
  }

  /**
   * Capture screenshot with custom options
   */
  async captureScreenshotWithOptions(
    page: Page,
    outputPath: string,
    options: ScreenshotOptions = {}
  ): Promise<Artifact> {
    try {
      logBrowserOperation("screenshot_capture_with_options_start", {
        url: page.url(),
        outputPath,
        options,
      });

      // Ensure output directory exists
      await mkdir(dirname(outputPath), { recursive: true });

      // Prepare screenshot options
      const screenshotOptions: {
        path: string;
        type: "png" | "jpeg";
        fullPage: boolean;
        quality?: number;
        clip?: {
          x: number;
          y: number;
          width: number;
          height: number;
        };
      } = {
        path: outputPath,
        type: options.type || "png",
        fullPage: options.fullPage !== undefined ? options.fullPage : true,
      };

      if (options.quality !== undefined && options.type === "jpeg") {
        screenshotOptions.quality = options.quality;
      }

      if (options.clip) {
        screenshotOptions.clip = options.clip;
        screenshotOptions.fullPage = false; // Can't use fullPage with clip
      }

      // Capture screenshot
      await page.screenshot(screenshotOptions);

      const artifact: Artifact = {
        type: "screenshot",
        path: outputPath,
        timestamp: new Date().toISOString(),
      };

      logBrowserOperation("screenshot_capture_with_options_complete", {
        url: page.url(),
        outputPath,
        options,
      });

      return artifact;
    } catch (error) {
      logBrowserError(error as Error, {
        operation: "screenshot_capture_with_options",
        url: page.url(),
        outputPath,
        options,
      });
      throw error;
    }
  }

  /**
   * Capture viewport-only screenshot
   */
  captureViewportScreenshot(page: Page, outputPath: string): Promise<Artifact> {
    return this.captureScreenshotWithOptions(page, outputPath, {
      fullPage: false,
    });
  }

  /**
   * Capture full page screenshot
   */
  captureFullPageScreenshot(page: Page, outputPath: string): Promise<Artifact> {
    return this.captureScreenshotWithOptions(page, outputPath, {
      fullPage: true,
    });
  }

  /**
   * Capture multiple screenshots at timed intervals
   */
  async captureTimedScreenshots(
    page: Page,
    outputDir: string,
    count: number,
    intervalMs: number
  ): Promise<Artifact[]> {
    try {
      logBrowserOperation("timed_screenshots_start", {
        url: page.url(),
        outputDir,
        count,
        intervalMs,
      });

      const artifacts: Artifact[] = [];

      for (let i = 0; i < count; i++) {
        const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
        const outputPath = join(outputDir, `timed-screenshot-${timestamp}.png`);

        const artifact = await this.captureScreenshot(page, outputPath);
        artifacts.push(artifact);

        // Wait for interval before next screenshot (except for last one)
        if (i < count - 1) {
          await new Promise((resolve) => setTimeout(resolve, intervalMs));
        }
      }

      logBrowserOperation("timed_screenshots_complete", {
        url: page.url(),
        outputDir,
        count: artifacts.length,
      });

      return artifacts;
    } catch (error) {
      logBrowserError(error as Error, {
        operation: "timed_screenshots",
        url: page.url(),
        outputDir,
        count,
        intervalMs,
      });
      throw error;
    }
  }

  /**
   * Start interval-based screenshot capture
   */
  startIntervalScreenshots(
    page: Page,
    outputDir: string,
    intervalMs: number
  ): string {
    try {
      const sessionId = `interval-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

      logBrowserOperation("interval_screenshots_start", {
        sessionId,
        url: page.url(),
        outputDir,
        intervalMs,
      });

      const artifacts: Artifact[] = [];

      const intervalId = setInterval(async () => {
        try {
          const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
          const outputPath = join(
            outputDir,
            `interval-screenshot-${timestamp}.png`
          );

          const artifact = await this.captureScreenshot(page, outputPath);
          artifacts.push(artifact);

          logBrowserOperation("interval_screenshot_captured", {
            sessionId,
            path: outputPath,
            count: artifacts.length,
          });
        } catch (error) {
          logBrowserError(error as Error, {
            operation: "interval_screenshot_capture",
            sessionId,
            url: page.url(),
          });
        }
      }, intervalMs);

      // Store interval reference
      this.intervalScreenshots.set(sessionId, { intervalId, artifacts });

      logBrowserOperation("interval_screenshots_started", {
        sessionId,
        url: page.url(),
        intervalMs,
      });

      return sessionId;
    } catch (error) {
      logBrowserError(error as Error, {
        operation: "start_interval_screenshots",
        url: page.url(),
        outputDir,
        intervalMs,
      });
      throw error;
    }
  }

  /**
   * Stop interval-based screenshot capture
   */
  stopIntervalScreenshots(sessionId: string): Artifact[] {
    try {
      logBrowserOperation("interval_screenshots_stop", {
        sessionId,
      });

      const session = this.intervalScreenshots.get(sessionId);
      if (!session) {
        throw new Error(`Interval screenshot session not found: ${sessionId}`);
      }

      // Clear the interval
      clearInterval(session.intervalId);

      // Get captured artifacts
      const artifacts = [...session.artifacts];

      // Clean up session
      this.intervalScreenshots.delete(sessionId);

      logBrowserOperation("interval_screenshots_stopped", {
        sessionId,
        artifactCount: artifacts.length,
      });

      return artifacts;
    } catch (error) {
      logBrowserError(error as Error, {
        operation: "stop_interval_screenshots",
        sessionId,
      });
      throw error;
    }
  }

  /**
   * Capture screenshot of a specific element
   */
  async captureElementScreenshot(
    page: Page,
    outputPath: string,
    selector: string
  ): Promise<Artifact> {
    try {
      logBrowserOperation("element_screenshot_start", {
        url: page.url(),
        outputPath,
        selector,
      });

      // Ensure output directory exists
      await mkdir(dirname(outputPath), { recursive: true });

      // Get element and capture screenshot
      const element = page.locator(selector);
      await element.screenshot({
        path: outputPath,
        type: "png",
      });

      const artifact: Artifact = {
        type: "screenshot",
        path: outputPath,
        timestamp: new Date().toISOString(),
      };

      logBrowserOperation("element_screenshot_complete", {
        url: page.url(),
        outputPath,
        selector,
      });

      return artifact;
    } catch (error) {
      logBrowserError(error as Error, {
        operation: "element_screenshot",
        url: page.url(),
        outputPath,
        selector,
      });
      throw error;
    }
  }

  /**
   * Cleanup all interval screenshots
   */
  cleanup(): void {
    logBrowserOperation("artifact_collector_cleanup_start", {
      activeIntervals: this.intervalScreenshots.size,
    });

    for (const [sessionId, session] of this.intervalScreenshots) {
      clearInterval(session.intervalId);
      logBrowserOperation("interval_screenshot_cleaned", {
        sessionId,
        artifactCount: session.artifacts.length,
      });
    }

    this.intervalScreenshots.clear();

    logBrowserOperation("artifact_collector_cleanup_complete");
  }
}
