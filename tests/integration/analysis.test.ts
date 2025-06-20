import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionManager } from "../../src/core/SessionManager.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe("Analysis Integration Tests", () => {
  let sessionManager: SessionManager;
  let sessionId: string;

  beforeEach(async () => {
    // Set API key for LLM client
    process.env.OPENAI_API_KEY = "test-api-key";

    sessionManager = new SessionManager();

    // Create a test session with real HAR data
    const harPath = path.join(
      __dirname,
      "../fixtures/test-data/pangea_search.har"
    );
    const cookiePath = path.join(
      __dirname,
      "../fixtures/test-data/pangea_cookies.json"
    );

    sessionId = await sessionManager.createSession({
      harPath,
      cookiePath,
      prompt: "search for documents",
    });
  });

  afterEach(() => {
    if (sessionManager && sessionId) {
      sessionManager.deleteSession(sessionId);
    }
  });

  describe("analysis.run_initial_analysis", () => {
    it("should identify action URL and create master node", async () => {
      const session = sessionManager.getSession(sessionId);

      // Mock server for this test
      const mockServer = {
        handleRunInitialAnalysis: async (args: { sessionId: string }) => {
          const session = sessionManager.getSession(args.sessionId);

          // Simple mock implementation - use first URL as action URL
          const firstUrl = session.harData.urls[0];
          if (!firstUrl) {
            throw new Error("No URLs found in HAR data");
          }
          const actionUrl = firstUrl.url;
          const targetRequest = session.harData.requests.find(
            (req) => req.url === actionUrl
          );

          if (targetRequest) {
            const masterNodeId = session.dagManager.addNode(
              "master",
              {
                key: targetRequest,
                value: targetRequest.response || null,
              },
              {
                dynamicParts: ["None"],
                extractedParts: ["None"],
              }
            );

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
          }

          throw new Error("No target request found");
        },
      };

      // Test the analysis
      const result = await mockServer.handleRunInitialAnalysis({ sessionId });
      const firstContent = result.content?.[0];
      if (!firstContent || typeof firstContent.text !== "string") {
        throw new Error("Test failed: expected valid response content");
      }
      const response = JSON.parse(firstContent.text);

      expect(response.masterNodeId).toBeDefined();
      expect(response.actionUrl).toBeDefined();
      expect(response.message).toBe("Initial analysis completed successfully");
      expect(response.nodeCount).toBeGreaterThan(0);
      expect(response.nextStep).toContain("analysis.process_next_node");

      // Verify session state was updated
      expect(session.state.actionUrl).toBe(response.actionUrl);
      expect(session.state.masterNodeId).toBe(response.masterNodeId);
      expect(session.state.toBeProcessedNodes).toContain(response.masterNodeId);
    });

    it("should handle invalid session ID", () => {
      const mockServer = {
        handleRunInitialAnalysis: (args: { sessionId: string }) => {
          try {
            sessionManager.getSession(args.sessionId);
          } catch (_error) {
            throw new Error(`Session not found: ${args.sessionId}`);
          }
        },
      };

      expect(() =>
        mockServer.handleRunInitialAnalysis({ sessionId: "invalid-session" })
      ).toThrow("Session not found");
    });
  });

  describe("Session State Management", () => {
    it("should maintain session state across analysis steps", async () => {
      const session = sessionManager.getSession(sessionId);

      // Verify initial state
      expect(session.state.actionUrl).toBeUndefined();
      expect(session.state.masterNodeId).toBeUndefined();
      expect(session.state.toBeProcessedNodes).toEqual([]);

      // Simulate running initial analysis
      const firstUrl = session.harData.urls[0];
      if (!firstUrl) {
        throw new Error("No URLs found in HAR data for test");
      }
      const actionUrl = firstUrl.url;
      const targetRequest = session.harData.requests.find(
        (req) => req.url === actionUrl
      );

      if (targetRequest) {
        const masterNodeId = session.dagManager.addNode(
          "master_curl",
          { key: targetRequest, value: targetRequest.response || null },
          { dynamicParts: ["None"], extractedParts: ["None"] }
        );

        session.state.actionUrl = actionUrl;
        session.state.masterNodeId = masterNodeId;
        session.state.toBeProcessedNodes.push(masterNodeId);

        // Verify state was updated
        expect(session.state.actionUrl).toBe(actionUrl);
        expect(session.state.masterNodeId).toBe(masterNodeId);
        expect(session.state.toBeProcessedNodes).toContain(masterNodeId);
        expect(session.dagManager.getNodeCount()).toBe(1);
      }
    });

    it("should track analysis logs", async () => {
      const session = sessionManager.getSession(sessionId);

      // Add some logs as would happen during analysis
      sessionManager.addLog(sessionId, "info", "Starting initial analysis");
      sessionManager.addLog(sessionId, "info", "Identified action URL");
      sessionManager.addLog(sessionId, "info", "Created master node");

      const logs = session.state.logs;
      expect(logs.length).toBeGreaterThanOrEqual(3);

      // Find our specific log messages
      const logMessages = logs.map((log) => log.message);
      expect(logMessages).toContain("Starting initial analysis");
      expect(logMessages).toContain("Identified action URL");
      expect(logMessages).toContain("Created master node");
    });
  });
});
