/**
 * End-to-End Test: Issue 3 - Brazilian Legal Document Search Workflow
 *
 * This E2E test validates the complete XState FSM workflow for generating a comprehensive
 * TypeScript fetcher for searching Brazilian Labor Court jurisprudence from
 * jurisprudencia.jt.jus.br using real HAR data from issue #3.
 *
 * The test covers:
 * - XState FSM session creation and initialization
 * - Event-driven HAR parsing and workflow discovery
 * - Automated FSM state transitions
 * - Code generation via FSM events
 * - Generated code validation and structure verification
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initializeConfig } from "../../src/config/index.js";
import { validateConfiguration } from "../../src/core/providers/ProviderFactory.js";
import type { SessionFsmService } from "../../src/core/SessionFsmService.js";
import { SessionManager } from "../../src/core/SessionManager.js";
import type { SessionManagerWithFSM } from "../../src/types/index.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Test data paths - using simpler test file first
const ISSUE3_HAR_PATH = path.join(
  __dirname,
  "../fixtures/test-data/pangea_search.har"
);

const ISSUE3_PROMPT =
  "Generate a comprehensive TypeScript API wrapper for searching legal documents";

// Helper function to wait for FSM state transition with timeout
async function waitForStateTransition(
  sessionManager: SessionManagerWithFSM,
  sessionId: string,
  targetState: string | string[],
  timeoutMs = 60000
): Promise<string> {
  const startTime = Date.now();
  const targetStates = Array.isArray(targetState) ? targetState : [targetState];

  return new Promise((resolve, reject) => {
    const checkState = () => {
      try {
        const currentState = sessionManager.getFsmState(sessionId);

        // Check for target states
        if (targetStates.includes(currentState)) {
          console.log(`✅ FSM reached target state: ${currentState}`);
          resolve(currentState);
          return;
        }

        // Check for failed state
        if (currentState === "failed") {
          const context = sessionManager.fsmService.getContext(sessionId);
          reject(
            new Error(
              `FSM failed: ${context.error?.message || "Unknown error"}`
            )
          );
          return;
        }

        // Check timeout
        if (Date.now() - startTime > timeoutMs) {
          reject(
            new Error(
              `FSM timeout waiting for ${targetStates.join(" or ")} after ${timeoutMs}ms. Current state: ${currentState}`
            )
          );
          return;
        }

        // Auto-drive FSM for dependency processing
        if (currentState === "processingDependencies") {
          const canProcessNext = sessionManager.fsmService.canSendEvent(
            sessionId,
            "PROCESS_NEXT_NODE"
          );
          if (canProcessNext) {
            console.log("🔧 Auto-sending PROCESS_NEXT_NODE event to drive FSM");
            sessionManager.sendFsmEvent(sessionId, {
              type: "PROCESS_NEXT_NODE",
            });
          }
        }

        // Continue polling
        setTimeout(checkState, 100);
      } catch (error) {
        reject(error);
      }
    };

    checkState();
  });
}

describe("E2E: Issue 3 - Brazilian Legal Document Search Workflow", () => {
  let sessionManager: SessionManager;

  beforeEach(async () => {
    // Map .env vars to HARVEST_ vars if needed (since vitest setup might not have done it)
    if (process.env.GOOGLE_API_KEY && !process.env.HARVEST_GOOGLE_API_KEY) {
      process.env.HARVEST_GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
    }
    if (process.env.OPENAI_API_KEY && !process.env.HARVEST_OPENAI_API_KEY) {
      process.env.HARVEST_OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    }
    if (process.env.LLM_PROVIDER && !process.env.HARVEST_LLM_PROVIDER) {
      process.env.HARVEST_LLM_PROVIDER = process.env.LLM_PROVIDER;
    }

    // Initialize configuration (only if not already initialized)
    try {
      try {
        initializeConfig();
      } catch (error) {
        if (
          !(error instanceof Error) ||
          !error.message?.includes("already been initialized")
        ) {
          throw error;
        }
      }

      const configStatus = validateConfiguration();
      if (!configStatus.isConfigured) {
        console.warn(
          "⚠️ LLM provider not configured - using mock responses for E2E test"
        );
      }
    } catch (error) {
      console.warn("⚠️ Configuration warning:", error);
    }

    // Initialize session manager
    sessionManager = new SessionManager();

    console.log("✅ E2E test environment initialized");
  });

  afterEach(() => {
    // Clean up all sessions
    sessionManager.clearAllSessions();
  });

  it("should complete the full XState FSM workflow from HAR analysis to code generation", async () => {
    console.log("🚀 Starting XState FSM E2E Workflow Test");

    // Step 1: Create FSM-based session directly with SessionManager
    console.log("📁 Step 1: Creating XState FSM session with HAR data");
    console.log(`HAR Path: ${ISSUE3_HAR_PATH}`);

    let sessionId: string;
    try {
      sessionId = await sessionManager.createSession({
        harPath: ISSUE3_HAR_PATH,
        prompt: ISSUE3_PROMPT,
      });
      console.log(`✅ XState FSM session created: ${sessionId}`);
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      console.error("❌ Session creation failed:", errorMessage);
      throw error;
    }

    expect(sessionId).toBeDefined();

    // Step 2: Access FSM service directly from SessionManager
    const fsmService = (sessionManager as any).fsmService as SessionFsmService;

    // Step 3: Wait for FSM to complete analysis automatically
    console.log("🔍 Step 3: Waiting for FSM to complete analysis");

    const sessionManagerWithFSM =
      sessionManager as unknown as SessionManagerWithFSM;
    await waitForStateTransition(
      sessionManagerWithFSM,
      sessionId,
      "readyForCodeGen",
      60000
    );

    // Step 4: Trigger code generation
    console.log("🛠️ Step 4: Sending GENERATE_CODE event");

    fsmService.sendEvent(sessionId, { type: "GENERATE_CODE" });
    await waitForStateTransition(
      sessionManagerWithFSM,
      sessionId,
      "codeGenerated",
      60000
    );

    // Step 5: Verify final state and generated code
    const finalState = fsmService.getCurrentState(sessionId);
    expect(finalState).toBe("codeGenerated");

    const finalContext = fsmService.getContext(sessionId);
    expect(finalContext.generatedCode).toBeDefined();

    if (finalContext.generatedCode) {
      expect(finalContext.generatedCode.length).toBeGreaterThan(100);

      // Validate basic code structure
      expect(finalContext.generatedCode).toContain("function");
      expect(finalContext.generatedCode).toContain("export");
    }

    console.log("✅ E2E XState FSM workflow completed successfully!");
  }, 120000); // 2 minute timeout for full E2E

  it("should handle edge cases and error scenarios gracefully", async () => {
    // Test invalid HAR path
    await expect(
      sessionManager.createSession({
        harPath: "/non/existent/file.har",
        prompt: "test",
      })
    ).rejects.toThrow();

    // Test empty prompt
    await expect(
      sessionManager.createSession({
        harPath: ISSUE3_HAR_PATH,
        prompt: "",
      })
    ).rejects.toThrow();

    // Test invalid session ID access
    const fsmService = (sessionManager as any).fsmService as SessionFsmService;
    expect(() => fsmService.getCurrentState("invalid-session-id")).toThrow();
  });

  it("should validate HAR file compatibility and structure", async () => {
    const sessionId = await sessionManager.createSession({
      harPath: ISSUE3_HAR_PATH,
      prompt: "Test HAR compatibility",
    });

    const sessionManagerWithFSM =
      sessionManager as unknown as SessionManagerWithFSM;
    const fsmService = sessionManagerWithFSM.fsmService;

    // Wait for HAR processing
    await waitForStateTransition(
      sessionManagerWithFSM,
      sessionId,
      [
        "awaitingWorkflowSelection",
        "processingDependencies",
        "readyForCodeGen",
      ],
      30000
    );

    const context = fsmService.getContext(sessionId);

    // Validate HAR data structure
    expect(context.harData).toBeDefined();

    if (context.harData) {
      expect(context.harData.requests).toBeDefined();
      expect(Array.isArray(context.harData.requests)).toBe(true);
      expect(context.harData.requests.length).toBeGreaterThan(0);
    }
  });
});
