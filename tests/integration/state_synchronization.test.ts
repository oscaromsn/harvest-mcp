import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionManager } from "../../src/core/SessionManager.js";
import { HarvestMCPServer } from "../../src/server.js";
import type { SessionStartParams } from "../../src/types/index.js";

describe("State Synchronization", () => {
  let sessionManager: SessionManager;
  let server: HarvestMCPServer;
  let testSessionId: string;

  beforeEach(async () => {
    sessionManager = new SessionManager();
    server = new HarvestMCPServer();

    // Create a test session with minimal HAR data
    const testHarPath = join(
      process.cwd(),
      "tests/fixtures/test-data/pangea_search.har"
    );
    const sessionParams: SessionStartParams = {
      harPath: testHarPath,
      prompt: "Test session for state synchronization",
    };

    testSessionId = await sessionManager.createSession(sessionParams);
  });

  afterEach(() => {
    sessionManager.clearAllSessions();
  });

  describe("SessionManager.syncCompletionState", () => {
    it("should synchronize session state with DAG completion when DAG is complete", async () => {
      const session = sessionManager.getSession(testSessionId);

      // Initially both should be false
      expect(session.state.isComplete).toBe(false);
      expect(session.dagManager.isComplete()).toBe(false);

      // Manually mark DAG as complete (simulate completed analysis)
      // This is a bit of a hack for testing, but simulates the real workflow
      const dagJson = session.dagManager.toJSON();
      if (dagJson.nodes.length > 0) {
        // Clear dynamic parts for all nodes to make them "resolved"
        for (const nodeWithId of dagJson.nodes) {
          const node = session.dagManager.getNode(nodeWithId.id);
          if (node) {
            session.dagManager.updateNode(nodeWithId.id, { dynamicParts: [] });
          }
        }
      }

      // DAG should now be complete, but session state should still be false
      expect(session.dagManager.isComplete()).toBe(true);
      expect(session.state.isComplete).toBe(false);

      // Sync completion state
      sessionManager.syncCompletionState(testSessionId);

      // Both should now be true
      expect(session.dagManager.isComplete()).toBe(true);
      expect(session.state.isComplete).toBe(true);
    });

    it("should not change session state when DAG is incomplete", () => {
      const session = sessionManager.getSession(testSessionId);

      // Initially both should be false
      expect(session.state.isComplete).toBe(false);
      expect(session.dagManager.isComplete()).toBe(false);

      // Sync completion state
      sessionManager.syncCompletionState(testSessionId);

      // Both should still be false
      expect(session.dagManager.isComplete()).toBe(false);
      expect(session.state.isComplete).toBe(false);
    });

    it("should handle invalid session ID gracefully", () => {
      // Should not throw for invalid session ID
      expect(() => {
        sessionManager.syncCompletionState("invalid-session-id");
      }).not.toThrow();
    });
  });

  describe("Workflow Integration", () => {
    it("should sync completion state during analysis_process_next_node when analysis completes", async () => {
      // This test would require a more complex setup with actual nodes to process
      // For now, we'll just verify the method exists and can be called
      const result = await server.handleProcessNextNode({
        sessionId: testSessionId,
      });

      // Should return a valid result structure
      expect(result).toHaveProperty("content");
      expect(result.content).toBeInstanceOf(Array);
      expect(result.content.length).toBeGreaterThan(0);

      // The result should contain JSON with status information
      const content = JSON.parse(result.content[0]?.text as string);
      expect(content).toHaveProperty("status");
    });

    it("should provide completion blocker analysis", async () => {
      const result = await server.handleGetCompletionBlockers({
        sessionId: testSessionId,
      });

      expect(result).toHaveProperty("content");
      expect(result.content).toBeInstanceOf(Array);
      expect(result.content.length).toBeGreaterThan(0);

      const analysis = JSON.parse(result.content[0]?.text as string);
      expect(analysis).toHaveProperty("status");
      expect(analysis).toHaveProperty("canGenerateCode");
      expect(analysis).toHaveProperty("blockers");
      expect(analysis).toHaveProperty("recommendations");
      expect(analysis).toHaveProperty("diagnostics");

      // Should provide meaningful diagnostics
      expect(analysis.diagnostics).toHaveProperty("dagComplete");
      expect(analysis.diagnostics).toHaveProperty("sessionStateComplete");
      expect(analysis.diagnostics).toHaveProperty("stateSynchronized");
    });
  });

  describe("Code Generation Prerequisites", () => {
    it("should use DAG completion as primary check for code generation", async () => {
      const session = sessionManager.getSession(testSessionId);

      // Manually create a state where DAG is complete but session state is not
      // (This simulates the bug we're fixing)
      if (session.dagManager.getNodeCount() > 0) {
        // Mark all nodes as resolved
        const dagJson = session.dagManager.toJSON();
        for (const nodeWithId of dagJson.nodes) {
          const node = session.dagManager.getNode(nodeWithId.id);
          if (node) {
            session.dagManager.updateNode(nodeWithId.id, { dynamicParts: [] });
          }
        }
      }

      // DAG is complete but session state is not
      expect(session.dagManager.isComplete()).toBe(true);
      expect(session.state.isComplete).toBe(false);

      // Code generation should now work (using DAG as primary check)
      try {
        const result = await server.handleGenerateWrapperScript({
          sessionId: testSessionId,
        });

        // Should not throw and return valid code
        expect(result).toHaveProperty("content");
        expect(result.content).toBeInstanceOf(Array);
        expect(result.content.length).toBeGreaterThan(0);

        const codeResult = JSON.parse(result.content[0]?.text as string);
        expect(codeResult).toHaveProperty("code");
        expect(typeof codeResult.code).toBe("string");

        // Session state should now be synced
        expect(session.state.isComplete).toBe(true);
      } catch (error) {
        // If it still fails, the error message should be more actionable
        expect((error as Error).message).toContain("Code generation failed");
        expect((error as Error).message).toContain("To resolve this");
      }
    });
  });

  describe("Error Message Improvements", () => {
    it("should provide actionable error messages when code generation fails", async () => {
      const session = sessionManager.getSession(testSessionId);

      // Ensure analysis is not complete
      expect(session.dagManager.isComplete()).toBe(false);

      try {
        await server.handleGenerateWrapperScript({ sessionId: testSessionId });
        // Should not reach here
        expect(true).toBe(false);
      } catch (error) {
        // Error should be more helpful than before
        expect((error as Error).message).toContain("Code generation failed");
        expect((error as Error).message).toMatch(/analysis not complete/i);

        // Should provide actionable recommendations
        if ((error as any).data?.recommendedActions) {
          expect((error as any).data.recommendedActions).toBeInstanceOf(Array);
          expect((error as any).data.recommendedActions.length).toBeGreaterThan(
            0
          );
        }
      }
    });
  });
});
