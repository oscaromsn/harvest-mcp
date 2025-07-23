/**
 * Test data fixtures and utilities for Harvest MCP tests
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  DynamicPartsResponse,
  InputVariablesResponse,
  SessionStartParams,
} from "../../src/types/index.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Test file paths
export const TEST_HAR_PATH = path.join(
  __dirname,
  "test-data",
  "pangea_search.har"
);
export const TEST_COOKIE_PATH = path.join(
  __dirname,
  "test-data",
  "pangea_cookies.json"
);

// Test session data factory
export const createTestSessionData = (
  overrides: Partial<SessionStartParams> = {}
) => ({
  harPath: TEST_HAR_PATH,
  cookiePath: TEST_COOKIE_PATH,
  prompt: "Test analysis workflow for dependency resolution",
  inputVariables: { query: "test" },
  ...overrides,
});

// Mock responses for LLM testing
// URLIdentificationAgent removed - modern workflow discovery handles URL identification
export const createMockURLResponse = (
  url = "https://pangeabnp.pdpj.jus.br/api/v1/precedentes"
) => ({
  url,
});

export const createMockDynamicPartsResponse = (
  parts: string[] = ["auth_token", "session_id"]
): DynamicPartsResponse => ({
  dynamic_parts: parts,
});

export const createMockInputVariablesResponse = (
  variables: Record<string, string> = {}
): InputVariablesResponse => ({
  identified_variables: Object.entries(variables).map(([key, value]) => ({
    variable_name: key,
    variable_value: value,
  })),
});


// Test data validation helpers
export const isValidTestSession = (
  sessionData: SessionStartParams
): boolean => {
  return (
    typeof sessionData.harPath === "string" &&
    typeof sessionData.prompt === "string" &&
    sessionData.harPath.length > 0 &&
    sessionData.prompt.length > 0
  );
};

export const isValidSessionId = (sessionId: string): boolean => {
  const uuidRegex =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidRegex.test(sessionId);
};
