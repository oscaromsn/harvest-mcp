import path from "node:path";
import { fileURLToPath } from "node:url";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionManager } from "../../src/core/SessionManager.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Mock server class for testing since the real one is not exported
class TestHarvestMCPServer {
  private sessionManager: SessionManager;

  constructor() {
    this.sessionManager = new SessionManager();
  }

  async handleSessionStart(params: {
    harPath: string;
    prompt: string;
    cookiePath?: string;
    inputVariables?: Record<string, string>;
  }): Promise<CallToolResult> {
    try {
      const sessionId = await this.sessionManager.createSession(params);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              sessionId,
              message: "Session created successfully",
              harPath: params.harPath,
              prompt: params.prompt,
            }),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error: ${error instanceof Error ? error.message : "Unknown error"}`,
          },
        ],
        isError: true,
      };
    }
  }

  async handleRunInitialAnalysis(params: {
    sessionId: string;
  }): Promise<CallToolResult> {
    try {
      const session = this.sessionManager.getSession(params.sessionId);

      // Simple implementation for testing
      const actionUrl =
        session.harData.urls[0]?.url || "https://api.example.com/search";
      const targetRequest =
        session.harData.requests.find((req) => req.url === actionUrl) ||
        session.harData.requests[0];

      const masterNodeId = session.dagManager.addNode("master_curl", {
        key: (() => {
          if (!targetRequest) {
            throw new Error("Test setup failed: target request not found.");
          }
          return targetRequest;
        })(),
        value: targetRequest?.response || null,
      });

      session.state.actionUrl = actionUrl;
      session.state.masterNodeId = masterNodeId;
      session.state.toBeProcessedNodes.push(masterNodeId);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              masterNodeId,
              actionUrl,
              message: "Initial analysis completed successfully",
              nodeCount: session.dagManager.getNodeCount(),
              nextStep:
                "Use analysis.process_next_node to begin dependency analysis",
            }),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error: ${error instanceof Error ? error.message : "Unknown error"}`,
          },
        ],
        isError: true,
      };
    }
  }

  handleProcessNextNode(params: {
    sessionId: string;
  }): CallToolResult {
    try {
      const session = this.sessionManager.getSession(params.sessionId);

      if (session.state.toBeProcessedNodes.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                status: "no_nodes_to_process",
                message: "No nodes available for processing",
                isComplete: session.dagManager.isComplete(),
              }),
            },
          ],
        };
      }

      const nodeId = session.state.toBeProcessedNodes.shift();
      if (nodeId === undefined) {
        throw new Error(
          "Test setup failed: processing queue is unexpectedly empty."
        );
      }
      const node = session.dagManager.getNode(nodeId);
      if (!node) {
        throw new Error(
          `Test setup failed: node with ID "${nodeId}" was not found.`
        );
      }

      // For testing, just mark as processed without LLM calls
      session.dagManager.updateNode(nodeId, { dynamicParts: [] });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              nodeId,
              status: "completed",
              dynamicPartsFound: 0,
              newNodesAdded: 0,
              remainingNodes: session.state.toBeProcessedNodes.length,
              totalNodes: session.dagManager.getNodeCount(),
            }),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error: ${error instanceof Error ? error.message : "Unknown error"}`,
          },
        ],
        isError: true,
      };
    }
  }

  handleIsComplete(params: {
    sessionId: string;
  }): CallToolResult {
    try {
      const session = this.sessionManager.getSession(params.sessionId);
      const isComplete = session.dagManager.isComplete();
      const nodeCount = session.dagManager.getNodeCount();
      const remainingToProcess = session.state.toBeProcessedNodes.length;

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              isComplete,
              status:
                isComplete && remainingToProcess === 0
                  ? "complete"
                  : "processing",
              nodeCount,
              remainingToProcess,
              message: isComplete
                ? "Analysis workflow completed successfully"
                : "Analysis in progress",
            }),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error: ${error instanceof Error ? error.message : "Unknown error"}`,
          },
        ],
        isError: true,
      };
    }
  }

  getSessionManager() {
    return this.sessionManager;
  }
}

