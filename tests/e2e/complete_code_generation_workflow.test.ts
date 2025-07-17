import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionManager } from "../../src/core/SessionManager.js";
import type { HarvestMCPServer } from "../../src/server.js";
import {
  cleanupE2EContext,
  createManualDAGScenario,
  createTestSession,
  type E2ETestContext,
  e2eAssertions,
  runCompleteWorkflow,
  setupE2EContext,
} from "../helpers/e2e-helpers.js";

/**
 * End-to-End Code Generation Workflow Tests
 *
 * These tests verify the complete workflow from HAR file analysis to code generation
 * using real HAR files and the full MCP server infrastructure.
 */
describe("E2E Complete Code Generation Workflow", () => {
  let context: E2ETestContext;
  let server: HarvestMCPServer;
  let sessionManager: SessionManager;

  beforeEach(() => {
    // Ensure all mocks are cleared before setup
    vi.restoreAllMocks();

    context = setupE2EContext();
    server = context.server;
    sessionManager = context.sessionManager;
  });

  afterEach(async () => {
    // Clean up sessions first
    if (sessionManager) {
      sessionManager.clearAllSessions();
    }
    // Then cleanup LLM client
    cleanupE2EContext();
    // Small delay to prevent timing issues
    await new Promise((resolve) => setTimeout(resolve, 10));
  });

  describe("Real HAR File Analysis to Code Generation", () => {
    it("should complete full workflow: session creation -> analysis -> code generation", async () => {
      // Use helper to run complete workflow
      const workflow = await runCompleteWorkflow(server, {
        prompt: "Search for documents in the Pangea system",
      });

      // Verify workflow completed successfully
      e2eAssertions.assertSuccessfulWorkflow(workflow);

      // Verify code includes search functionality
      const codeContainsSearch =
        workflow.generatedCode.includes("searchForDocuments") ||
        workflow.generatedCode.includes("search") ||
        workflow.generatedCode.includes("SearchFor");
      expect(codeContainsSearch).toBe(true);

      // Verify proper error handling
      expect(workflow.generatedCode).toContain("try {");
      expect(workflow.generatedCode).toContain("} catch (error) {");

      // Verify the session state contains the generated code
      const session = sessionManager.getSession(workflow.sessionId);
      if (!session) {
        throw new Error(
          `Test failed: Could not find session with ID ${workflow.sessionId}`
        );
      }
      expect(session.state.generatedCode).toBeDefined();
      expect(session.state.generatedCode).toBe(workflow.generatedCode);

      console.log(
        `✅ Complete workflow successful in ${workflow.iterations} iterations`
      );
      console.log(
        `📄 Generated ${workflow.generatedCode.length} characters of TypeScript code`
      );
    }, 30000); // 30 second timeout for complete workflow

    it("should handle workflow with debug intervention", async () => {
      const sessionId = await createDebugInterventionSession();
      await runInitialAnalysisAndProcessing(sessionId);
      await handleUnresolvedNodes(sessionId);
      await forceCompletionForTesting(sessionId);
      await verifyCodeGeneration(sessionId);

      console.log("✅ Debug intervention workflow successful");
    }, 20000);

    it("should handle sessions with no dependencies (simple GET request)", async () => {
      // Create session and set up simple scenario
      const sessionId = await createTestSession(server, {
        prompt: "Get user profile",
      });
      createManualDAGScenario(sessionManager, sessionId, "simple");

      // Generate code for simple case
      const codeGenResult = await server.handleGenerateWrapperScript({
        sessionId,
      });
      const generatedCode = codeGenResult.content?.[0]?.text as string;
      if (!generatedCode) {
        throw new Error("No generated code");
      }

      // Should generate minimal but complete code
      e2eAssertions.assertValidGeneratedCode(generatedCode);
      expect(generatedCode).toContain("fetch(");

      // Should be relatively short for simple cases
      expect(generatedCode.length).toBeLessThan(2500);

      console.log("✅ Simple GET request workflow successful");
    }, 10000);
  });

  // Helper functions for debug intervention test
  async function createDebugInterventionSession(): Promise<string> {
    const sessionResult = await server.handleSessionStart({
      harPath: "tests/fixtures/test-data/pangea_search.har",
      cookiePath: "tests/fixtures/test-data/pangea_cookies.json",
      prompt: "Download documents from Pangea",
    });

    const firstContent = sessionResult.content?.[0];
    if (!firstContent || typeof firstContent.text !== "string") {
      throw new Error("Test failed: expected valid session creation response");
    }
    return JSON.parse(firstContent.text).sessionId;
  }

  async function runInitialAnalysisAndProcessing(
    sessionId: string
  ): Promise<void> {
    await server.handleRunInitialAnalysis({ sessionId });

    // Process a few nodes
    for (let i = 0; i < 3; i++) {
      const completeResult = await server.handleIsComplete({ sessionId });
      const completeContent = completeResult.content?.[0];
      if (!completeContent || typeof completeContent.text !== "string") {
        throw new Error(
          "Test failed: expected valid completion check response"
        );
      }
      const isComplete = JSON.parse(completeContent.text).isComplete;

      if (isComplete) {
        break;
      }
      await server.handleProcessNextNode({ sessionId });
    }
  }

  async function handleUnresolvedNodes(sessionId: string): Promise<void> {
    const unresolvedResult = await server.handleGetUnresolvedNodes({
      sessionId,
    });
    const unresolvedContent = unresolvedResult.content?.[0];
    if (!unresolvedContent || typeof unresolvedContent.text !== "string") {
      throw new Error("Test failed: expected valid unresolved nodes response");
    }
    const unresolvedData = JSON.parse(unresolvedContent.text);

    console.log(`Found ${unresolvedData.totalUnresolved} unresolved nodes`);

    if (unresolvedData.totalUnresolved > 0) {
      await listRequestsForDebug(sessionId);
    }
  }

  async function listRequestsForDebug(sessionId: string): Promise<void> {
    const requestsResult = await server.handleListAllRequests({ sessionId });
    const requestsContent = requestsResult.content?.[0];
    if (!requestsContent || typeof requestsContent.text !== "string") {
      throw new Error("Test failed: expected valid requests list response");
    }
    const requestsData = JSON.parse(requestsContent.text);

    expect(requestsData.totalRequests).toBeGreaterThan(0);
    expect(Array.isArray(requestsData.requests)).toBe(true);
    console.log(
      `Available requests for manual intervention: ${requestsData.totalRequests}`
    );
  }

  function forceCompletionForTesting(sessionId: string): void {
    const session = sessionManager.getSession(sessionId);
    if (!session) {
      throw new Error(
        `Test failed: Could not find session with ID ${sessionId}`
      );
    }

    for (const [nodeId, node] of session.dagManager.getAllNodes()) {
      if (node.dynamicParts && node.dynamicParts.length > 0) {
        session.dagManager.updateNode(nodeId, { dynamicParts: [] });
      }
    }
    session.state.isComplete = true;
    session.state.toBeProcessedNodes = [];
  }

  async function verifyCodeGeneration(sessionId: string): Promise<void> {
    const codeGenResult = await server.handleGenerateWrapperScript({
      sessionId,
    });
    const codeGenContent = codeGenResult.content?.[0];
    if (!codeGenContent || typeof codeGenContent.text !== "string") {
      throw new Error("Test failed: expected valid code generation response");
    }
    const generatedCode = codeGenContent.text;

    expect(generatedCode).toContain("async function");
    const hasDownloadOrGet = /download|Download|get/i.test(generatedCode);
    expect(hasDownloadOrGet).toBe(true);
  }

  describe("Error Handling and Edge Cases", () => {
    it("should handle incomplete analysis gracefully", async () => {
      const sessionId = await createTestSession(server, {
        prompt: "Test incomplete analysis",
      });

      // Try to generate code without completing analysis
      await expect(
        server.handleGenerateWrapperScript({ sessionId })
      ).rejects.toThrow("Cannot generate code - analysis not complete");

      console.log("✅ Incomplete analysis error handling works correctly");
    });

    it("should handle sessions with cycles gracefully", async () => {
      const sessionId = await createTestSession(server, {
        prompt: "Test cycle detection",
      });
      createManualDAGScenario(sessionManager, sessionId, "cycle");

      // Code generation should detect and handle the cycle
      await expect(
        server.handleGenerateWrapperScript({ sessionId })
      ).rejects.toThrow("Graph contains cycles");

      console.log("✅ Cycle prevention working correctly");
    });

    it("should generate meaningful code for complex real-world scenarios", async () => {
      // Create session and set up complex scenario
      const sessionId = await createTestSession(server, {
        prompt:
          "Complete document management workflow including search, download, and metadata extraction",
      });
      createManualDAGScenario(sessionManager, sessionId, "complex");

      // Generate comprehensive code
      const codeGenResult = await server.handleGenerateWrapperScript({
        sessionId,
      });
      const generatedCode = codeGenResult.content?.[0]?.text as string;
      if (!generatedCode) {
        throw new Error("No generated code");
      }

      // Verify comprehensive code structure
      e2eAssertions.assertValidGeneratedCode(generatedCode);
      expect(generatedCode).toContain("Complete document management workflow");
      expect(generatedCode.length).toBeGreaterThan(1000); // Should be substantial

      // Should contain realistic function names
      const lines = generatedCode.split("\n");
      const functionLines = lines.filter((line) =>
        line.includes("async function")
      );
      expect(functionLines.length).toBeGreaterThanOrEqual(2); // At least search and download

      console.log(
        `✅ Complex workflow generated ${generatedCode.length} characters with ${functionLines.length} functions`
      );
    }, 15000);
  });

  describe("Performance and Scalability", () => {
    it("should handle large HAR files efficiently", async () => {
      const startTime = Date.now();

      const sessionResult = await server.handleSessionStart({
        harPath: "tests/fixtures/test-data/pangea_search.har",
        cookiePath: "tests/fixtures/test-data/pangea_cookies.json",
        prompt: "Performance test for large HAR file processing",
      });

      const sessionId = JSON.parse(
        sessionResult.content?.[0]?.text as string
      ).sessionId;
      const session = sessionManager.getSession(sessionId);
      if (!session) {
        throw new Error(
          `Test failed: Could not find session with ID ${sessionId}`
        );
      }

      // Simulate analysis of large HAR file by adding many nodes
      const baseRequests = session.harData.requests.slice(0, 5); // Use first 5 real requests

      for (let i = 0; i < 20; i++) {
        const request = baseRequests[i % baseRequests.length];
        if (!request) {
          continue;
        }
        session.dagManager.addNode(
          "curl",
          {
            key: { ...request, url: `${request?.url}?batch=${i}` },
          },
          {
            dynamicParts: [],
            extractedParts: [`result_${i}`],
            inputVariables: { batch: i.toString() },
          }
        );
      }

      // Mark as complete
      session.state.isComplete = true;
      session.state.toBeProcessedNodes = [];

      // Generate code for large scenario
      const codeGenResult = await server.handleGenerateWrapperScript({
        sessionId,
      });
      const generatedCode = codeGenResult.content?.[0]?.text as string;
      if (!generatedCode) {
        throw new Error("No generated code");
      }

      const totalTime = Date.now() - startTime;

      // Performance assertions
      expect(totalTime).toBeLessThan(5000); // Should complete in under 5 seconds
      expect(generatedCode.length).toBeGreaterThan(5000); // Should generate substantial code
      expect(generatedCode).toContain("async function");

      console.log(
        `✅ Large HAR file test completed in ${totalTime}ms, generated ${generatedCode.length} characters`
      );
    }, 10000);

    it("should maintain performance with multiple concurrent sessions", async () => {
      const concurrentSessions = 3;
      // Type for what the concurrent session promises actually return
      type SessionResult = {
        sessionId: string;
        codeLength: number;
      };
      const sessionPromises: Promise<SessionResult>[] = [];

      // Create multiple sessions concurrently
      for (let i = 0; i < concurrentSessions; i++) {
        const promise = (async () => {
          const sessionResult = await server.handleSessionStart({
            harPath: "tests/fixtures/test-data/pangea_search.har",
            cookiePath: "tests/fixtures/test-data/pangea_cookies.json",
            prompt: `Concurrent session ${i} - test performance`,
          });

          const sessionId = JSON.parse(
            sessionResult.content?.[0]?.text as string
          ).sessionId;
          const session = sessionManager.getSession(sessionId);
          if (!session) {
            throw new Error(
              `Test failed: Could not find session with ID ${sessionId}`
            );
          }

          // Add minimal complete scenario
          const request = session.harData.requests[0];
          if (!request) {
            throw new Error("No requests available");
          }
          const nodeId = session.dagManager.addNode(
            "master_curl",
            { key: request },
            {
              dynamicParts: [],
              extractedParts: [],
              inputVariables: {},
            }
          );

          session.state.isComplete = true;
          session.state.actionUrl = request?.url;
          session.state.masterNodeId = nodeId;

          // Generate code
          const codeGenResult = await server.handleGenerateWrapperScript({
            sessionId,
          });
          return {
            sessionId,
            codeLength:
              (codeGenResult.content?.[0]?.text as string)?.length || 0,
          };
        })();

        sessionPromises.push(promise);
      }

      const startTime = Date.now();
      const results = await Promise.all(sessionPromises);
      const totalTime = Date.now() - startTime;

      // Verify all sessions completed successfully
      expect(results).toHaveLength(concurrentSessions);
      for (const result of results) {
        expect(result.sessionId).toBeDefined();
        expect(result.codeLength).toBeGreaterThan(0);
      }

      // Performance should remain reasonable even with concurrent sessions
      expect(totalTime).toBeLessThan(10000); // Under 10 seconds for 3 concurrent sessions

      console.log(
        `✅ ${concurrentSessions} concurrent sessions completed in ${totalTime}ms`
      );
    }, 15000);
  });
});
