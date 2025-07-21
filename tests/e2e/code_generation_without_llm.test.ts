import { beforeEach, describe, expect, it } from "vitest";
import type { SessionManager } from "../../src/core/SessionManager.js";
import { Request } from "../../src/models/Request.js";
import { HarvestMCPServer } from "../../src/server.js";
import { handleGenerateWrapperScript } from "../../src/tools/codegenTools.js";
import { handleSessionStart } from "../../src/tools/sessionTools.js";

/**
 * Code Generation E2E Tests (No LLM Required)
 *
 * These tests verify the complete code generation workflow without requiring
 * OpenAI API access by manually setting up the dependency graph.
 */
describe("E2E Code Generation (No LLM)", () => {
  let server: HarvestMCPServer;
  let sessionManager: SessionManager;

  beforeEach(() => {
    server = new HarvestMCPServer();
    sessionManager = server.sessionManager;
  });

  describe("Complete Workflow Without LLM Dependencies", () => {
    it("should complete full code generation workflow with manually constructed DAG", async () => {
      // Step 1: Create session using MCP tool call
      const sessionResult = await handleSessionStart(
        {
          harPath: "tests/fixtures/test-data/pangea_search.har",
          cookiePath: "tests/fixtures/test-data/pangea_cookies.json",
          prompt: "Search and download documents from Pangea system",
        },
        server.getContext()
      );

      const firstContent = sessionResult.content?.[0];
      if (!firstContent || typeof firstContent.text !== "string") {
        throw new Error(
          "Test failed: expected valid session creation response"
        );
      }
      const sessionData = JSON.parse(firstContent.text);
      const sessionId = sessionData.sessionId;
      const session = sessionManager.getSession(sessionId);
      if (!session) {
        throw new Error(
          `Test failed: Could not find session with ID ${sessionId}`
        );
      }

      // Step 2: Manually construct a realistic dependency graph
      // (This simulates what the LLM analysis would produce)

      // Authentication request
      const authRequest = new Request(
        "POST",
        "https://console.pangea.cloud/api/auth/login",
        {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        undefined,
        {
          email: "user@example.com",
          password: "password123",
        }
      );

      // Search request (depends on auth)
      const searchRequest = new Request(
        "GET",
        "https://console.pangea.cloud/api/search/documents",
        {
          Authorization: "Bearer auth_token_abc123",
          Accept: "application/json",
        },
        {
          query: "security documents",
          limit: "10",
        }
      );

      // Download request (depends on search results)
      const downloadRequest = new Request(
        "GET",
        "https://console.pangea.cloud/api/documents/download",
        {
          Authorization: "Bearer auth_token_abc123",
          Accept: "application/octet-stream",
        },
        {
          document_id: "doc_xyz789",
          format: "pdf",
        }
      );

      // Build dependency graph
      const authNodeId = session.dagManager.addNode(
        "curl",
        { key: authRequest },
        {
          extractedParts: ["auth_token_abc123"],
          dynamicParts: [],
          inputVariables: {},
        }
      );

      const searchNodeId = session.dagManager.addNode(
        "curl",
        { key: searchRequest },
        {
          extractedParts: ["doc_xyz789"],
          dynamicParts: [],
          inputVariables: { query: "security documents", limit: "10" },
        }
      );

      const downloadNodeId = session.dagManager.addNode(
        "master_curl",
        { key: downloadRequest },
        {
          dynamicParts: [],
          extractedParts: [],
          inputVariables: { document_id: "doc_xyz789", format: "pdf" },
        }
      );

      // Create dependency chain: auth -> search -> download
      session.dagManager.addEdge(authNodeId, searchNodeId);
      session.dagManager.addEdge(searchNodeId, downloadNodeId);

      // Set session as complete
      session.state.isComplete = true;
      session.state.actionUrl = downloadRequest.url;
      session.state.masterNodeId = downloadNodeId;
      session.state.toBeProcessedNodes = [];

      // Step 3: Generate code using MCP tool call
      const codeGenResult = await handleGenerateWrapperScript(
        {
          sessionId,
        },
        server.getContext()
      );
      const codeGenContent = codeGenResult.content?.[0];
      if (!codeGenContent || typeof codeGenContent.text !== "string") {
        throw new Error("Test failed: expected valid code generation response");
      }
      const generatedCode = codeGenContent.text;

      // Step 4: Validate generated code
      expect(generatedCode).toContain(
        "// Harvest Generated API Integration Code"
      );
      expect(generatedCode).toContain(
        "// Original prompt: Search and download documents from Pangea system"
      );

      // Should contain all three functions in correct order
      expect(generatedCode).toContain("async function authLogin");
      expect(generatedCode).toContain("async function searchDocuments");
      expect(generatedCode).toContain(
        "async function searchAndDownloadDocumentsFromPangeaSystem"
      );

      // Verify dependency order
      const authIndex = generatedCode.indexOf("async function authLogin");
      const searchIndex = generatedCode.indexOf(
        "async function searchDocuments"
      );
      const downloadIndex = generatedCode.indexOf(
        "async function searchAndDownloadDocumentsFromPangeaSystem"
      );

      expect(authIndex).toBeLessThan(searchIndex);
      expect(searchIndex).toBeLessThan(downloadIndex);

      // Should include proper TypeScript structure
      expect(generatedCode).toContain("interface ApiResponse");
      expect(generatedCode).toContain("interface RequestOptions");
      expect(generatedCode).toContain("export {");
      expect(generatedCode).toContain("async function main");

      // Should include authentication logic
      expect(generatedCode).toContain("POST");
      expect(generatedCode).toContain("email");
      expect(generatedCode).toContain("password");

      // Should include search logic
      expect(generatedCode).toContain("query");
      expect(generatedCode).toContain("security documents");

      // Should include download logic
      expect(generatedCode).toContain("document_id");
      expect(generatedCode).toContain("format");

      // Should have proper error handling
      expect(generatedCode).toContain("try {");
      expect(generatedCode).toContain("} catch (error) {");

      console.log(
        `✅ Complete workflow successful - generated ${generatedCode.length} characters`
      );
    });

    it("should handle cookie dependencies in generated code", async () => {
      const sessionResult = await handleSessionStart(
        {
          harPath: "tests/fixtures/test-data/pangea_search.har",
          cookiePath: "tests/fixtures/test-data/pangea_cookies.json",
          prompt: "Access protected resources using session cookies",
        },
        server.getContext()
      );

      const sessionContent = sessionResult.content?.[0];
      if (!sessionContent || typeof sessionContent.text !== "string") {
        throw new Error(
          "Test failed: expected valid session creation response"
        );
      }
      const sessionId = JSON.parse(sessionContent.text).sessionId;
      const session = sessionManager.getSession(sessionId);
      if (!session) {
        throw new Error(
          `Test failed: Could not find session with ID ${sessionId}`
        );
      }

      // Create a request that depends on cookies
      const protectedRequest = new Request(
        "GET",
        "https://console.pangea.cloud/api/protected/data",
        {
          Cookie: "session_id=sess_abc123; csrf_token=csrf_xyz789",
          Accept: "application/json",
        }
      );

      // Add cookie dependencies
      session.dagManager.addNode(
        "cookie",
        {
          key: "session_id",
          value: "sess_abc123",
        },
        {
          extractedParts: ["sess_abc123"],
        }
      );

      session.dagManager.addNode(
        "cookie",
        {
          key: "csrf_token",
          value: "csrf_xyz789",
        },
        {
          extractedParts: ["csrf_xyz789"],
        }
      );

      const protectedNodeId = session.dagManager.addNode(
        "master_curl",
        { key: protectedRequest },
        {
          dynamicParts: [],
          extractedParts: [],
          inputVariables: {},
        }
      );

      // Mark as complete
      session.state.isComplete = true;
      session.state.actionUrl = protectedRequest.url;
      session.state.masterNodeId = protectedNodeId;

      const codeGenResult = await handleGenerateWrapperScript(
        {
          sessionId,
        },
        server.getContext()
      );
      const codeGenContent = codeGenResult.content?.[0];
      if (!codeGenContent || typeof codeGenContent.text !== "string") {
        throw new Error("Test failed: expected valid code generation response");
      }
      const generatedCode = codeGenContent.text;

      // Should include cookie information
      expect(generatedCode).toContain("// Cookie: session_id");
      expect(generatedCode).toContain("// Cookie: csrf_token");
      expect(generatedCode).toContain("sess_abc123");
      expect(generatedCode).toContain("csrf_xyz789");

      console.log("✅ Cookie dependencies handled correctly");
    });

    it("should handle not_found dependencies gracefully", async () => {
      const sessionResult = await handleSessionStart(
        {
          harPath: "tests/fixtures/test-data/pangea_search.har",
          cookiePath: "tests/fixtures/test-data/pangea_cookies.json",
          prompt: "Handle missing dependencies",
        },
        server.getContext()
      );

      const sessionContent = sessionResult.content?.[0];
      if (!sessionContent || typeof sessionContent.text !== "string") {
        throw new Error(
          "Test failed: expected valid session creation response"
        );
      }
      const sessionId = JSON.parse(sessionContent.text).sessionId;
      const session = sessionManager.getSession(sessionId);
      if (!session) {
        throw new Error(
          `Test failed: Could not find session with ID ${sessionId}`
        );
      }

      // Create a simple request
      const request = new Request("GET", "https://api.example.com/data", {
        Authorization: "Bearer missing_token",
      });

      const requestNodeId = session.dagManager.addNode(
        "master_curl",
        { key: request },
        {
          dynamicParts: [],
          extractedParts: [],
          inputVariables: {},
        }
      );

      // Add a not_found dependency
      session.dagManager.addNode("not_found", {
        key: "missing_api_key",
      });

      session.state.isComplete = true;
      session.state.actionUrl = request.url;
      session.state.masterNodeId = requestNodeId;

      const codeGenResult = await handleGenerateWrapperScript(
        {
          sessionId,
        },
        server.getContext()
      );
      const codeGenContent = codeGenResult.content?.[0];
      if (!codeGenContent || typeof codeGenContent.text !== "string") {
        throw new Error("Test failed: expected valid code generation response");
      }
      const generatedCode = codeGenContent.text;

      // Should include warning about missing dependency
      expect(generatedCode).toContain(
        "// WARNING: Could not resolve missing_api_key"
      );
      expect(generatedCode).toContain("Missing dependency: missing_api_key");
      expect(generatedCode).toContain("throw new Error");

      console.log("✅ Not found dependencies handled gracefully");
    });

    it("should generate optimized code for simple single-request scenarios", async () => {
      const sessionResult = await handleSessionStart(
        {
          harPath: "tests/fixtures/test-data/pangea_search.har",
          cookiePath: "tests/fixtures/test-data/pangea_cookies.json",
          prompt: "Get user profile",
        },
        server.getContext()
      );

      const sessionContent = sessionResult.content?.[0];
      if (!sessionContent || typeof sessionContent.text !== "string") {
        throw new Error(
          "Test failed: expected valid session creation response"
        );
      }
      const sessionId = JSON.parse(sessionContent.text).sessionId;
      const session = sessionManager.getSession(sessionId);
      if (!session) {
        throw new Error(
          `Test failed: Could not find session with ID ${sessionId}`
        );
      }

      // Create a simple GET request with no dependencies
      const profileRequest = new Request(
        "GET",
        "https://api.example.com/user/profile",
        {
          Accept: "application/json",
          "User-Agent": "HarvestClient/1.0",
        },
        {
          user_id: "12345",
        }
      );

      const profileNodeId = session.dagManager.addNode(
        "master_curl",
        { key: profileRequest },
        {
          dynamicParts: [],
          extractedParts: [],
          inputVariables: { user_id: "12345" },
        }
      );

      session.state.isComplete = true;
      session.state.actionUrl = profileRequest.url;
      session.state.masterNodeId = profileNodeId;

      const codeGenResult = await handleGenerateWrapperScript(
        {
          sessionId,
        },
        server.getContext()
      );
      const codeGenContent = codeGenResult.content?.[0];
      if (!codeGenContent || typeof codeGenContent.text !== "string") {
        throw new Error("Test failed: expected valid code generation response");
      }
      const generatedCode = codeGenContent.text;

      // Should generate clean, simple code
      expect(generatedCode).toContain("async function getUserProfile");
      expect(generatedCode).toContain("user_id: string = '12345'");
      expect(generatedCode).toContain("GET");
      expect(generatedCode).toContain("user/profile");

      // Should have minimal overhead for simple case
      const functionCount = (generatedCode.match(/async function/g) || [])
        .length;
      expect(functionCount).toBeLessThanOrEqual(2); // Main function + generated function

      console.log(
        `✅ Simple request optimization successful - ${functionCount} functions generated`
      );
    });

    it("should handle complex multi-step workflows", async () => {
      const sessionResult = await handleSessionStart(
        {
          harPath: "tests/fixtures/test-data/pangea_search.har",
          cookiePath: "tests/fixtures/test-data/pangea_cookies.json",
          prompt: "Complete document processing pipeline",
        },
        server.getContext()
      );

      const sessionContent = sessionResult.content?.[0];
      if (!sessionContent || typeof sessionContent.text !== "string") {
        throw new Error(
          "Test failed: expected valid session creation response"
        );
      }
      const sessionId = JSON.parse(sessionContent.text).sessionId;
      const session = sessionManager.getSession(sessionId);
      if (!session) {
        throw new Error(
          `Test failed: Could not find session with ID ${sessionId}`
        );
      }

      // Build a complex 5-step workflow
      const steps = [
        {
          name: "authenticate",
          request: new Request(
            "POST",
            "https://api.example.com/auth",
            { "Content-Type": "application/json" },
            undefined,
            { username: "user", password: "pass" }
          ),
          extracts: ["auth_token"],
        },
        {
          name: "upload",
          request: new Request(
            "POST",
            "https://api.example.com/upload",
            { Authorization: "Bearer auth_token" },
            undefined,
            { file: "document.pdf" }
          ),
          extracts: ["upload_id"],
        },
        {
          name: "process",
          request: new Request(
            "POST",
            "https://api.example.com/process",
            { Authorization: "Bearer auth_token" },
            undefined,
            { upload_id: "upload_id", action: "extract_text" }
          ),
          extracts: ["job_id"],
        },
        {
          name: "status",
          request: new Request(
            "GET",
            "https://api.example.com/status",
            { Authorization: "Bearer auth_token" },
            { job_id: "job_id" }
          ),
          extracts: ["result_url"],
        },
        {
          name: "download",
          request: new Request(
            "GET",
            "https://api.example.com/download",
            { Authorization: "Bearer auth_token" },
            { url: "result_url" }
          ),
          extracts: [],
        },
      ];

      const nodeIds: string[] = [];

      // Create all nodes
      for (const [index, step] of steps.entries()) {
        const nodeType = index === steps.length - 1 ? "master_curl" : "curl";
        const nodeId = session.dagManager.addNode(
          nodeType,
          { key: step.request },
          {
            extractedParts: step.extracts,
            dynamicParts: [],
            inputVariables: {},
          }
        );
        nodeIds.push(nodeId);
      }

      // Create dependency chain
      for (let i = 0; i < nodeIds.length - 1; i++) {
        const currentNodeId = nodeIds[i];
        const nextNodeId = nodeIds[i + 1];
        if (currentNodeId && nextNodeId) {
          session.dagManager.addEdge(currentNodeId, nextNodeId);
        }
      }

      session.state.isComplete = true;
      const lastStep = steps[steps.length - 1];
      if (lastStep) {
        session.state.actionUrl = lastStep.request.url;
      }
      const lastNodeId = nodeIds[nodeIds.length - 1];
      if (lastNodeId) {
        session.state.masterNodeId = lastNodeId;
      }

      const codeGenResult = await handleGenerateWrapperScript(
        {
          sessionId,
        },
        server.getContext()
      );
      const codeGenContent = codeGenResult.content?.[0];
      if (!codeGenContent || typeof codeGenContent.text !== "string") {
        throw new Error("Test failed: expected valid code generation response");
      }
      const generatedCode = codeGenContent.text;

      // Should contain all 5 functions
      expect(generatedCode).toContain("async function auth");
      expect(generatedCode).toContain("async function upload");
      expect(generatedCode).toContain("async function process");
      expect(generatedCode).toContain("async function status");
      expect(generatedCode).toContain(
        "async function completeDocumentProcessingPipeline"
      );

      // Should maintain correct order
      const functionIndices = [
        generatedCode.indexOf("async function auth"),
        generatedCode.indexOf("async function upload"),
        generatedCode.indexOf("async function process"),
        generatedCode.indexOf("async function status"),
        generatedCode.indexOf(
          "async function completeDocumentProcessingPipeline"
        ),
      ];

      for (let i = 0; i < functionIndices.length - 1; i++) {
        const currentIndex = functionIndices[i];
        const nextIndex = functionIndices[i + 1];
        if (currentIndex !== undefined && nextIndex !== undefined) {
          expect(currentIndex).toBeLessThan(nextIndex);
        }
      }

      // Should be substantial code for complex workflow
      expect(generatedCode.length).toBeGreaterThan(3000);

      console.log(
        `✅ Complex 5-step workflow successful - ${generatedCode.length} characters`
      );
    });
  });

  describe("Performance and Edge Cases", () => {
    it("should handle sessions with many parallel requests", async () => {
      const sessionResult = await handleSessionStart(
        {
          harPath: "tests/fixtures/test-data/pangea_search.har",
          cookiePath: "tests/fixtures/test-data/pangea_cookies.json",
          prompt: "Parallel data processing",
        },
        server.getContext()
      );

      const sessionContent = sessionResult.content?.[0];
      if (!sessionContent || typeof sessionContent.text !== "string") {
        throw new Error(
          "Test failed: expected valid session creation response"
        );
      }
      const sessionId = JSON.parse(sessionContent.text).sessionId;
      const session = sessionManager.getSession(sessionId);
      if (!session) {
        throw new Error(
          `Test failed: Could not find session with ID ${sessionId}`
        );
      }

      // Create an auth request
      const authRequest = new Request(
        "POST",
        "https://api.example.com/auth",
        { "Content-Type": "application/json" },
        undefined,
        { token: "abc123" }
      );

      const authNodeId = session.dagManager.addNode(
        "curl",
        { key: authRequest },
        {
          extractedParts: ["access_token"],
          dynamicParts: [],
          inputVariables: {},
        }
      );

      // Create 10 parallel requests that all depend on auth
      const parallelNodeIds: string[] = [];
      for (let i = 0; i < 10; i++) {
        const request = new Request(
          "GET",
          `https://api.example.com/data/${i}`,
          { Authorization: "Bearer access_token" },
          { batch: i.toString() }
        );

        const nodeId = session.dagManager.addNode(
          "curl",
          { key: request },
          {
            extractedParts: [`result_${i}`],
            dynamicParts: [],
            inputVariables: { batch: i.toString() },
          }
        );

        session.dagManager.addEdge(authNodeId, nodeId);
        parallelNodeIds.push(nodeId);
      }

      // Create a final aggregation request
      const aggregateRequest = new Request(
        "POST",
        "https://api.example.com/aggregate",
        { Authorization: "Bearer access_token" },
        undefined,
        { results: parallelNodeIds.map((_, i) => `result_${i}`) }
      );

      const aggregateNodeId = session.dagManager.addNode(
        "master_curl",
        { key: aggregateRequest },
        {
          dynamicParts: [],
          extractedParts: [],
          inputVariables: {},
        }
      );

      // All parallel requests feed into the aggregate
      for (const nodeId of parallelNodeIds) {
        session.dagManager.addEdge(nodeId, aggregateNodeId);
      }

      session.state.isComplete = true;
      session.state.actionUrl = aggregateRequest.url;
      session.state.masterNodeId = aggregateNodeId;

      const startTime = Date.now();
      const codeGenResult = await handleGenerateWrapperScript(
        {
          sessionId,
        },
        server.getContext()
      );
      const duration = Date.now() - startTime;

      const codeGenContent = codeGenResult.content?.[0];
      if (!codeGenContent || typeof codeGenContent.text !== "string") {
        throw new Error("Test failed: expected valid code generation response");
      }
      const generatedCode = codeGenContent.text;

      // Should handle all requests efficiently
      expect(duration).toBeLessThan(1000); // Under 1 second
      expect(generatedCode).toContain("async function auth");
      expect(generatedCode).toContain("async function parallelDataProcessing");

      // Should generate substantial code for many requests
      expect(generatedCode.length).toBeGreaterThan(5000);

      const functionCount = (generatedCode.match(/async function/g) || [])
        .length;
      expect(functionCount).toBeGreaterThanOrEqual(12); // Auth + 10 parallel + main + aggregate

      console.log(
        `✅ Parallel requests handled in ${duration}ms - ${functionCount} functions generated`
      );
    });

    it("should maintain deterministic code generation", async () => {
      const sessionResult = await handleSessionStart(
        {
          harPath: "tests/fixtures/test-data/pangea_search.har",
          cookiePath: "tests/fixtures/test-data/pangea_cookies.json",
          prompt: "Deterministic test",
        },
        server.getContext()
      );

      const sessionContent = sessionResult.content?.[0];
      if (!sessionContent || typeof sessionContent.text !== "string") {
        throw new Error(
          "Test failed: expected valid session creation response"
        );
      }
      const sessionId = JSON.parse(sessionContent.text).sessionId;
      const session = sessionManager.getSession(sessionId);
      if (!session) {
        throw new Error(
          `Test failed: Could not find session with ID ${sessionId}`
        );
      }

      // Create a simple, deterministic scenario
      const request = new Request("GET", "https://api.example.com/test", {
        Accept: "application/json",
      });

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
      session.state.actionUrl = request.url;
      session.state.masterNodeId = nodeId;

      // Generate code multiple times
      const codes: string[] = [];
      for (let i = 0; i < 3; i++) {
        const result = await handleGenerateWrapperScript(
          { sessionId },
          server.getContext()
        );
        const resultContent = result.content?.[0];
        if (!resultContent || typeof resultContent.text !== "string") {
          throw new Error(
            "Test failed: expected valid code generation response"
          );
        }
        codes.push(resultContent.text);
      }

      // All generated code should be identical
      expect(codes[0]).toBe(codes[1]);
      expect(codes[1]).toBe(codes[2]);

      console.log("✅ Deterministic code generation verified");
    });
  });
});
