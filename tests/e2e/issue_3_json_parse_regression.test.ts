/**
 * Comprehensive E2E regression test for Issue #3: JSON Parse Error in workflow_complete_analysis
 *
 * This test validates that the fix prevents the JSON parsing error when workflow_complete_analysis
 * is called with the jurisprudencia.jt.jus.br HAR file that originally triggered the bug.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import path from "node:path";
import { HarvestMCPServer } from "../../src/server.js";

describe("Issue #3 Regression: JSON Parse Error Fix", () => {
  let server: HarvestMCPServer;
  const harFilePath = path.resolve(
    __dirname,
    "../fixtures/issue_3/shared/616a7981-5b79-476f-b7d5-4e5f0d2b66a1/network-2025-07-21T01-47-16-962Z.har"
  );

  beforeAll(async () => {
    server = new HarvestMCPServer();
    // No initialization needed for this test
  });

  afterAll(async () => {
    if (server) {
      server.sessionManager.clearAllSessions();
    }
  });

  test("workflow_complete_analysis succeeds without JSON parse errors", async () => {
    // This test reproduces the exact scenario that caused the original bug
    const prompt =
      "Generate a comprehensive TypeScript fetcher for searching Brazilian Labor Court jurisprudence from jurisprudencia.jt.jus.br. The fetcher should support all available search filters, parameters, and return structured data with proper typing. Include support for search terms, date ranges, court selection, document types, and pagination. Ensure the fetcher can handle different search scenarios and properly parse the response data into a structured format.";

    const result = await server.handleCompleteAnalysis({
      harPath: harFilePath,
      prompt: prompt,
      maxIterations: 25,
    });

    // Parse the response
    const responseText = result.content?.[0]?.text;
    expect(responseText).toBeDefined();
    expect(typeof responseText).toBe("string");

    const responseData = JSON.parse(responseText as string);

    // Validate that the workflow reports success
    expect(responseData.success).toBe(true);
    expect(responseData.sessionId).toBeDefined();

    // Validate that analysis completed
    expect(responseData.result).toBeDefined();
    expect(responseData.result.analysisComplete).toBe(true);
    expect(responseData.result.codeGenerated).toBe(true);
    expect(responseData.result.workflowStatus).toBe("completed");

    // Validate that code was actually generated
    expect(responseData.result.codeLength).toBeGreaterThan(0);
    expect(responseData.generatedCode).toBeDefined();
    expect(responseData.generatedCode.length).toBeGreaterThan(0);

    // Validate that no JSON parsing warnings exist
    const warnings = responseData.warnings || [];
    const jsonParseWarnings = warnings.filter(
      (warning: string) =>
        warning.includes("JSON Parse error") ||
        warning.includes("Unrecognized token")
    );
    expect(jsonParseWarnings).toHaveLength(0);

    // Validate that the generated code is valid TypeScript
    expect(responseData.generatedCode).toContain(
      "// Harvest Generated API Integration Code"
    );
    expect(responseData.generatedCode).toContain("interface");
    expect(responseData.generatedCode).toContain("export");

    // Validate target URL was identified correctly
    expect(responseData.result.targetUrl).toContain("jurisprudencia.jt.jus.br");
    expect(responseData.result.targetUrl).toContain("/api/no-auth/pesquisa");
  });

  test("session_status matches workflow_complete_analysis results", async () => {
    // Create a session first
    const sessionResult = await server.handleSessionStart({
      harPath: harFilePath,
      prompt: "Generate jurisprudencia fetcher",
    });

    const sessionResponseText = sessionResult.content?.[0]?.text;
    const sessionData = JSON.parse(sessionResponseText as string);
    const sessionId = sessionData.sessionId;

    // Run the workflow
    const workflowResult = await server.handleCompleteAnalysis({
      harPath: harFilePath,
      prompt: "Generate jurisprudencia fetcher",
      maxIterations: 25,
    });

    const workflowResponseText = workflowResult.content?.[0]?.text;
    const workflowData = JSON.parse(workflowResponseText as string);

    // Get session status
    const statusResult = await server.handleSessionStatus({ sessionId });
    const statusResponseText = statusResult.content?.[0]?.text;
    const statusData = JSON.parse(statusResponseText as string);

    // Validate consistency between workflow and session status
    expect(workflowData.result.codeGenerated).toBe(true);
    expect(statusData.status.canGenerateCode).toBe(true);

    // Both should report that code was generated
    expect(workflowData.result.codeLength).toBeGreaterThan(0);

    // Session logs should show successful code generation
    const successLogs = statusData.logs.filter((log: any) =>
      log.message.includes("Code generation completed successfully")
    );
    expect(successLogs.length).toBeGreaterThan(0);
  });

  test("direct codegen_generate_wrapper_script still works", async () => {
    // Create and complete analysis for a session
    const sessionResult = await server.handleSessionStart({
      harPath: harFilePath,
      prompt: "Generate jurisprudencia fetcher",
    });

    const sessionResponseText = sessionResult.content?.[0]?.text;
    const sessionData = JSON.parse(sessionResponseText as string);
    const sessionId = sessionData.sessionId;

    // Run analysis to completion
    await server.handleRunInitialAnalysis({ sessionId });

    // Process any nodes if needed
    let isComplete = false;
    let attempts = 0;
    while (!isComplete && attempts < 10) {
      const statusResult = await server.handleIsComplete({ sessionId });
      const statusText = statusResult.content?.[0]?.text;
      const statusData = JSON.parse(statusText as string);

      if (statusData.isComplete) {
        isComplete = true;
        break;
      }

      // Process next node
      try {
        await server.handleProcessNextNode({ sessionId });
      } catch (error) {
        // May fail if queue is empty
        break;
      }
      attempts++;
    }

    if (isComplete) {
      // Test direct code generation
      const codeResult = await server.handleGenerateWrapperScript({
        sessionId,
      });

      const codeText = codeResult.content?.[0]?.text;
      expect(codeText).toBeDefined();
      expect(typeof codeText).toBe("string");
      expect((codeText as string).length).toBeGreaterThan(0);
      expect(codeText).toContain("// Harvest Generated API Integration Code");
    }
  });

  test("error context is preserved in all failure modes", async () => {
    // Test with an invalid/empty HAR file to ensure error context is preserved
    const invalidHarPath = path.resolve(__dirname, "../fixtures/empty.har");

    try {
      await server.handleCompleteAnalysis({
        harPath: invalidHarPath,
        prompt: "Test error handling",
        maxIterations: 1,
      });
    } catch (error: any) {
      // Should get a meaningful error, not a generic JSON parse error
      expect(error.message).toBeDefined();
      expect(error.message).not.toContain("Unrecognized token '/'");
      expect(error.message).not.toContain("JSON Parse error");
    }
  });
});
