/**
 * Tests for AgentFactory - browser configuration and agent creation
 * Following TDD approach - write tests first, then implement
 */

import type { Browser, BrowserContext, Page } from "playwright";
import { describe, expect, test } from "vitest";
import { AgentFactory } from "../../../src/browser/AgentFactory.js";
import type {
  BrowserAgentConfig,
  BrowserOptions,
} from "../../../src/browser/types.js";

describe("AgentFactory", () => {
  test("should create AgentFactory instance", () => {
    const factory = new AgentFactory();
    expect(factory).toBeDefined();
    expect(factory).toBeInstanceOf(AgentFactory);
  });

  test("should create agent with existing browser", async () => {
    const factory = new AgentFactory();

    const mockPage = {
      url: () => "https://example.com",
      title: () => "Test Page",
      close: async () => {
        /* Mock implementation */
      },
      goto: async (_url: string) => {
        /* Mock implementation */
      },
    } as unknown as Page;

    const mockContext = {
      pages: () => [mockPage],
      close: async () => {
        /* Mock implementation */
      },
      newPage: async () => mockPage,
      browser: () => mockBrowser,
    } as unknown as BrowserContext;

    const mockBrowser = {
      contexts: () => [],
      close: async () => {
        /* Mock implementation */
      },
      isConnected: () => true,
      newContext: async () => mockContext,
      newPage: async () => mockPage,
      version: () => "1.0.0",
    } as unknown as Browser;

    const config: BrowserAgentConfig = {
      url: "https://example.com",
    };

    const browserOptions: BrowserOptions = {
      instance: mockBrowser,
    };

    const agent = await factory.createAgent(config, browserOptions);
    expect(agent).toBeDefined();
    expect(agent.page).toBe(mockPage);
    expect(agent.context).toBe(mockContext);
  });

  test("should create agent with browser configuration", async () => {
    const factory = new AgentFactory();

    const mockPage = {
      url: () => "https://example.com",
      title: () => "Test Page",
      close: async () => {
        /* Mock implementation */
      },
      goto: async (_url: string) => {
        /* Mock implementation */
      },
    } as unknown as Page;

    const mockContext = {
      pages: () => [mockPage],
      close: async () => {
        /* Mock implementation */
      },
      newPage: async () => mockPage,
      browser: () => mockBrowser,
    } as unknown as BrowserContext;

    const mockBrowser = {
      contexts: () => [],
      close: async () => {
        /* Mock implementation */
      },
      isConnected: () => true,
      newContext: async () => mockContext,
      newPage: async () => mockPage,
      version: () => "1.0.0",
    } as unknown as Browser;

    const config: BrowserAgentConfig = {
      url: "https://example.com",
      browserOptions: {
        headless: true,
        viewport: { width: 1280, height: 720 },
      },
    };

    const browserOptions: BrowserOptions = {
      instance: mockBrowser,
      contextOptions: {
        viewport: { width: 1280, height: 720 },
      },
    };

    const agent = await factory.createAgent(config, browserOptions);
    expect(agent).toBeDefined();
    expect(agent.getCurrentUrl()).toBe("https://example.com");
  });

  test("should navigate to URL if provided in config", async () => {
    const factory = new AgentFactory();

    let navigatedUrl = "";
    const mockPage = {
      url: () => navigatedUrl || "about:blank",
      title: () => "Test Page",
      close: async () => {
        /* Mock implementation */
      },
      goto: (url: string) => {
        navigatedUrl = url;
      },
    } as unknown as Page;

    const mockContext = {
      pages: () => [mockPage],
      close: async () => {
        /* Mock implementation */
      },
      newPage: async () => mockPage,
      browser: () => mockBrowser,
    } as unknown as BrowserContext;

    const mockBrowser = {
      contexts: () => [],
      close: async () => {
        /* Mock implementation */
      },
      isConnected: () => true,
      newContext: async () => mockContext,
      newPage: async () => mockPage,
      version: () => "1.0.0",
    } as unknown as Browser;

    const config: BrowserAgentConfig = {
      url: "https://test.example.com",
    };

    const browserOptions: BrowserOptions = {
      instance: mockBrowser,
    };

    const agent = await factory.createAgent(config, browserOptions);
    expect(agent).toBeDefined();
    expect(navigatedUrl).toBe("https://test.example.com");
  });

  test("should handle creation without URL navigation", async () => {
    const factory = new AgentFactory();

    const mockPage = {
      url: () => "about:blank",
      title: () => "Test Page",
      close: async () => {
        /* Mock implementation */
      },
    } as unknown as Page;

    const mockContext = {
      pages: () => [mockPage],
      close: async () => {
        /* Mock implementation */
      },
      newPage: async () => mockPage,
      browser: () => mockBrowser,
    } as unknown as BrowserContext;

    const mockBrowser = {
      contexts: () => [],
      close: async () => {
        /* Mock implementation */
      },
      isConnected: () => true,
      newContext: async () => mockContext,
      newPage: async () => mockPage,
      version: () => "1.0.0",
    } as unknown as Browser;

    const config: BrowserAgentConfig = {};

    const browserOptions: BrowserOptions = {
      instance: mockBrowser,
    };

    const agent = await factory.createAgent(config, browserOptions);
    expect(agent).toBeDefined();
    expect(agent.getCurrentUrl()).toBe("about:blank");
  });

  test("should handle browser context creation", async () => {
    const factory = new AgentFactory();

    const mockPage = {
      url: () => "https://example.com",
      title: () => "Test Page",
      close: async () => {
        /* Mock implementation */
      },
      goto: async (_url: string) => {
        /* Mock implementation */
      },
    } as unknown as Page;

    const mockContext = {
      pages: () => [mockPage],
      close: async () => {
        /* Mock implementation */
      },
      newPage: async () => mockPage,
      browser: () => mockBrowser,
    } as unknown as BrowserContext;

    const mockBrowser = {
      contexts: () => [],
      close: async () => {
        /* Mock implementation */
      },
      isConnected: () => true,
      newContext: (options: unknown) => {
        // Verify context options are passed through
        expect(options).toEqual({
          viewport: { width: 1024, height: 768 },
          userAgent: "test-agent",
        });
        return mockContext;
      },
      newPage: async () => mockPage,
      version: () => "1.0.0",
    } as unknown as Browser;

    const config: BrowserAgentConfig = {};

    const browserOptions: BrowserOptions = {
      instance: mockBrowser,
      contextOptions: {
        viewport: { width: 1024, height: 768 },
        userAgent: "test-agent",
      },
    };

    const agent = await factory.createAgent(config, browserOptions);
    expect(agent).toBeDefined();
  });

  test("should cleanup resources on failure", async () => {
    const factory = new AgentFactory();

    let contextClosed = false;

    const mockBrowser = {
      contexts: () => [],
      close: async () => {
        /* Mock implementation */
      },
      isConnected: () => true,
      newContext: async () => mockContext,
      newPage: async () => {
        throw new Error("Failed to create page");
      },
      version: () => "1.0.0",
    } as unknown as Browser;

    const mockContext = {
      pages: () => [],
      close: async () => {
        contextClosed = true;
      },
      newPage: async () => {
        throw new Error("Failed to create page");
      },
      browser: () => mockBrowser,
    } as unknown as BrowserContext;

    const config: BrowserAgentConfig = {};

    const browserOptions: BrowserOptions = {
      instance: mockBrowser,
    };

    await expect(factory.createAgent(config, browserOptions)).rejects.toThrow(
      "Failed to create page"
    );
    expect(contextClosed).toBe(true);
  });

  // Note: Tests for actual browser launching and engine selection
  // will be tested in integration tests with real browser instances
});
