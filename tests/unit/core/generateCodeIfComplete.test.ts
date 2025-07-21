/**
 * Unit tests for the generateCodeIfComplete method to validate the fix for Issue #3
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { HarvestMCPServer } from "../../../src/server.js";
import type {
  CodeGenerationData,
  InternalToolResult,
} from "../../../src/types/index.js";

describe("generateCodeIfComplete method", () => {
  let server: HarvestMCPServer;
  let mockInternalHandleGenerateWrapperScript: any;

  beforeEach(async () => {
    server = new HarvestMCPServer();
    // No initialization needed for unit tests

    // Mock the internal method to control its behavior
    mockInternalHandleGenerateWrapperScript = mock();
    (server as any)._internalHandleGenerateWrapperScript =
      mockInternalHandleGenerateWrapperScript;
  });

  test("handles successful code generation correctly", async () => {
    // Arrange
    const mockResult: InternalToolResult<CodeGenerationData> = {
      success: true,
      data: {
        code: "// Generated TypeScript code\nexport function test() {}",
        language: "typescript",
        characterCount: 45,
      },
    };
    mockInternalHandleGenerateWrapperScript.mockResolvedValue(mockResult);

    const steps: string[] = [];
    const warnings: string[] = [];
    const argsObj = { sessionId: "test-session-id" };

    // Act
    const result = await (server as any).generateCodeIfComplete(
      true, // isComplete
      argsObj,
      steps,
      warnings
    );

    // Assert
    expect(result.codeGenerationSuccess).toBe(true);
    expect(result.generatedCode).toBe(mockResult.data.code);
    expect(steps).toContain(
      "✅ Code generation complete - 45 characters generated"
    );
    expect(warnings).toHaveLength(0);
    expect(mockInternalHandleGenerateWrapperScript).toHaveBeenCalledWith({
      sessionId: "test-session-id",
    });
  });

  test("handles code generation failure correctly", async () => {
    // Arrange
    const mockResult: InternalToolResult<CodeGenerationData> = {
      success: false,
      data: { code: "", language: "typescript", characterCount: 0 },
      error: {
        message: "Analysis incomplete - missing master node",
        code: "ANALYSIS_INCOMPLETE",
      },
    };
    mockInternalHandleGenerateWrapperScript.mockResolvedValue(mockResult);

    const steps: string[] = [];
    const warnings: string[] = [];
    const argsObj = { sessionId: "test-session-id" };

    // Act
    const result = await (server as any).generateCodeIfComplete(
      true, // isComplete
      argsObj,
      steps,
      warnings
    );

    // Assert
    expect(result.codeGenerationSuccess).toBe(false);
    expect(result.generatedCode).toBe("");
    expect(warnings).toContain(
      "Code generation error: Analysis incomplete - missing master node"
    );
    expect(steps).not.toContain("✅ Code generation complete");
  });

  test("skips code generation when analysis is not complete", async () => {
    // Arrange
    const steps: string[] = [];
    const warnings: string[] = [];
    const argsObj = { sessionId: "test-session-id" };

    // Act
    const result = await (server as any).generateCodeIfComplete(
      false, // isComplete
      argsObj,
      steps,
      warnings
    );

    // Assert
    expect(result.codeGenerationSuccess).toBe(false);
    expect(result.generatedCode).toBe("");
    expect(steps).toContain(
      "⏭️ Step 3: Skipped code generation (analysis not complete)"
    );
    expect(mockInternalHandleGenerateWrapperScript).not.toHaveBeenCalled();
  });

  test("handles exceptions gracefully with enhanced error context", async () => {
    // Arrange
    const mockError = new Error("Unexpected internal error");
    mockInternalHandleGenerateWrapperScript.mockRejectedValue(mockError);

    // Mock the analyzeCompletionState method
    const mockAnalyzeCompletionState = mock(() => ({
      isComplete: true,
      blockers: [],
      recommendations: [],
      diagnostics: {
        hasMasterNode: true,
        hasActionUrl: true,
        dagComplete: true,
        totalNodes: 1,
        unresolvedNodes: 0,
        pendingInQueue: 0,
        queueEmpty: true,
        authAnalysisComplete: true,
        authReadiness: true,
        authErrors: 0,
        allNodesClassified: true,
        unresolvedDynamicParts: 0,
        unresolvedInputVariables: 0,
        unresolvedSessionConstants: 0,
        nodesNeedingClassification: 0,
        bootstrapAnalysisComplete: true,
        sessionConstantsCount: 0,
      },
    }));
    server.sessionManager.analyzeCompletionState = mockAnalyzeCompletionState;

    const steps: string[] = [];
    const warnings: string[] = [];
    const argsObj = { sessionId: "test-session-id" };

    // Act
    const result = await (server as any).generateCodeIfComplete(
      true, // isComplete
      argsObj,
      steps,
      warnings
    );

    // Assert
    expect(result.codeGenerationSuccess).toBe(false);
    expect(result.generatedCode).toBe("");
    expect(warnings).toContain(
      "Code generation error: Unexpected internal error"
    );
    expect(mockAnalyzeCompletionState).toHaveBeenCalledWith("test-session-id");
  });

  test("preserves type safety with InternalToolResult interface", async () => {
    // This test validates that the typed interface prevents data format errors

    // Arrange: Create a result that would have caused the original JSON parse error
    const mockResult: InternalToolResult<CodeGenerationData> = {
      success: true,
      data: {
        code: "// TypeScript code starting with comment - this would break JSON.parse",
        language: "typescript",
        characterCount: 69,
      },
    };
    mockInternalHandleGenerateWrapperScript.mockResolvedValue(mockResult);

    const steps: string[] = [];
    const warnings: string[] = [];
    const argsObj = { sessionId: "test-session-id" };

    // Act
    const result = await (server as any).generateCodeIfComplete(
      true,
      argsObj,
      steps,
      warnings
    );

    // Assert: No JSON parsing should occur - data accessed directly via typed interface
    expect(result.codeGenerationSuccess).toBe(true);
    expect(result.generatedCode).toBe(mockResult.data.code);
    expect(result.generatedCode).toStartWith("// TypeScript code");

    // Verify no warnings about JSON parsing
    const jsonWarnings = warnings.filter((w) => w.includes("JSON Parse error"));
    expect(jsonWarnings).toHaveLength(0);
  });

  test("correctly uses character count from typed result", async () => {
    // Arrange
    const testCode = "const test = 'hello world';";
    const mockResult: InternalToolResult<CodeGenerationData> = {
      success: true,
      data: {
        code: testCode,
        language: "typescript",
        characterCount: testCode.length,
      },
    };
    mockInternalHandleGenerateWrapperScript.mockResolvedValue(mockResult);

    const steps: string[] = [];
    const warnings: string[] = [];
    const argsObj = { sessionId: "test-session-id" };

    // Act
    const result = await (server as any).generateCodeIfComplete(
      true,
      argsObj,
      steps,
      warnings
    );

    // Assert
    expect(result.generatedCode).toBe(testCode);
    expect(steps).toContain(
      `✅ Code generation complete - ${testCode.length} characters generated`
    );
  });
});
