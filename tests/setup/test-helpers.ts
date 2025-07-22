import type { HarvestSession } from "../../src/types/index.js";

/**
 * Test helpers for creating mock data and utilities
 */

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

// Async test helpers
export const waitFor = (ms: number): Promise<void> => {
  return new Promise((resolve) => setTimeout(resolve, ms));
};
