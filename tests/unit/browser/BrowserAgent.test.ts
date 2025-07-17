/**
 * Tests for BrowserAgent - simplified browser automation interface
 * Following TDD approach - write tests first, then implement
 */

import type { Browser, BrowserContext, Page } from "playwright";
import { describe, expect, test } from "vitest";
import { BrowserAgent } from "../../../src/browser/BrowserAgent.js";

describe("BrowserAgent", () => {
  // Create shared mock objects
  const mockBrowser = {
    close: async () => {
      /* Mock implementation */
    },
    isConnected: () => true,
    version: () => "1.0.0",
  } as unknown as Browser;

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
    browser: () => mockBrowser,
  } as unknown as BrowserContext;

  test("should create BrowserAgent instance", () => {
    const agent = new BrowserAgent(mockPage, mockContext);
    expect(agent).toBeDefined();
    expect(agent).toBeInstanceOf(BrowserAgent);
  });

  test("should provide access to page", () => {
    const agent = new BrowserAgent(mockPage, mockContext);
    expect(agent.page).toBe(mockPage);
  });

  test("should provide access to context", () => {
    const agent = new BrowserAgent(mockPage, mockContext);
    expect(agent.context).toBe(mockContext);
  });

  test("should provide access to browser", () => {
    const agent = new BrowserAgent(mockPage, mockContext);
    expect(agent.browser).toBe(mockBrowser);
  });

  test("should start agent successfully", () => {
    const agent = new BrowserAgent(mockPage, mockContext);
    expect(() => agent.start()).not.toThrow();
  });

  test("should stop agent successfully", () => {
    const agent = new BrowserAgent(mockPage, mockContext);
    expect(() => agent.stop()).not.toThrow();
  });

  test("should handle start and stop lifecycle", () => {
    const agent = new BrowserAgent(mockPage, mockContext);

    // Should be able to start and stop multiple times
    agent.start();
    agent.stop();
    agent.start();
    agent.stop();
  });

  test("should get current page URL", () => {
    const mockPageWithUrl = {
      url: () => "https://example.com/test",
      title: () => "Test Page",
      close: async () => {
        /* Mock implementation */
      },
    } as unknown as Page;

    const agent = new BrowserAgent(mockPageWithUrl, mockContext);
    expect(agent.getCurrentUrl()).toBe("https://example.com/test");
  });

  test("should get current page title", () => {
    const mockPageWithTitle = {
      url: () => "https://example.com",
      title: () => "Custom Test Page",
      close: async () => {
        /* Mock implementation */
      },
    } as unknown as Page;

    const agent = new BrowserAgent(mockPageWithTitle, mockContext);
    expect(agent.getCurrentTitle()).toBe("Custom Test Page");
  });

  test("should check if agent is ready", () => {
    const agent = new BrowserAgent(mockPage, mockContext);
    expect(agent.isReady()).toBe(true);
  });
});
