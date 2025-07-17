import type { MockedFunction } from "vitest";
import { vi } from "vitest";
import { cleanupTestBrowserPool } from "../../src/browser/BrowserPool.js";
import { setupBrowser, teardownBrowser } from "./global-browser-setup.js";

// Global test environment setup
beforeAll(async () => {
  // Set test environment variables
  process.env.NODE_ENV = "test";
  process.env.OPENAI_API_KEY = "test-api-key-for-testing";

  // Setup shared browser instance for tests
  await setupBrowser();
});

afterAll(async () => {
  // Clean up environment
  process.env.OPENAI_API_KEY = undefined;

  // Clean up shared browser resources
  await teardownBrowser();
  await cleanupTestBrowserPool();
});

// Make vi available globally for test files that need it
// Note: vi is already declared globally by vitest when globals: true is set

// Custom matchers and utilities
expect.extend({
  toBeValidUUID(received: string) {
    const uuidRegex =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    const pass = uuidRegex.test(received);

    return {
      pass,
      message: () =>
        pass
          ? `Expected ${received} not to be a valid UUID`
          : `Expected ${received} to be a valid UUID`,
    };
  },
});

// Enhanced mock utilities
export const createMockWithImplementation = <
  T extends (...args: unknown[]) => unknown,
>(
  implementation: T
): MockedFunction<T> => {
  return vi.fn(implementation) as MockedFunction<T>;
};

// Test data helpers
export const createTestSessionData = (
  overrides: Partial<{
    harPath: string;
    prompt: string;
    cookiePath?: string;
    inputVariables?: Record<string, string>;
  }> = {}
) => ({
  harPath: "tests/fixtures/test-data/pangea_search.har",
  prompt: "test analysis prompt",
  cookiePath: "tests/fixtures/test-data/pangea_cookies.json",
  inputVariables: { query: "test" },
  ...overrides,
});

export const generateValidUUID = (): string => {
  return "123e4567-e89b-12d3-a456-426614174000";
};
