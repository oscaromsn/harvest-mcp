import { vi } from "vitest";
import type {
  HarvestSession,
  RequestModel,
  URLInfo,
} from "../../src/types/index.js";

/**
 * Test helpers for creating mock data and utilities
 */

// Mock data factories
export const createMockURLInfo = (
  overrides: Partial<URLInfo> = {}
): URLInfo => ({
  method: "GET",
  url: "https://api.example.com/test",
  requestType: "GET",
  responseType: "JSON",
  ...overrides,
});

export const createMockRequestModel = (
  overrides: Partial<RequestModel> = {}
): RequestModel => ({
  method: "GET",
  url: "https://api.example.com/test",
  headers: {},
  queryParams: {},
  body: undefined,
  timestamp: new Date(),
  toCurlCommand: () => "curl -X GET https://api.example.com/test",
  ...overrides,
});

export const createMockSession = (
  overrides: Partial<HarvestSession> = {}
): HarvestSession => ({
  id: "test-session-id",
  prompt: "test prompt",
  harData: {
    requests: [],
    urls: [],
  },
  dagManager: {} as HarvestSession["dagManager"], // Will be mocked in specific tests
  state: {
    toBeProcessedNodes: [],
    inProcessNodeDynamicParts: [],
    inputVariables: {},
    isComplete: false,
    logs: [],
    workflowGroups: new Map(),
  },
  createdAt: new Date("2024-01-01T00:00:00Z"),
  lastActivity: new Date("2024-01-01T00:00:00Z"),
  ...overrides,
});

// Test environment helpers
export const withTestEnvironment = (envVars: Record<string, string>) => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    Object.assign(process.env, envVars);
  });

  afterEach(() => {
    process.env = originalEnv;
  });
};

// Mock file system helpers
export const mockFileExists = (exists = true) => {
  return vi.fn().mockResolvedValue(exists);
};

export const mockFileRead = (content: string | Buffer) => {
  return vi.fn().mockResolvedValue(content);
};

// Async test helpers
export const waitFor = (ms: number): Promise<void> => {
  return new Promise((resolve) => setTimeout(resolve, ms));
};

export const waitForCondition = async (
  condition: () => boolean | Promise<boolean>,
  timeout = 5000,
  interval = 100
): Promise<void> => {
  const start = Date.now();

  while (Date.now() - start < timeout) {
    if (await condition()) {
      return;
    }
    await waitFor(interval);
  }

  throw new Error(`Condition not met within ${timeout}ms`);
};

// Mock cleanup helpers
export const cleanupMocks = () => {
  vi.clearAllMocks();
  vi.resetAllMocks();
  vi.restoreAllMocks();
};

// Test assertion helpers
export const expectToThrow = async (
  fn: () => Promise<unknown>,
  expectedError?: string | RegExp
): Promise<void> => {
  try {
    await fn();
    throw new Error("Expected function to throw, but it did not");
  } catch (error) {
    if (expectedError) {
      if (error instanceof Error) {
        if (typeof expectedError === "string") {
          expect(error.message).toContain(expectedError);
        } else {
          expect(error.message).toMatch(expectedError);
        }
      } else {
        throw new Error("Caught value is not an Error instance");
      }
    }
  }
};

// Performance test helpers
export const measureExecutionTime = async <T>(
  fn: () => Promise<T>
): Promise<{ result: T; duration: number }> => {
  const start = performance.now();
  const result = await fn();
  const duration = performance.now() - start;

  return { result, duration };
};
