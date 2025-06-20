/**
 * Tests for BrowserProvider - browser instance management
 * Following TDD approach - write tests first, then implement
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Browser } from "playwright";
import type { BrowserOptions, BrowserEngine } from "../../src/browser/types.js";

describe("BrowserProvider", () => {
  let mockBrowser: Browser;

  beforeEach(() => {
    // Mock browser instance
    mockBrowser = {
      contexts: vi.fn().mockReturnValue([]),
      close: vi.fn(),
      isConnected: vi.fn().mockReturnValue(true),
      newContext: vi.fn(),
      newPage: vi.fn(),
      version: vi.fn().mockReturnValue("1.0.0"),
    } as unknown as Browser;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  test("should be able to import BrowserProvider", async () => {
    const { BrowserProvider } = await import("../../src/browser/BrowserProvider.js");
    expect(BrowserProvider).toBeDefined();
  });

  test("should create BrowserProvider instance", async () => {
    const { BrowserProvider } = await import("../../src/browser/BrowserProvider.js");
    
    const provider = new BrowserProvider();
    expect(provider).toBeDefined();
  });

  test("should launch browser with default options", async () => {
    const { BrowserProvider } = await import("../../src/browser/BrowserProvider.js");
    
    const provider = new BrowserProvider();
    
    // Mock playwright launch
    vi.doMock("playwright", () => ({
      chromium: {
        launch: vi.fn().mockResolvedValue(mockBrowser),
      },
    }));

    const browser = await provider.getBrowser();
    expect(browser).toBeDefined();
  });

  test("should launch browser with chromium engine", async () => {
    const { BrowserProvider } = await import("../../src/browser/BrowserProvider.js");
    
    const provider = new BrowserProvider();
    const options: BrowserOptions = {
      launchOptions: { headless: true },
      engine: "chromium",
    };

    vi.doMock("playwright", () => ({
      chromium: {
        launch: vi.fn().mockResolvedValue(mockBrowser),
      },
    }));

    const browser = await provider.getBrowser(options);
    expect(browser).toBeDefined();
  });

  test("should support firefox engine", async () => {
    const { BrowserProvider } = await import("../../src/browser/BrowserProvider.js");
    
    const provider = new BrowserProvider();
    const options: BrowserOptions = {
      launchOptions: { headless: true },
      engine: "firefox",
    };

    vi.doMock("playwright", () => ({
      firefox: {
        launch: vi.fn().mockResolvedValue(mockBrowser),
      },
    }));

    const browser = await provider.getBrowser(options);
    expect(browser).toBeDefined();
  });

  test("should support webkit engine", async () => {
    const { BrowserProvider } = await import("../../src/browser/BrowserProvider.js");
    
    const provider = new BrowserProvider();
    const options: BrowserOptions = {
      launchOptions: { headless: true },
      engine: "webkit",
    };

    vi.doMock("playwright", () => ({
      webkit: {
        launch: vi.fn().mockResolvedValue(mockBrowser),
      },
    }));

    const browser = await provider.getBrowser(options);
    expect(browser).toBeDefined();
  });

  test("should reuse existing browser instance", async () => {
    const { BrowserProvider } = await import("../../src/browser/BrowserProvider.js");
    
    const provider = new BrowserProvider();

    vi.doMock("playwright", () => ({
      chromium: {
        launch: vi.fn().mockResolvedValue(mockBrowser),
      },
    }));

    const browser1 = await provider.getBrowser();
    const browser2 = await provider.getBrowser();
    
    expect(browser1).toBe(browser2);
  });

  test("should support existing browser instance", async () => {
    const { BrowserProvider } = await import("../../src/browser/BrowserProvider.js");
    
    const provider = new BrowserProvider();
    const options: BrowserOptions = {
      instance: mockBrowser,
    };

    const browser = await provider.getBrowser(options);
    expect(browser).toBe(mockBrowser);
  });

  test("should support CDP connection", async () => {
    const { BrowserProvider } = await import("../../src/browser/BrowserProvider.js");
    
    const provider = new BrowserProvider();
    const options: BrowserOptions = {
      cdp: "ws://localhost:9222/devtools/browser/123",
    };

    vi.doMock("playwright", () => ({
      chromium: {
        connect: vi.fn().mockResolvedValue(mockBrowser),
      },
    }));

    const browser = await provider.getBrowser(options);
    expect(browser).toBeDefined();
  });

  test("should create new context with options", async () => {
    const { BrowserProvider } = await import("../../src/browser/BrowserProvider.js");
    
    const provider = new BrowserProvider();
    const browserOptions: BrowserOptions = {
      instance: mockBrowser,
      contextOptions: {
        viewport: { width: 1280, height: 720 },
        userAgent: "test-agent",
      },
    };

    const mockContext = {
      close: vi.fn(),
      newPage: vi.fn(),
    };

    mockBrowser.newContext = vi.fn().mockResolvedValue(mockContext);

    const context = await provider.createContext(browserOptions);
    expect(context).toBe(mockContext);
    expect(mockBrowser.newContext).toHaveBeenCalledWith({
      viewport: { width: 1280, height: 720 },
      userAgent: "test-agent",
    });
  });

  test("should handle browser cleanup", async () => {
    const { BrowserProvider } = await import("../../src/browser/BrowserProvider.js");
    
    const provider = new BrowserProvider();
    const options: BrowserOptions = {
      instance: mockBrowser,
    };

    await provider.getBrowser(options);
    await provider.cleanup();

    expect(mockBrowser.close).toHaveBeenCalled();
  });

  test("should handle fallback browser engine", async () => {
    const { BrowserProvider } = await import("../../src/browser/BrowserProvider.js");
    
    const provider = new BrowserProvider();
    const options: BrowserOptions = {
      launchOptions: { headless: true },
      engine: "chromium",
      fallback: "firefox",
      fallbackOnTimeout: true,
    };

    // Mock chromium to fail
    const mockFirefoxBrowser = { ...mockBrowser };
    
    vi.doMock("playwright", () => ({
      chromium: {
        launch: vi.fn().mockRejectedValue(new Error("Chromium launch failed")),
      },
      firefox: {
        launch: vi.fn().mockResolvedValue(mockFirefoxBrowser),
      },
    }));

    const browser = await provider.getBrowser(options);
    expect(browser).toBe(mockFirefoxBrowser);
  });

  test("should track active contexts count", async () => {
    const { BrowserProvider } = await import("../../src/browser/BrowserProvider.js");
    
    const provider = new BrowserProvider();
    const options: BrowserOptions = {
      instance: mockBrowser,
    };

    const mockContext = {
      close: vi.fn(),
      newPage: vi.fn(),
    };

    mockBrowser.newContext = vi.fn().mockResolvedValue(mockContext);

    await provider.createContext(options);
    expect(provider.getActiveContextsCount()).toBe(1);

    await provider.closeContext(mockContext);
    expect(provider.getActiveContextsCount()).toBe(0);
  });
});