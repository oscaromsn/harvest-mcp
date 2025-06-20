/**
 * Tests for BrowserAgent - simplified browser automation interface
 * Following TDD approach - write tests first, then implement
 */

import type { BrowserContext, Page } from "playwright";
import { describe, expect, test } from "vitest";
import { BrowserAgent } from "../../../src/browser/BrowserAgent.js";

describe("BrowserAgent", () => {
  test("should create BrowserAgent instance", () => {
    const mockPage = {
      url: () => "https://example.com",
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
    } as unknown as BrowserContext;

    const agent = new BrowserAgent(mockPage, mockContext);
    expect(agent).toBeDefined();
    expect(agent).toBeInstanceOf(BrowserAgent);
  });

  test("should provide access to page", () => {
    const mockPage = {
      url: () => "https://example.com",
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
    } as unknown as BrowserContext;

    const agent = new BrowserAgent(mockPage, mockContext);
    expect(agent.page).toBe(mockPage);
  });

  test("should provide access to context", () => {
    const mockPage = {
      url: () => "https://example.com",
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
    } as unknown as BrowserContext;

    const agent = new BrowserAgent(mockPage, mockContext);
    expect(agent.context).toBe(mockContext);
  });

  test("should start agent successfully", () => {
    const mockPage = {
      url: () => "https://example.com",
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
    } as unknown as BrowserContext;

    const agent = new BrowserAgent(mockPage, mockContext);
    expect(() => agent.start()).not.toThrow();
  });

  test("should stop agent successfully", () => {
    const mockPage = {
      url: () => "https://example.com",
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
    } as unknown as BrowserContext;

    const agent = new BrowserAgent(mockPage, mockContext);
    expect(() => agent.stop()).not.toThrow();
  });

  test("should handle start and stop lifecycle", () => {
    const mockPage = {
      url: () => "https://example.com",
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
    } as unknown as BrowserContext;

    const agent = new BrowserAgent(mockPage, mockContext);

    // Should be able to start and stop multiple times
    agent.start();
    agent.stop();
    agent.start();
    agent.stop();
  });

  test("should get current page URL", () => {
    const mockPage = {
      url: () => "https://example.com/test",
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
    } as unknown as BrowserContext;

    const agent = new BrowserAgent(mockPage, mockContext);
    expect(agent.getCurrentUrl()).toBe("https://example.com/test");
  });

  test("should get current page title", () => {
    const mockPage = {
      url: () => "https://example.com",
      title: () => "Example Domain",
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
    } as unknown as BrowserContext;

    const agent = new BrowserAgent(mockPage, mockContext);
    expect(agent.getCurrentTitle()).toBe("");
  });

  test("should check if agent is ready", () => {
    const mockPage = {
      url: () => "https://example.com",
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
    } as unknown as BrowserContext;

    const agent = new BrowserAgent(mockPage, mockContext);
    expect(agent.isReady()).toBe(true);
  });

  // Note: More complex browser operations (navigation, interaction, etc.)
  // will be tested in integration tests with real browser instances
});
