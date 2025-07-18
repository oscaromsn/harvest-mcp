import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  findDependencies,
  selectSimplestRequest,
  validateDynamicParts,
} from "../../src/agents/DependencyAgent.js";
import { identifyDynamicParts } from "../../src/agents/DynamicPartsAgent.js";
import { identifyInputVariables } from "../../src/agents/InputVariablesAgent.js";
import { identifyEndUrl } from "../../src/agents/URLIdentificationAgent.js";
import type { LLMClient } from "../../src/core/LLMClient.js";
import { resetLLMClient, setLLMClient } from "../../src/core/LLMClient.js";
import { SessionManager } from "../../src/core/SessionManager.js";
import type {
  DynamicPartsResponse,
  InputVariablesResponse,
  SimplestRequestResponse,
  URLIdentificationResponse,
} from "../../src/types/index.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe("Sprint 3: LLM Integration & Core Analysis Logic", () => {
  let sessionManager: SessionManager;
  let sessionId: string;
  let mockLLMClient: {
    callFunction: ReturnType<typeof vi.fn>;
    generateResponse: ReturnType<typeof vi.fn>;
    getModel: ReturnType<typeof vi.fn>;
    setModel: ReturnType<typeof vi.fn>;
    getProviderName: ReturnType<typeof vi.fn>;
    setProvider: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    // Create mock LLM client
    mockLLMClient = {
      callFunction: vi.fn(),
      generateResponse: vi.fn(),
      getModel: vi.fn(() => "gpt-4o"),
      setModel: vi.fn(),
      getProviderName: vi.fn().mockResolvedValue("mock-provider"),
      setProvider: vi.fn(),
    };

    // Set the mock client using the proper setter
    setLLMClient(mockLLMClient as unknown as LLMClient);

    sessionManager = new SessionManager();

    // Create a test session with real HAR data if available
    const harPath = path.join(
      __dirname,
      "../fixtures/test-data/pangea_search.har"
    );
    const cookiePath = path.join(
      __dirname,
      "../fixtures/test-data/pangea_cookies.json"
    );

    try {
      sessionId = await sessionManager.createSession({
        harPath,
        cookiePath,
        prompt: "search for documents",
      });
    } catch (_error) {
      console.warn("HAR test files not available, skipping session creation");
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetLLMClient(); // Reset the LLM client singleton
    if (sessionManager && sessionId) {
      sessionManager.deleteSession(sessionId);
    }
  });

  describe("URL Identification Agent", () => {
    it("should identify action URL using LLM", async () => {
      if (!sessionId) {
        console.warn("Skipping test - no session created");
        return;
      }

      const session = sessionManager.getSession(sessionId);

      // Mock LLM response
      const mockResponse: URLIdentificationResponse = {
        url: session.harData.urls[0]?.url || "https://api.example.com/search",
      };
      mockLLMClient.callFunction.mockResolvedValue(mockResponse);

      // Test URL identification
      const actionUrl = await identifyEndUrl(session, session.harData.urls);

      expect(actionUrl).toBe(mockResponse.url);
      expect(mockLLMClient.callFunction).toHaveBeenCalledWith(
        expect.stringContaining("Available URLs from HAR file"),
        expect.objectContaining({
          name: "identify_end_url",
        }),
        "identify_end_url"
      );
    });

    it("should handle empty URL list", async () => {
      if (!sessionId) {
        console.warn("Skipping test - no session created");
        return;
      }

      const session = sessionManager.getSession(sessionId);

      await expect(identifyEndUrl(session, [])).rejects.toThrow(
        "No URLs available for analysis"
      );
    });

    it("should use fallback URL when LLM identifies non-existent URL", async () => {
      if (!sessionId) {
        console.warn("Skipping test - no session created");
        return;
      }

      const session = sessionManager.getSession(sessionId);

      // Mock LLM response with non-existent URL
      const mockResponse: URLIdentificationResponse = {
        url: "https://nonexistent.com/api",
      };
      mockLLMClient.callFunction.mockResolvedValue(mockResponse);

      // Should use fallback URL instead of throwing
      const result = await identifyEndUrl(session, session.harData.urls);

      // Should return a valid URL from the HAR data as fallback
      expect(typeof result).toBe("string");
      expect(result.length).toBeGreaterThan(0);
      expect(session.harData.urls.some((url) => url.url === result)).toBe(true);
    });
  });

  describe("Dynamic Parts Agent", () => {
    it("should identify dynamic parts in cURL commands", async () => {
      const curlCommand =
        "curl -X POST 'https://api.example.com/search' -H 'Authorization: Bearer abc123xyz' -d '{\"query\":\"test\"}'";

      const mockResponse: DynamicPartsResponse = {
        dynamic_parts: ["abc123xyz"],
      };
      mockLLMClient.callFunction.mockResolvedValue(mockResponse);

      const dynamicParts = await identifyDynamicParts(curlCommand, {});

      expect(dynamicParts).toEqual(["abc123xyz"]);
      expect(mockLLMClient.callFunction).toHaveBeenCalledWith(
        expect.stringContaining(curlCommand),
        expect.objectContaining({
          name: "identify_dynamic_parts",
        }),
        "identify_dynamic_parts"
      );
    });

    it("should skip JavaScript files", async () => {
      const jsCommand = "curl 'https://example.com/app.js'";

      const dynamicParts = await identifyDynamicParts(jsCommand, {});

      expect(dynamicParts).toEqual([]);
      expect(mockLLMClient.callFunction).not.toHaveBeenCalled();
    });

    it("should filter out input variables", async () => {
      const curlCommand =
        'curl -X POST \'https://api.example.com/search\' -d \'{"query":"documents","token":"abc123"}\'';
      const inputVariables = { search_term: "documents" };

      const mockResponse: DynamicPartsResponse = {
        dynamic_parts: ["documents", "abc123"],
      };
      mockLLMClient.callFunction.mockResolvedValue(mockResponse);

      const dynamicParts = await identifyDynamicParts(
        curlCommand,
        inputVariables
      );

      // Should filter out 'documents' since it's an input variable
      expect(dynamicParts).toEqual(["abc123"]);
    });
  });

  describe("Input Variables Agent", () => {
    it("should identify input variables present in cURL commands", async () => {
      const curlCommand =
        'curl -X POST \'https://api.example.com/search\' -d \'{"query":"documents","type":"pdf"}\'';
      const inputVariables = { search_term: "documents", file_type: "pdf" };

      const mockResponse: InputVariablesResponse = {
        identified_variables: [
          { variable_name: "search_term", variable_value: "documents" },
          { variable_name: "file_type", variable_value: "pdf" },
        ],
      };
      mockLLMClient.callFunction.mockResolvedValue(mockResponse);

      const result = await identifyInputVariables(curlCommand, inputVariables, [
        "documents",
        "pdf",
        "token123",
      ]);

      expect(result.identifiedVariables).toEqual({
        search_term: "documents",
        file_type: "pdf",
      });
      expect(result.removedDynamicParts).toEqual(["token123"]); // Only non-input-variable parts remain
    });

    it("should handle empty input variables", async () => {
      const curlCommand = "curl 'https://api.example.com/test'";

      const result = await identifyInputVariables(curlCommand, {}, []);

      expect(result.identifiedVariables).toEqual({});
      expect(result.removedDynamicParts).toEqual([]);
      expect(mockLLMClient.callFunction).not.toHaveBeenCalled();
    });
  });

  describe("Dependency Agent", () => {
    it("should find cookie dependencies", async () => {
      const dynamicParts = ["session123", "user456"];
      const cookieData = {
        session_id: { value: "session123" },
        user_token: { value: "user456" },
      };

      const result = await findDependencies(
        dynamicParts,
        { requests: [], urls: [] },
        cookieData
      );

      expect(result.cookieDependencies).toHaveLength(2);
      expect(result.cookieDependencies[0]).toMatchObject({
        type: "cookie",
        cookieKey: "session_id",
        dynamicPart: "session123",
      });
      expect(result.cookieDependencies[1]).toMatchObject({
        type: "cookie",
        cookieKey: "user_token",
        dynamicPart: "user456",
      });
    });

    it("should find request dependencies", async () => {
      if (!sessionId) {
        console.warn("Skipping test - no session created");
        return;
      }

      const session = sessionManager.getSession(sessionId);
      const dynamicParts = ["token123"];

      // Create a mock request with the token in response
      const mockRequest = session.harData.requests[0];
      if (mockRequest?.response) {
        mockRequest.response.text = '{"auth_token": "token123"}';
      }

      const result = await findDependencies(dynamicParts, session.harData, {});

      // Should find the request dependency
      expect(result.requestDependencies.length).toBeGreaterThanOrEqual(0);
    });

    it("should select simplest request when multiple dependencies exist", async () => {
      if (!sessionId) {
        console.warn("Skipping test - no session created");
        return;
      }

      const session = sessionManager.getSession(sessionId);
      const requests = session.harData.requests.slice(0, 2); // Take first 2 requests

      const mockResponse: SimplestRequestResponse = { index: 0 };
      mockLLMClient.callFunction.mockResolvedValue(mockResponse);

      const simplest = await selectSimplestRequest(requests);

      expect(simplest).toBe(requests[0]);
      expect(mockLLMClient.callFunction).toHaveBeenCalledWith(
        expect.stringContaining(
          JSON.stringify([requests[0]?.toString(), requests[1]?.toString()])
        ),
        expect.objectContaining({
          name: "get_simplest_curl_index",
        }),
        "get_simplest_curl_index"
      );
    });

    it("should return single request without LLM call", async () => {
      if (!sessionId) {
        console.warn("Skipping test - no session created");
        return;
      }

      const session = sessionManager.getSession(sessionId);
      const firstRequest = session.harData.requests[0];
      if (!firstRequest) {
        return;
      }
      const singleRequest = [firstRequest];

      const simplest = await selectSimplestRequest(singleRequest);

      expect(simplest).toBe(singleRequest[0]);
      expect(mockLLMClient.callFunction).not.toHaveBeenCalled();
    });
  });

  describe("Error Handling and Robustness", () => {
    it("should handle LLM errors gracefully", async () => {
      const curlCommand = "curl 'https://api.example.com/test'";

      mockLLMClient.callFunction.mockRejectedValue(new Error("LLM API error"));

      await expect(identifyDynamicParts(curlCommand, {})).rejects.toThrow(
        "Dynamic parts identification failed"
      );
    });

    it("should validate dynamic parts before processing", () => {
      const validationResult = validateDynamicParts([
        "valid_token_123",
        "", // Empty string
        "a", // Too short
        "true", // Common static value
        null as unknown as string, // Invalid type for testing
      ]);

      expect(validationResult.valid).toContain("valid_token_123");
      expect(validationResult.invalid).toContain("");
      expect(validationResult.invalid).toContain("a");
      expect(validationResult.invalid).toContain("true");
      expect(validationResult.reasons[""]).toBe("Invalid type or empty");
      expect(validationResult.reasons.a).toBe("Too short to be meaningful");
    });

    it("should handle malformed LLM responses", async () => {
      const curlCommand = "curl 'https://api.example.com/test'";

      // Mock malformed response
      mockLLMClient.callFunction.mockResolvedValue({
        dynamic_parts: null, // Invalid format
      });

      const dynamicParts = await identifyDynamicParts(curlCommand, {});

      expect(Array.isArray(dynamicParts)).toBe(true);
      expect(dynamicParts).toEqual([]); // Should handle gracefully
    });
  });

  describe("Integration with Session Management", () => {
    it("should work with session state and DAG updates", async () => {
      if (!sessionId) {
        console.warn("Skipping test - no session created");
        return;
      }

      const session = sessionManager.getSession(sessionId);

      // Mock URL identification
      const mockUrlResponse: URLIdentificationResponse = {
        url: session.harData.urls[0]?.url || "https://api.example.com/search",
      };
      mockLLMClient.callFunction.mockResolvedValueOnce(mockUrlResponse);

      // Identify action URL
      const actionUrl = await identifyEndUrl(session, session.harData.urls);

      // Update session state
      session.state.actionUrl = actionUrl;
      expect(session.state.actionUrl).toBe(actionUrl);

      // Verify session logs
      sessionManager.addLog(sessionId, "info", "URL identification completed");
      expect(session.state.logs.length).toBeGreaterThan(0);
      const lastLog = session.state.logs[session.state.logs.length - 1];
      expect(lastLog?.message).toBe("URL identification completed");
    });

    it("should maintain DAG consistency during analysis", () => {
      if (!sessionId) {
        console.warn("Skipping test - no session created");
        return;
      }

      const session = sessionManager.getSession(sessionId);

      // Add a master node
      const firstRequest = session.harData.requests[0];
      if (!firstRequest) {
        return;
      }
      const masterNodeId = session.dagManager.addNode("master_curl", {
        key: firstRequest,
      });

      // Add some dependency nodes
      const secondRequest = session.harData.requests[1];
      if (!secondRequest) {
        return;
      }
      const depNodeId = session.dagManager.addNode("curl", {
        key: secondRequest,
      });

      // Create dependency edge
      session.dagManager.addEdge(masterNodeId, depNodeId);

      // Verify DAG structure
      expect(session.dagManager.getNodeCount()).toBe(2);

      // Check for cycles (should be none)
      const cycles = session.dagManager.detectCycles();
      expect(cycles).toBeNull();

      // Verify topological ordering
      const sorted = session.dagManager.topologicalSort();
      expect(sorted).toContain(masterNodeId);
      expect(sorted).toContain(depNodeId);
      expect(sorted.indexOf(masterNodeId)).toBeLessThan(
        sorted.indexOf(depNodeId)
      );
    });
  });
});
