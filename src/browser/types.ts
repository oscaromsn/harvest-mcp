/**
 * Browser automation types for Harvest MCP
 * Ported from magnitude-core and adapted for HAR/cookie generation use case
 */

import type {
  Browser,
  BrowserContext,
  BrowserContextOptions,
  LaunchOptions,
  Page,
} from "playwright";

// Browser Engine Types
export type BrowserEngine = "chromium" | "firefox" | "webkit";

// Browser Options - simplified from magnitude-core
export type BrowserOptions = (
  | { instance: Browser }
  | { cdp: string }
  | { launchOptions?: LaunchOptions; engine?: BrowserEngine }
) & {
  contextOptions?: BrowserContextOptions;
  primary?: BrowserEngine;
  fallback?: BrowserEngine;
  fallbackOnTimeout?: boolean;
};

// Browser Connector Options - adapted for harvest-mcp
export interface BrowserConnectorOptions {
  browser?: BrowserOptions;
  url?: string;
  virtualScreenDimensions?: { width: number; height: number };
}

// Browser Agent Configuration
export interface BrowserAgentConfig {
  url?: string;
  browserOptions?: {
    headless?: boolean;
    viewport?: {
      width?: number;
      height?: number;
    };
    contextOptions?: {
      deviceScaleFactor?: number;
    };
  };
}

// Artifact Types
export interface Artifact {
  type: "har" | "cookies" | "screenshot" | "log";
  path: string;
  size?: number;
  timestamp?: string;
}

export interface ArtifactCollection {
  artifacts: Artifact[];
  outputDir: string;
  summary: string;
}

// Manual Session Types
export interface ManualSession {
  id: string;
  agent: ManualBrowserAgent;
  startTime: number;
  config: SessionConfig;
  outputDir: string;
  artifacts: Artifact[];
  artifactCollector: import(
    "../browser/ArtifactCollector.js"
  ).ArtifactCollector;
  metadata: {
    currentUrl?: string;
    pageTitle?: string;
    sessionDuration?: number;
    networkRequestCount?: number;
  };
}

export interface SessionConfig {
  url?: string;
  timeout?: number; // Auto-cleanup timeout in minutes
  browserOptions?: {
    headless?: boolean | undefined;
    viewport?: {
      width?: number | undefined;
      height?: number | undefined;
    };
    contextOptions?: {
      deviceScaleFactor?: number | undefined;
    };
  };
  artifactConfig?: {
    enabled?: boolean | undefined;
    outputDir?: string | undefined;
    saveHar?: boolean | undefined;
    saveCookies?: boolean | undefined;
    saveScreenshots?: boolean | undefined;
    autoScreenshotInterval?: number | undefined; // Take screenshots every N seconds
  };
}

export interface BrowserSessionInfo {
  id: string;
  startTime: number;
  currentUrl?: string;
  pageTitle?: string;
  duration: number;
  outputDir: string;
  artifactConfig: SessionConfig["artifactConfig"];
  instructions: string[];
}

export interface SessionStopResult {
  id: string;
  duration: number;
  finalUrl?: string;
  finalPageTitle?: string;
  artifacts: Artifact[];
  summary: string;
  metadata: {
    networkRequestCount: number;
    totalArtifacts: number;
    sessionDurationMs: number;
  };
}

// Browser Agent Interface (for existing browser automation)
export interface BrowserAgent {
  readonly page: Page;
  readonly context: BrowserContext;
  start(): void;
  stop(): Promise<void>;
  getCurrentUrl(): string;
  getCurrentTitle(): string;
  isReady(): boolean;
  isAgentStarted(): boolean;
  getSessionMetadata(): Record<string, unknown>;
}

// Manual Session Browser Agent Interface
export interface ManualBrowserAgent {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  stop(): Promise<void>;
}

// Internal Browser Provider Types
export interface ActiveBrowser {
  browserPromise: Promise<Browser>;
  activeContextsCount: number;
}

export interface FallbackConfig {
  artifacts?: Record<string, unknown>;
  browserEngine?: BrowserEngine;
}

// Default Browser Options
export const DEFAULT_BROWSER_OPTIONS: LaunchOptions = {
  headless: false,
  args: ["--disable-gpu", "--disable-blink-features=AutomationControlled"],
};

// Export common viewport sizes
export const VIEWPORT_SIZES = {
  DESKTOP: { width: 1280, height: 720 },
  LAPTOP: { width: 1024, height: 768 },
  TABLET: { width: 768, height: 1024 },
  MOBILE: { width: 375, height: 667 },
} as const;