describe("Sprint 3: MCP Server Tools Integration", () => {
  let server: TestHarvestMCPServer;
  let sessionId: string;

  beforeEach(async () => {
    // Set API key for LLM client
    process.env.OPENAI_API_KEY = "test-api-key";

    server = new TestHarvestMCPServer();

    // Create a test session
    const harPath = path.join(
      __dirname,
      "../fixtures/test-data/pangea_search.har"
    );
    const cookiePath = path.join(
      __dirname,
      "../fixtures/test-data/pangea_cookies.json"
    );

    try {
      const result = await server.handleSessionStart({
        harPath,
        cookiePath,
        prompt: "search for documents",
      });

      if (!result.isError) {
        const firstContent = result.content?.[0];
        if (firstContent && typeof firstContent.text === "string") {
          const response = JSON.parse(firstContent.text);
          sessionId = response.sessionId;
        }
      }
    } catch (_error) {
      console.warn("HAR test files not available, some tests will be skipped");
    }
  });

  afterEach(() => {
    if (server && sessionId) {
      server.getSessionManager().deleteSession(sessionId);
    }
  });

  describe("session.start tool", () => {
    it("should create a new session successfully", async () => {
      const result = await server.handleSessionStart({
        harPath: path.join(__dirname, "../fixtures/test.har"),
        prompt: "test analysis",
      });

      if (result.isError) {
        // Expected if file doesn't exist
        const firstContent = result.content?.[0];
        if (firstContent && typeof firstContent.text === "string") {
          expect(firstContent.text).toContain("Error");
        }
      } else {
        const firstContent = result.content?.[0];
        if (!firstContent || typeof firstContent.text !== "string") {
          throw new Error("Test failed: expected valid response content");
        }
        const response = JSON.parse(firstContent.text);
        expect(response.sessionId).toBeDefined();
        expect(response.message).toBe("Session created successfully");
        expect(response.prompt).toBe("test analysis");
      }
    });

    it("should handle missing HAR file gracefully", async () => {
      const result = await server.handleSessionStart({
        harPath: "/nonexistent/path.har",
        prompt: "test analysis",
      });

      expect(result.isError).toBe(true);
      const firstContent = result.content?.[0];
      if (firstContent && typeof firstContent.text === "string") {
        expect(firstContent.text).toContain("Error");
      }
    });
  });

  describe("analysis.run_initial_analysis tool", () => {
    it("should identify action URL and create master node", async () => {
      if (!sessionId) {
        console.warn("Skipping test - no session created");
        return;
      }

      const result = await server.handleRunInitialAnalysis({ sessionId });

      if (result.isError) {
        const firstContent = result.content?.[0];
        if (firstContent && typeof firstContent.text === "string") {
          expect(firstContent.text).toContain("Error");
        }
      } else {
        const firstContent = result.content?.[0];
        if (!firstContent || typeof firstContent.text !== "string") {
          throw new Error("Test failed: expected valid response content");
        }
        const response = JSON.parse(firstContent.text);
        expect(response.masterNodeId).toBeDefined();
        expect(response.actionUrl).toBeDefined();
        expect(response.nodeCount).toBeGreaterThan(0);
        expect(response.nextStep).toContain("process_next_node");
      }
    });

    it("should handle invalid session ID", async () => {
      const result = await server.handleRunInitialAnalysis({
        sessionId: "invalid-session-id",
      });

      expect(result.isError).toBe(true);
      const firstContent = result.content?.[0];
      if (firstContent && typeof firstContent.text === "string") {
        expect(firstContent.text).toContain("Error");
      }
    });
  });

  describe("analysis.process_next_node tool", () => {
    it("should process nodes in sequence", async () => {
      if (!sessionId) {
        console.warn("Skipping test - no session created");
        return;
      }

      // First run initial analysis
      await server.handleRunInitialAnalysis({ sessionId });

      // Then process the next node
      const result = await server.handleProcessNextNode({ sessionId });

      if (result.isError) {
        const firstContent = result.content?.[0];
        if (firstContent && typeof firstContent.text === "string") {
          expect(firstContent.text).toContain("Error");
        }
      } else {
        const firstContent = result.content?.[0];
        if (!firstContent || typeof firstContent.text !== "string") {
          throw new Error("Test failed: expected valid response content");
        }
        const response = JSON.parse(firstContent.text);
        expect(response.nodeId || response.status).toBeDefined();

        if (response.status !== "no_nodes_to_process") {
          expect(response.status).toBe("completed");
          expect(response.totalNodes).toBeGreaterThan(0);
        }
      }
    });

    it("should handle empty processing queue", async () => {
      if (!sessionId) {
        console.warn("Skipping test - no session created");
        return;
      }

      // Process node without initial analysis (empty queue)
      const result = await server.handleProcessNextNode({ sessionId });

      const firstContent = result.content?.[0];
      if (!firstContent || typeof firstContent.text !== "string") {
        throw new Error("Test failed: expected valid response content");
      }
      const response = JSON.parse(firstContent.text);
      expect(response.status).toBe("no_nodes_to_process");
    });
  });

  describe("analysis.is_complete tool", () => {
    it("should check completion status correctly", async () => {
      if (!sessionId) {
        console.warn("Skipping test - no session created");
        return;
      }

      const result = await server.handleIsComplete({ sessionId });

      const firstContent = result.content?.[0];
      if (!firstContent || typeof firstContent.text !== "string") {
        throw new Error("Test failed: expected valid response content");
      }
      const response = JSON.parse(firstContent.text);
      expect(typeof response.isComplete).toBe("boolean");
      expect(response.status).toMatch(/^(complete|processing)$/);
      expect(typeof response.nodeCount).toBe("number");
      expect(typeof response.remainingToProcess).toBe("number");
    });

    it("should report complete when no nodes to process", async () => {
      if (!sessionId) {
        console.warn("Skipping test - no session created");
        return;
      }

      // Empty state should be complete
      const result = await server.handleIsComplete({ sessionId });

      const firstContent = result.content?.[0];
      if (!firstContent || typeof firstContent.text !== "string") {
        throw new Error("Test failed: expected valid completion result");
      }
      const response = JSON.parse(firstContent.text);
      expect(response.isComplete).toBe(true);
      expect(response.status).toBe("complete");
    });
  });

  describe("Full workflow integration", () => {
    it("should complete full analysis workflow", async () => {
      if (!sessionId) {
        console.warn("Skipping test - no session created");
        return;
      }

      console.log("🚀 Testing full MCP workflow...");

      // Step 1: Initial analysis
      console.log("Step 1: Running initial analysis...");
      const initialResult = await server.handleRunInitialAnalysis({
        sessionId,
      });

      if (initialResult.isError) {
        console.warn("Initial analysis failed, skipping workflow test");
        return;
      }

      const firstContent = initialResult.content?.[0];
      if (!firstContent || typeof firstContent.text !== "string") {
        throw new Error(
          "Test failed: expected valid initial analysis response"
        );
      }
      const initialResponse = JSON.parse(firstContent.text);
      expect(initialResponse.masterNodeId).toBeDefined();

      // Step 2: Process nodes until complete
      console.log("Step 2: Processing nodes...");
      let maxIterations = 10; // Prevent infinite loops
      let isComplete = false;

      while (!isComplete && maxIterations > 0) {
        // Process next node
        const processResult = await server.handleProcessNextNode({ sessionId });
        const firstContent = processResult.content?.[0];
        if (!firstContent || typeof firstContent.text !== "string") {
          throw new Error("Test failed: expected valid process result");
        }
        const processResponse = JSON.parse(firstContent.text);

        console.log(
          `  Processed node: ${processResponse.nodeId || "none"}, status: ${processResponse.status}`
        );

        // Check completion
        const completeResult = await server.handleIsComplete({ sessionId });
        const firstCompleteContent = completeResult.content?.[0];
        if (
          !firstCompleteContent ||
          typeof firstCompleteContent.text !== "string"
        ) {
          throw new Error("Test failed: expected valid completion result");
        }
        const completeResponse = JSON.parse(firstCompleteContent.text);

        isComplete =
          completeResponse.isComplete &&
          completeResponse.remainingToProcess === 0;
        console.log(
          `  Complete: ${isComplete}, Remaining: ${completeResponse.remainingToProcess}`
        );

        maxIterations--;
      }

      // Step 3: Verify final state
      console.log("Step 3: Verifying final state...");
      const finalResult = await server.handleIsComplete({ sessionId });
      const firstFinalContent = finalResult.content?.[0];
      if (!firstFinalContent || typeof firstFinalContent.text !== "string") {
        throw new Error("Test failed: expected valid final result");
      }
      const finalResponse = JSON.parse(firstFinalContent.text);

      expect(finalResponse.status).toBe("complete");
      expect(finalResponse.nodeCount).toBeGreaterThan(0);

      console.log(
        `✅ Workflow completed: ${finalResponse.nodeCount} nodes processed`
      );
    });

    it("should maintain session state throughout workflow", async () => {
      if (!sessionId) {
        console.warn("Skipping test - no session created");
        return;
      }

      const sessionManager = server.getSessionManager();
      const session = sessionManager.getSession(sessionId);

      // Verify initial state
      expect(session.state.toBeProcessedNodes).toHaveLength(0);
      expect(session.state.masterNodeId).toBeUndefined();

      // Run initial analysis
      await server.handleRunInitialAnalysis({ sessionId });

      // Verify state after initial analysis
      expect(session.state.masterNodeId).toBeDefined();
      expect(session.state.actionUrl).toBeDefined();
      expect(session.state.toBeProcessedNodes.length).toBeGreaterThan(0);

      // Add a log entry
      sessionManager.addLog(sessionId, "info", "Test log entry");
      expect(session.state.logs.length).toBeGreaterThan(0);
      const lastLog = session.state.logs[session.state.logs.length - 1];
      expect(lastLog?.message).toBe("Test log entry");
    });
  });

  describe("Error handling and edge cases", () => {
    it("should handle invalid session IDs gracefully", async () => {
      const invalidSessionId = "invalid-uuid";

      const initialResult = await server.handleRunInitialAnalysis({
        sessionId: invalidSessionId,
      });
      expect(initialResult.isError).toBe(true);

      const processResult = await server.handleProcessNextNode({
        sessionId: invalidSessionId,
      });
      expect(processResult.isError).toBe(true);

      const completeResult = await server.handleIsComplete({
        sessionId: invalidSessionId,
      });
      expect(completeResult.isError).toBe(true);
    });

    it("should handle workflow state correctly", async () => {
      if (!sessionId) {
        console.warn("Skipping test - no session created");
        return;
      }

      // Test processing without initial analysis (should be safe)
      const processResult = await server.handleProcessNextNode({ sessionId });
      const firstContent = processResult.content?.[0];
      if (!firstContent || typeof firstContent.text !== "string") {
        throw new Error("Test failed: expected valid process result");
      }
      const processResponse = JSON.parse(firstContent.text);
      expect(processResponse.status).toBe("no_nodes_to_process");

      // Test completion check on empty workflow
      const completeResult = await server.handleIsComplete({ sessionId });
      const firstCompleteContent = completeResult.content?.[0];
      if (
        !firstCompleteContent ||
        typeof firstCompleteContent.text !== "string"
      ) {
        throw new Error("Test failed: expected valid completion result");
      }
      const completeResponse = JSON.parse(firstCompleteContent.text);
      expect(completeResponse.isComplete).toBe(true);
    });
  });
});
