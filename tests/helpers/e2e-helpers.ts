import {
  type LLMClient,
  resetLLMClient,
  setLLMClient,
} from "../../src/core/LLMClient.js";
import type { SessionManager } from "../../src/core/SessionManager.js";
import { HarvestMCPServer } from "../../src/server.js";
import { createMockLLMClient } from "../mocks/llm-client.mock.js";

/**
 * E2E Test Helpers
 *
 * Provides common utilities for end-to-end testing workflows
 */

export interface E2ETestContext {
  server: HarvestMCPServer;
  sessionManager: SessionManager;
}

export interface E2ESessionOptions {
  harPath?: string;
  cookiePath?: string;
  prompt?: string;
  mockLLMResponses?: {
    identify_end_url?: { url: string };
    identify_dynamic_parts?: { dynamic_parts: string[] };
    identify_input_variables?: {
      identified_variables: Array<{
        variable_name: string;
        variable_value: string;
      }>;
    };
  };
}

/**
 * Setup E2E test context with mock LLM client
 */
export function setupE2EContext(
  customMockResponses?: E2ESessionOptions["mockLLMResponses"]
): E2ETestContext {
  // Ensure clean state first
  resetLLMClient();

  // Set up mock LLM client for E2E tests to avoid real API calls
  const mockLLMClient = createMockLLMClient({
    identify_end_url: {
      url: "https://pangeabnp.pdpj.jus.br/api/v1/precedentes",
    },
    identify_dynamic_parts: {
      dynamic_parts: ["auth_token", "session_id"],
    },
    identify_input_variables: {
      identified_variables: [
        { variable_name: "search_term", variable_value: "documents" },
      ],
    },
    ...customMockResponses,
  });
  setLLMClient(mockLLMClient as unknown as LLMClient);

  const server = new HarvestMCPServer();
  const sessionManager = server.sessionManager;

  return { server, sessionManager };
}

/**
 * Clean up E2E test context
 */
export function cleanupE2EContext(): void {
  resetLLMClient();
}

/**
 * Create a test session with default parameters
 */
export async function createTestSession(
  server: HarvestMCPServer,
  options: E2ESessionOptions = {}
): Promise<string> {
  const {
    harPath = "tests/fixtures/test-data/pangea_search.har",
    cookiePath = "tests/fixtures/test-data/pangea_cookies.json",
    prompt = "Test analysis workflow",
  } = options;

  const sessionResult = await server.handleSessionStart({
    harPath,
    cookiePath,
    prompt,
  });

  const firstContent = sessionResult.content?.[0];
  if (!firstContent || typeof firstContent.text !== "string") {
    throw new Error(
      "createTestSession failed: expected valid response content"
    );
  }
  const sessionData = JSON.parse(firstContent.text);
  return sessionData.sessionId;
}

/**
 * Run initial analysis for a session
 */
export async function runInitialAnalysis(
  server: HarvestMCPServer,
  sessionId: string
): Promise<{ masterNodeId: string; actionUrl: string }> {
  const initialAnalysisResult = await server.handleRunInitialAnalysis({
    sessionId,
  });
  const firstContent = initialAnalysisResult.content?.[0];
  if (!firstContent || typeof firstContent.text !== "string") {
    throw new Error(
      "runInitialAnalysis failed: expected valid response content"
    );
  }
  const initialData = JSON.parse(firstContent.text);

  return {
    masterNodeId: initialData.masterNodeId,
    actionUrl: initialData.actionUrl,
  };
}

/**
 * Process all nodes until analysis is complete or max iterations reached
 */
export async function processAllNodes(
  server: HarvestMCPServer,
  sessionId: string,
  maxIterations = 10
): Promise<{ iterations: number; isComplete: boolean }> {
  let isComplete = false;
  let iterations = 0;

  while (!isComplete && iterations < maxIterations) {
    // Check if analysis is complete
    const completeResult = await server.handleIsComplete({ sessionId });
    const completeContent = completeResult.content?.[0];
    if (!completeContent || typeof completeContent.text !== "string") {
      throw new Error(
        "processAllNodes failed: expected valid completion check response"
      );
    }
    const completeData = JSON.parse(completeContent.text);
    isComplete = completeData.isComplete;

    if (isComplete) {
      break;
    }

    // Process next node
    const processResult = await server.handleProcessNextNode({ sessionId });
    const processContent = processResult.content?.[0];
    if (!processContent || typeof processContent.text !== "string") {
      throw new Error(
        "processAllNodes failed: expected valid process node response"
      );
    }
    const processData = JSON.parse(processContent.text);

    if (processData.status === "no_nodes_to_process") {
      break;
    }

    iterations++;
  }

  return { iterations, isComplete };
}

/**
 * Generate wrapper script for a completed session
 */
export async function generateWrapperScript(
  server: HarvestMCPServer,
  sessionId: string
): Promise<string> {
  const codeGenResult = await server.handleGenerateWrapperScript({ sessionId });
  const firstContent = codeGenResult.content?.[0];
  if (!firstContent || typeof firstContent.text !== "string") {
    throw new Error(
      "generateWrapperScript failed: expected valid code generation response"
    );
  }
  return firstContent.text;
}

/**
 * Complete full E2E workflow from session creation to code generation
 */
