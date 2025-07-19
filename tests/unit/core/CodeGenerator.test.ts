import { beforeEach, describe, expect, it } from "vitest";
import {
  generateFooter,
  generateFunctionName,
  generateHeader,
  generateImports,
  generateMasterFunctionName,
  generateNodeCode,
  generateWrapperScript,
  getExtractedVariables,
} from "../../../src/core/CodeGenerator.js";
import { SessionManager } from "../../../src/core/SessionManager.js";
import { Request } from "../../../src/models/Request.js";
import type { HarvestSession } from "../../../src/types/index.js";

describe("CodeGenerator", () => {
  let sessionManager: SessionManager;
  let session: HarvestSession;

  beforeEach(async () => {
    sessionManager = new SessionManager();

    // Create a test session with sample data
    const sessionId = await sessionManager.createSession({
      harPath: "tests/fixtures/test-data/pangea_search.har",
      cookiePath: "tests/fixtures/test-data/pangea_cookies.json",
      prompt: "Search for documents",
    });

    const retrievedSession = sessionManager.getSession(sessionId);
    if (!retrievedSession) {
      throw new Error(
        `Test setup failed: session with ID "${sessionId}" was not found.`
      );
    }
    session = retrievedSession;

    // Create a simple dependency graph for testing
    const authRequest = new Request(
      "POST",
      "https://api.example.com/auth",
      { "Content-Type": "application/json" },
      undefined,
      { username: "test", password: "test123" }
    );

    const dataRequest = new Request(
      "GET",
      "https://api.example.com/data",
      { Authorization: "Bearer token123" },
      { search: "documents" }
    );

    // Add nodes to DAG
    const authNodeId = session.dagManager.addNode(
      "curl",
      { key: authRequest },
      {
        extractedParts: ["token123"],
        dynamicParts: [],
      }
    );

    const dataNodeId = session.dagManager.addNode(
      "master_curl",
      { key: dataRequest },
      {
        dynamicParts: [],
        inputVariables: { search: "documents" },
      }
    );

    // Create dependency: data depends on auth (auth must come before data)
    session.dagManager.addEdge(authNodeId, dataNodeId);

    // Mark session as complete
    session.state.isComplete = true;
  });

  describe("generateWrapperScript", () => {
    it("should generate a complete TypeScript wrapper script", () => {
      const code = generateWrapperScript(session);

      expect(code).toContain("// Harvest Generated API Integration Code");
      expect(code).toContain("async function");
      expect(code).toContain("fetch(");
      expect(code).toContain("export {");
    });

    it("should include proper imports and type definitions", () => {
      const code = generateWrapperScript(session);

      expect(code).toContain("interface ApiResponse");
      expect(code).toContain("interface RequestOptions");
      expect(code).toContain("export type");
    });

    it("should generate functions in correct dependency order", () => {
      const code = generateWrapperScript(session);

      // Auth function should come before data function
      const authIndex = code.indexOf("async function auth");
      const dataIndex = code.indexOf("async function searchForDocuments");

      expect(authIndex).toBeLessThan(dataIndex);
      expect(authIndex).toBeGreaterThan(-1);
      expect(dataIndex).toBeGreaterThan(-1);
    });

    it("should handle cookie dependencies", () => {
      // Add a cookie node
      session.dagManager.addNode(
        "cookie",
        {
          key: "session_id",
          value: "abc123",
        },
        {
          extractedParts: ["abc123"],
        }
      );

      const code = generateWrapperScript(session);

      expect(code).toContain("// Cookie: session_id");
      expect(code).toContain("abc123");
    });

    it("should throw error if analysis is not complete", () => {
      // Create a request for the incomplete node
      const incompleteRequest = new Request(
        "GET",
        "https://api.example.com/incomplete",
        { Authorization: "Bearer token123" }
      );

      // Add a node with unresolved dynamic parts to make DAG incomplete
      const incompleteNodeId = session.dagManager.addNode("curl", {
        key: incompleteRequest,
        value: null,
      });

      // Update the node to have unresolved dynamic parts
      session.dagManager.updateNode(incompleteNodeId, {
        dynamicParts: ["unresolved_part"],
      });

      expect(() => {
        generateWrapperScript(session);
      }).toThrow("Analysis not complete");
    });

    it("should include error handling in generated code", () => {
      const code = generateWrapperScript(session);

      expect(code).toContain("try {");
      expect(code).toContain("} catch (error) {");
      expect(code).toContain("throw new Error");
    });

    it("should generate proper variable extraction from responses", () => {
      const code = generateWrapperScript(session);

      // Should extract token from auth response
      expect(code).toContain("token123");
      expect(code).toContain("response.json()");
    });
  });

  describe("generateNodeCode", () => {
    it("should generate code for a master curl node", () => {
      const nodes = session.dagManager.getAllNodes();
      const masterNode = Array.from(nodes.values()).find(
        (n) => n.nodeType === "master_curl"
      );
      if (!masterNode) {
        throw new Error(
          "Test setup failed: Expected to find a master_curl node in the DAG."
        );
      }

      const code = generateNodeCode(masterNode, "searchDocuments");

      expect(code).toContain("async function searchDocuments");
      expect(code).toContain("fetch(");
      expect(code).toContain("data = await response.json()");
    });

    it("should generate code for a curl dependency node", () => {
      const nodes = session.dagManager.getAllNodes();
      const curlNode = Array.from(nodes.values()).find(
        (n) => n.nodeType === "curl"
      );
      if (!curlNode) {
        throw new Error(
          "Test setup failed: Expected to find a curl node in the DAG."
        );
      }

      const code = generateNodeCode(curlNode, "auth");

      expect(code).toContain("async function auth");
      expect(code).toContain("POST");
    });

    it("should generate code for cookie nodes", () => {
      const cookieNode = {
        id: "test-cookie",
        nodeType: "cookie" as const,
        content: { key: "session_id", value: "abc123" },
        extractedParts: ["abc123"],
        dynamicParts: [],
        inputVariables: {},
      };

      const code = generateNodeCode(cookieNode, "getSessionId");

      expect(code).toContain("// Cookie: session_id");
      expect(code).toContain("abc123");
    });

    it("should handle not_found nodes gracefully", () => {
      const notFoundNode = {
        id: "test-not-found",
        nodeType: "not_found" as const,
        content: { key: "missing_token" },
        extractedParts: [],
        dynamicParts: [],
        inputVariables: {},
      };

      const code = generateNodeCode(notFoundNode, "handleMissingToken");

      expect(code).toContain("// WARNING: Could not resolve missing_token");
      expect(code).toContain("throw new Error");
    });
  });

  describe("generateHeader", () => {
    it("should generate proper file header with metadata", () => {
      const header = generateHeader(session);

      expect(header).toContain("// Harvest Generated API Integration Code");
      expect(header).toContain("// Original prompt: Search for documents");
      expect(header).toContain(
        `// Generated: ${new Date().toISOString().split("T")[0]}`
      );
      expect(header).toContain("// DO NOT EDIT - This file is auto-generated");
    });
  });

  describe("generateImports", () => {
    it("should generate proper TypeScript imports", () => {
      const imports = generateImports();

      expect(imports).toContain("interface ApiResponse");
      expect(imports).toContain("interface RequestOptions");
      expect(imports).toContain("export type");
    });
  });

  describe("generateFooter", () => {
    it("should generate main function and exports", () => {
      const footer = generateFooter(session);

      expect(footer).toContain("async function main");
      expect(footer).toContain("export {");
      expect(footer).toContain("// Usage example:");
    });
  });

  describe("Variable Extraction", () => {
    it("should correctly identify variables to extract from responses", () => {
      const nodes = session.dagManager.getAllNodes();
      const authNode = Array.from(nodes.values()).find(
        (n) => n.nodeType === "curl"
      );
      if (!authNode) {
        throw new Error(
          "Test setup failed: Expected to find a curl node for auth testing."
        );
      }

      const variables = getExtractedVariables(authNode);

      expect(variables).toContain("token123");
    });

    it("should handle nodes with no extracted variables", () => {
      const nodes = session.dagManager.getAllNodes();
      const masterNode = Array.from(nodes.values()).find(
        (n) => n.nodeType === "master_curl"
      );
      if (!masterNode) {
        throw new Error(
          "Test setup failed: Expected to find a master_curl node for variable extraction testing."
        );
      }

      const variables = getExtractedVariables(masterNode);

      expect(variables).toEqual([]);
    });
  });

  describe("Function Naming", () => {
    it("should generate appropriate function names from URLs", () => {
      const authRequest = new Request(
        "POST",
        "https://api.example.com/auth/login",
        {}
      );
      const name = generateFunctionName(authRequest);

      expect(name).toBe("authLogin");
    });

    it("should handle complex URLs with parameters", () => {
      const searchRequest = new Request(
        "GET",
        "https://api.example.com/v2/search/documents",
        {}
      );
      const name = generateFunctionName(searchRequest);

      expect(name).toBe("v2SearchDocuments");
    });

    it("should use the session prompt for master node function name", () => {
      const name = generateMasterFunctionName(session.prompt);

      expect(name).toBe("searchForDocuments");
    });
  });

  describe("Error Handling", () => {
    it("should validate session state before generation", () => {
      session.state.isComplete = false;
      const firstNodeId = Array.from(
        session.dagManager.getAllNodes().keys()
      )[0];
      if (!firstNodeId) {
        throw new Error(
          "Test setup failed: No nodes found in DAG for error handling test."
        );
      }
      session.dagManager.updateNode(firstNodeId, {
        dynamicParts: ["unresolved_token"],
      });

      expect(() => {
        generateWrapperScript(session);
      }).toThrow("Analysis not complete");
    });

    it("should handle empty DAG gracefully", () => {
      // Create a new session with empty DAG
      const emptySession = {
        ...session,
        dagManager: new (
          session.dagManager.constructor as new () => typeof session.dagManager
        )(),
      };
      emptySession.state.isComplete = true;

      const code = generateWrapperScript(emptySession);

      expect(code).toContain("// No requests found");
      expect(code).toContain("async function main");
    });
  });
});
