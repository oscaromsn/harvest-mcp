import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { generateWrapperScript } from "../core/CodeGenerator.js";
import {
  type CodeGenerationData,
  type CodegenToolContext,
  HarvestError,
  type HarvestSession,
  type InternalToolResult,
  type SessionManagerWithFSM,
} from "../types/index.js";

/**
 * Handle codegen.generate_wrapper_script tool call (public MCP interface)
 */
export async function handleGenerateWrapperScript(
  params: { sessionId: string },
  context: CodegenToolContext
): Promise<CallToolResult> {
  const result = await _internalHandleGenerateWrapperScript(params, context);

  if (!result.success) {
    throw new HarvestError(
      result.error?.message || "Code generation failed",
      result.error?.code || "CODE_GENERATION_FAILED"
    );
  }

  return {
    content: [
      {
        type: "text",
        text: result.data.code,
      },
    ],
  };
}

// ========== Helper Functions for Code Generation ==========

function validateSession(
  params: { sessionId: string },
  context: CodegenToolContext
) {
  const session = context.sessionManager.getSession(params.sessionId);
  if (!session) {
    return {
      isValid: false,
      error: {
        message: `Session ${params.sessionId} not found`,
        code: "SESSION_NOT_FOUND",
      },
    };
  }
  return { isValid: true, session };
}

function checkFsmState(
  params: { sessionId: string },
  context: CodegenToolContext
) {
  const sessionManager =
    context.sessionManager as unknown as SessionManagerWithFSM;

  const currentState = sessionManager.getFsmState(params.sessionId);

  if (currentState === "failed") {
    const fsmContext = sessionManager.fsmService.getContext(params.sessionId);
    return {
      canGenerate: false,
      error: {
        message: `Session has failed - cannot generate code: ${fsmContext.error?.message || "Unknown error"}`,
        code: "SESSION_FAILED",
      },
    };
  }

  if (currentState !== "readyForCodeGen" && currentState !== "codeGenerated") {
    const stateGuidance = getStateGuidance(currentState);
    return {
      canGenerate: false,
      error: {
        message: `Code generation not allowed in current state: ${currentState}. ${stateGuidance}`,
        code: "INVALID_STATE_FOR_CODEGEN",
      },
    };
  }

  return { canGenerate: true, currentState };
}

function getStateGuidance(currentState: string): string {
  switch (currentState) {
    case "parsingHar":
      return "Wait for HAR parsing to complete";
    case "discoveringWorkflows":
      return "Wait for workflow discovery to complete";
    case "awaitingWorkflowSelection":
      return "Use 'analysis_start_primary_workflow' to select a workflow";
    case "processingDependencies":
    case "processingNode":
      return "Continue with 'analysis_process_next_node' until all dependencies are resolved";
    default:
      return "Continue analysis to reach the readyForCodeGen state";
  }
}

async function tryFsmCodeGeneration(
  params: { sessionId: string },
  context: CodegenToolContext,
  session: HarvestSession,
  currentState: string
): Promise<
  | { success: true; result: InternalToolResult<CodeGenerationData> }
  | { success: false }
> {
  const sessionManager =
    context.sessionManager as unknown as SessionManagerWithFSM;

  if (currentState === "readyForCodeGen") {
    try {
      sessionManager.sendFsmEvent(params.sessionId, { type: "GENERATE_CODE" });
      await new Promise((resolve) => setTimeout(resolve, 100));

      const newState = sessionManager.getFsmState(params.sessionId);
      if (newState === "codeGenerated") {
        const fsmContext = sessionManager.fsmService.getContext(
          params.sessionId
        );
        if (fsmContext.generatedCode) {
          session.state.generatedCode = fsmContext.generatedCode;
          sessionManager.addLog(
            params.sessionId,
            "info",
            `Code generation completed via FSM - ${fsmContext.generatedCode.length} characters generated`
          );

          return {
            success: true,
            result: {
              success: true,
              data: {
                code: fsmContext.generatedCode,
                language: "typescript",
                characterCount: fsmContext.generatedCode.length,
              },
            },
          };
        }
      } else if (newState === "failed") {
        const fsmContext = sessionManager.fsmService.getContext(
          params.sessionId
        );
        return {
          success: true,
          result: {
            success: false,
            data: { code: "", language: "typescript", characterCount: 0 },
            error: {
              message: `FSM code generation failed: ${fsmContext.error?.message || "Unknown error"}`,
              code: "FSM_CODE_GENERATION_FAILED",
            },
          },
        };
      }
    } catch (fsmError) {
      sessionManager.addLog(
        params.sessionId,
        "warn",
        `FSM code generation failed, falling back to legacy method: ${fsmError instanceof Error ? fsmError.message : "Unknown error"}`
      );
    }
  } else if (currentState === "codeGenerated") {
    const fsmContext = sessionManager.fsmService.getContext(params.sessionId);
    if (fsmContext.generatedCode) {
      return {
        success: true,
        result: {
          success: true,
          data: {
            code: fsmContext.generatedCode,
            language: "typescript",
            characterCount: fsmContext.generatedCode.length,
          },
        },
      };
    }
  }

  return { success: false };
}