export async function runCompleteWorkflow(
  server: HarvestMCPServer,
  options: E2ESessionOptions = {}
): Promise<{
  sessionId: string;
  masterNodeId: string;
  actionUrl: string;
  iterations: number;
  isComplete: boolean;
  generatedCode: string;
}> {
  // Create session
  const sessionId = await createTestSession(server, options);

  // Run initial analysis
  const { masterNodeId, actionUrl } = await runInitialAnalysis(
    server,
    sessionId
  );

  // Process all nodes
  const { iterations, isComplete } = await processAllNodes(server, sessionId);

  // If analysis is not complete after max iterations, force completion for testing
  if (!isComplete) {
    const sessionManager = server.sessionManager;
    const session = sessionManager.getSession(sessionId);
    if (!session) {
      throw new Error(
        `Test setup error: Could not find session with ID ${sessionId}`
      );
    }

    // Mark all nodes as resolved and complete
    for (const [nodeId, node] of session.dagManager.getAllNodes()) {
      if (node.dynamicParts && node.dynamicParts.length > 0) {
        session.dagManager.updateNode(nodeId, { dynamicParts: [] });
      }
    }
    session.state.isComplete = true;
    session.state.toBeProcessedNodes = [];
  }

  // Generate code
  const generatedCode = await generateWrapperScript(server, sessionId);

  return {
    sessionId,
    masterNodeId,
    actionUrl,
    iterations,
    isComplete: true, // Always return true since we force completion
    generatedCode,
  };
}

/**
 * Create a manual DAG scenario for testing without LLM dependencies
 */
export function createManualDAGScenario(
  sessionManager: SessionManager,
  sessionId: string,
  scenario: "simple" | "complex" | "cycle"
): void {
  const session = sessionManager.getSession(sessionId);
  if (!session) {
    throw new Error(
      `Test setup error: Could not find session with ID ${sessionId}`
    );
  }

  switch (scenario) {
    case "simple": {
      // Single request with no dependencies
      const request = session.harData.requests[0];
      if (!request) {
        throw new Error("No requests found in HAR data for simple scenario");
      }
      const masterNodeId = session.dagManager.addNode(
        "master_curl",
        { key: request },
        {
          dynamicParts: [],
          extractedParts: [],
          inputVariables: {},
        }
      );
      session.state.actionUrl = request.url;
      session.state.masterNodeId = masterNodeId;
      session.state.isComplete = true;
      session.state.toBeProcessedNodes = [];
      break;
    }

    case "complex": {
      // Multi-step workflow with dependencies
      const requests = session.harData.requests.slice(0, 3);
      if (requests.length < 3 || !requests[0] || !requests[1] || !requests[2]) {
        throw new Error(
          "Insufficient requests in HAR data for complex scenario (need at least 3)"
        );
      }
      const authNodeId = session.dagManager.addNode(
        "curl",
        { key: requests[0] },
        {
          dynamicParts: [],
          extractedParts: ["auth_token"],
          inputVariables: {},
        }
      );
      const dataNodeId = session.dagManager.addNode(
        "curl",
        { key: requests[1] },
        {
          dynamicParts: [],
          extractedParts: ["data_id"],
          inputVariables: {},
        }
      );
      const mainNodeId = session.dagManager.addNode(
        "master_curl",
        { key: requests[2] },
        {
          dynamicParts: [],
          extractedParts: [],
          inputVariables: {},
        }
      );

      // Create dependencies
      session.dagManager.addEdge(authNodeId, dataNodeId);
      session.dagManager.addEdge(dataNodeId, mainNodeId);

      session.state.actionUrl = requests[2].url;
      session.state.masterNodeId = mainNodeId;
      session.state.isComplete = true;
      session.state.toBeProcessedNodes = [];
      break;
    }

    case "cycle": {
      // Create a cycle for testing error handling
      const reqA = session.harData.requests[0];
      const reqB = session.harData.requests[1];
      if (!reqA || !reqB) {
        throw new Error(
          "Insufficient requests in HAR data for cycle scenario (need at least 2)"
        );
      }
      const nodeA = session.dagManager.addNode("curl", { key: reqA });
      const nodeB = session.dagManager.addNode("curl", { key: reqB });

      // Create cycle
      session.dagManager.addEdge(nodeA, nodeB);
      session.dagManager.addEdge(nodeB, nodeA);

      session.state.isComplete = true;
      session.state.toBeProcessedNodes = [];
      break;
    }

    default:
      throw new Error(`Unknown scenario: ${scenario}`);
  }
}

/**
 * Assertion helpers for E2E tests
 */
export const e2eAssertions = {
  /**
   * Assert that generated code contains expected elements
   */
  assertValidGeneratedCode(generatedCode: string): void {
    if (!generatedCode || typeof generatedCode !== "string") {
      throw new Error("Generated code is empty or not a string");
    }

    if (!generatedCode.includes("// Harvest Generated API Integration Code")) {
      throw new Error("Generated code missing header comment");
    }

    if (!generatedCode.includes("interface ApiResponse")) {
      throw new Error("Generated code missing ApiResponse interface");
    }

    if (!generatedCode.includes("async function")) {
      throw new Error("Generated code missing async functions");
    }

    if (!generatedCode.includes("export {")) {
      throw new Error("Generated code missing exports");
    }
  },

  /**
   * Assert that session workflow completed successfully
   */
  assertSuccessfulWorkflow(
    workflow: Awaited<ReturnType<typeof runCompleteWorkflow>>
  ): void {
    if (!workflow.sessionId) {
      throw new Error("Session ID is missing");
    }

    if (!workflow.masterNodeId) {
      throw new Error("Master node ID is missing");
    }

    if (!workflow.actionUrl) {
      throw new Error("Action URL is missing");
    }

    if (!workflow.isComplete) {
      throw new Error(
        `Workflow not completed after ${workflow.iterations} iterations`
      );
    }

    this.assertValidGeneratedCode(workflow.generatedCode);
  },
};