function createComprehensiveErrorMessage(analysis: {
  blockers: string[];
  recommendations: string[];
  diagnostics: {
    hasMasterNode: boolean;
    hasActionUrl: boolean;
    dagComplete: boolean;
    pendingInQueue: number;
    queueEmpty: boolean;
    totalNodes: number;
    unresolvedNodes: number;
  };
}): string {
  const blockersList = analysis.blockers
    .map((blocker, index) => `  ${index + 1}. ${blocker}`)
    .join("\n");
  const recommendationsList = analysis.recommendations
    .map((rec, index) => `  ${index + 1}. ${rec}`)
    .join("\n");

  return `Code generation failed - analysis prerequisites not met.

🚫 Blockers preventing completion:
${blockersList}

💡 Recommended actions:
${recommendationsList}

📊 Analysis diagnostics:
  - Master node identified: ${analysis.diagnostics.hasMasterNode ? "✅" : "❌"}
  - Target action URL found: ${analysis.diagnostics.hasActionUrl ? "✅" : "❌"}
  - DAG completion: ${analysis.diagnostics.dagComplete ? "✅" : "❌"}
  - Processing queue: ${analysis.diagnostics.pendingInQueue} pending, ${analysis.diagnostics.queueEmpty ? "empty" : "active"}
  - Node resolution: ${analysis.diagnostics.totalNodes - analysis.diagnostics.unresolvedNodes}/${analysis.diagnostics.totalNodes} resolved`;
}

async function executeLegacyCodeGeneration(
  params: { sessionId: string },
  context: CodegenToolContext,
  session: HarvestSession
): Promise<InternalToolResult<CodeGenerationData>> {
  const analysis = context.sessionManager.analyzeCompletionState(
    params.sessionId
  );

  if (!analysis.isComplete) {
    const detailedMessage = createComprehensiveErrorMessage(analysis);
    return {
      success: false,
      data: { code: "", language: "typescript", characterCount: 0 },
      error: {
        message: detailedMessage,
        code: "ANALYSIS_INCOMPLETE",
      },
    };
  }

  context.sessionManager.addLog(
    params.sessionId,
    "info",
    "Starting code generation for completed analysis"
  );

  const generatedCode = await generateWrapperScript(session);
  session.state.generatedCode = generatedCode;

  context.sessionManager.addLog(
    params.sessionId,
    "info",
    `Code generation completed successfully - ${generatedCode.length} characters generated`
  );

  await cacheSessionArtifacts(params, context, session);

  return {
    success: true,
    data: {
      code: generatedCode,
      language: "typescript",
      characterCount: generatedCode.length,
    },
  };
}

async function cacheSessionArtifacts(
  params: { sessionId: string },
  context: CodegenToolContext,
  session: HarvestSession
): Promise<void> {
  try {
    const analysis = context.sessionManager.analyzeCompletionState(
      params.sessionId
    );
    await context.completedSessionManager.cacheCompletedSession(
      session,
      analysis
    );

    context.sessionManager.addLog(
      params.sessionId,
      "info",
      "Session artifacts cached successfully for future access"
    );
  } catch (cacheError) {
    context.sessionManager.addLog(
      params.sessionId,
      "warn",
      `Failed to cache session artifacts: ${cacheError instanceof Error ? cacheError.message : "Unknown error"}`
    );
  }
}

/**
 * Internal strongly-typed code generation method - refactored for reduced cognitive complexity
 */
async function _internalHandleGenerateWrapperScript(
  params: { sessionId: string },
  context: CodegenToolContext
): Promise<InternalToolResult<CodeGenerationData>> {
  try {
    // Validate session exists
    const sessionValidation = validateSession(params, context);
    if (!sessionValidation.isValid) {
      return {
        success: false,
        data: { code: "", language: "typescript", characterCount: 0 },
        error: sessionValidation.error || {
          message: "Unknown session validation error",
          code: "VALIDATION_ERROR",
        },
      };
    }

    const session = sessionValidation.session;
    if (!session) {
      return {
        success: false,
        data: { code: "", language: "typescript", characterCount: 0 },
        error: {
          message: "Session not found after validation",
          code: "SESSION_MISSING",
        },
      };
    }

    // Check FSM state for code generation readiness
    const stateCheck = checkFsmState(params, context);
    if (!stateCheck.canGenerate) {
      return {
        success: false,
        data: { code: "", language: "typescript", characterCount: 0 },
        error: stateCheck.error || {
          message: "Unknown state check error",
          code: "STATE_CHECK_ERROR",
        },
      };
    }

    const { currentState } = stateCheck;

    // Try FSM-based code generation first
    const fsmResult = await tryFsmCodeGeneration(
      params,
      context,
      session,
      currentState || "unknown"
    );
    if (fsmResult.success) {
      return fsmResult.result;
    }

    // Fall back to legacy code generation
    return await executeLegacyCodeGeneration(params, context, session);
  } catch (error) {
    // Handle specific error types
    if (
      error instanceof Error &&
      error.message.includes("Graph contains cycles")
    ) {
      return {
        success: false,
        data: { code: "", language: "typescript", characterCount: 0 },
        error: {
          message: error.message,
          code: "GRAPH_CONTAINS_CYCLES",
        },
      };
    }

    return {
      success: false,
      data: { code: "", language: "typescript", characterCount: 0 },
      error: {
        message: `Code generation failed: ${error instanceof Error ? error.message : "Unknown error"}`,
        code: "CODE_GENERATION_FAILED",
      },
    };
  }
}

/**
 * Register code generation tools with the MCP server
 */
export function registerCodegenTools(
  server: McpServer,
  context: CodegenToolContext
): void {
  server.tool(
    "codegen_generate_wrapper_script",
    "Generate a complete TypeScript wrapper script from the completed dependency analysis. Only works when analysis is complete (all nodes resolved).",
    {
      sessionId: z
        .string()
        .uuid()
        .describe(
          "UUID of the session with completed analysis. Use analysis_is_complete to verify the session is ready for code generation."
        ),
    },
    async (params) => handleGenerateWrapperScript(params, context)
  );
}
