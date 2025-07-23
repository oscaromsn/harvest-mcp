import { type ActorRefFrom, createActor, type SnapshotFrom } from "xstate";
import type {
  CompletionAnalysis,
  HarvestSession,
  SessionStartParams,
} from "../types";
import { SessionNotFoundError } from "../types";
import { createComponentLogger } from "../utils/logger.js";
import {
  createCompletionAnalysis,
  type SessionContext,
  type SessionEvent,
  sessionMachine,
} from "./session.machine.js";

const logger = createComponentLogger("session-fsm-service");

export type SessionActor = ActorRefFrom<typeof sessionMachine>;
export type SessionSnapshot = SnapshotFrom<typeof sessionMachine>;

/**
 * Service to manage XState session machine instances
 * Provides a centralized way to create, manage, and interact with session state machines
 */
export class SessionFsmService {
  private sessionMachines = new Map<string, SessionActor>();

  /**
   * Create a new session state machine and start it
   */
  createSessionMachine(params: SessionStartParams): string {
    const sessionId = crypto.randomUUID();

    logger.info("Creating new session state machine", {
      sessionId,
      harPath: params.harPath,
      cookiePath: params.cookiePath,
    });

    // Create the state machine with initial context
    const actor = createActor(sessionMachine, {
      input: {
        sessionId,
        prompt: params.prompt,
        harPath: params.harPath,
        cookiePath: params.cookiePath,
      },
    });

    // Set up error handling
    actor.subscribe({
      error: (error) => {
        logger.error("Session state machine error", {
          sessionId,
          error: error instanceof Error ? error.message : "Unknown error",
          stack: error instanceof Error ? error.stack : undefined,
        });
      },
    });

    // Start the machine
    actor.start();

    // Store the running machine
    this.sessionMachines.set(sessionId, actor);

    // Send the initial START_SESSION event
    const startEvent = {
      type: "START_SESSION" as const,
      harPath: params.harPath,
      prompt: params.prompt,
      ...(params.cookiePath && { cookiePath: params.cookiePath }),
    };
    actor.send(startEvent);

    logger.info("Session state machine created and started", {
      sessionId,
      initialState: actor.getSnapshot().value,
    });

    return sessionId;
  }

  /**
   * Get a running session state machine
   */
  getSessionMachine(sessionId: string): SessionActor {
    const machine = this.sessionMachines.get(sessionId);
    if (!machine) {
      throw new SessionNotFoundError(sessionId);
    }
    return machine;
  }

  /**
   * Send an event to a session state machine
   */
  sendEvent(sessionId: string, event: SessionEvent): void {
    const machine = this.getSessionMachine(sessionId);

    logger.debug("Sending event to session machine", {
      sessionId,
      event: event.type,
      currentState: machine.getSnapshot().value,
    });

    machine.send(event);

    logger.debug("Event sent to session machine", {
      sessionId,
      event: event.type,
      newState: machine.getSnapshot().value,
    });
  }

  /**
   * Get the current snapshot of a session state machine
   */
  getSnapshot(sessionId: string): SessionSnapshot {
    const machine = this.getSessionMachine(sessionId);
    return machine.getSnapshot();
  }

  /**
   * Get the current state value of a session state machine
   */
  getCurrentState(sessionId: string): string {
    const snapshot = this.getSnapshot(sessionId);
    return snapshot.value as string;
  }

  /**
   * Get the context (data) of a session state machine
   */
  getContext(sessionId: string): SessionContext {
    const snapshot = this.getSnapshot(sessionId);
    return snapshot.context;
  }

  /**
   * Check if a session state machine can accept a specific event
   */
  canSendEvent(sessionId: string, eventType: SessionEvent["type"]): boolean {
    const snapshot = this.getSnapshot(sessionId);
    return snapshot.can({ type: eventType } as SessionEvent);
  }

  /**
   * Check if a session is in a specific state
   */
  isInState(sessionId: string, state: string): boolean {
    const snapshot = this.getSnapshot(sessionId);
    return snapshot.value === state;
  }

  /**
   * Check if analysis is complete for a session
   */
  isAnalysisComplete(sessionId: string): boolean {
    return (
      this.isInState(sessionId, "readyForCodeGen") ||
      this.isInState(sessionId, "codeGenerated")
    );
  }

  /**
   * Check if code generation is ready for a session
   */
  isReadyForCodeGen(sessionId: string): boolean {
    return this.isInState(sessionId, "readyForCodeGen");
  }

  /**
   * Check if a session has failed
   */
  hasFailed(sessionId: string): boolean {
    return this.isInState(sessionId, "failed");
  }

  /**
   * Get completion analysis for a session based on its current state
   */
  getCompletionAnalysis(sessionId: string): CompletionAnalysis {
    const context = this.getContext(sessionId);
    const currentState = this.getCurrentState(sessionId);

    // Use the state machine context to create completion analysis
    const analysis = createCompletionAnalysis(context);

    // Override isComplete based on state machine state
    analysis.isComplete = this.isAnalysisComplete(sessionId);

    // Add state-specific blockers and recommendations
    if (currentState === "failed") {
      analysis.blockers.push(context.error?.message || "Session failed");
    } else if (currentState === "parsingHar") {
      analysis.blockers.push("HAR file is being parsed");
    } else if (currentState === "discoveringWorkflows") {
      analysis.blockers.push("Discovering workflows");
    } else if (currentState === "awaitingWorkflowSelection") {
      analysis.blockers.push("Waiting for workflow selection");
    } else if (
      currentState === "processingDependencies" ||
      currentState === "processingNode"
    ) {
      analysis.blockers.push("Processing dependencies");
    }

    return analysis;
  }

  /**
   * Convert FSM context to legacy HarvestSession format for backward compatibility
   */
  toHarvestSession(sessionId: string): HarvestSession {
    const context = this.getContext(sessionId);

    // Get the active workflow for legacy compatibility
    const activeWorkflow = context.activeWorkflowId
      ? context.workflowGroups.get(context.activeWorkflowId)
      : undefined;

    return {
      id: context.sessionId,
      prompt: context.prompt,
      harData: context.harData || null,
      cookieData: context.cookieData,
      dagManager: context.dagManager,
      createdAt: new Date(), // TODO: Store actual creation time
      lastActivity: new Date(),
      workflowGroups: context.workflowGroups,
      selectedWorkflowId: context.activeWorkflowId,
      fsm: this.getSessionMachine(sessionId),
      state: {
        // Legacy single-workflow state (for backward compatibility)
        actionUrl: activeWorkflow?.masterNodeId || undefined,
        masterNodeId: activeWorkflow?.masterNodeId || undefined,
        inProcessNodeId: context.inProcessNodeId || undefined,
        toBeProcessedNodes: context.toBeProcessedNodes,
        inProcessNodeDynamicParts: context.inProcessNodeDynamicParts,
        inputVariables: context.inputVariables,
        isComplete: this.isAnalysisComplete(sessionId),
        logs: context.logs,
        generatedCode: context.generatedCode || undefined,
        authAnalysis: context.authAnalysis || undefined,

        // Modern workflow state
        workflowGroups: context.workflowGroups,
        activeWorkflowId: context.activeWorkflowId || undefined,
      },
    };
  }

  /**
   * Get all active session IDs
   */
  getActiveSessionIds(): string[] {
    return Array.from(this.sessionMachines.keys());
  }

  /**
   * Get count of active sessions
   */
  getActiveSessionCount(): number {
    return this.sessionMachines.size;
  }

  /**
   * Stop and remove a session state machine
   */
  removeSession(sessionId: string): boolean {
    const machine = this.sessionMachines.get(sessionId);
    if (!machine) {
      return false;
    }

    logger.info("Stopping and removing session state machine", { sessionId });

    machine.stop();
    this.sessionMachines.delete(sessionId);

    return true;
  }

  /**
   * Stop all session state machines and clear the service
   */
  cleanup(): void {
    logger.info("Cleaning up all session state machines", {
      activeCount: this.sessionMachines.size,
    });

    for (const [sessionId, machine] of this.sessionMachines.entries()) {
      logger.debug("Stopping session machine", { sessionId });
      machine.stop();
    }

    this.sessionMachines.clear();
  }

  /**
   * Get statistics about active sessions
   */
  getStats(): {
    totalSessions: number;
    stateDistribution: Record<string, number>;
    failedSessions: number;
    completedSessions: number;
  } {
    const stateDistribution: Record<string, number> = {};
    let failedSessions = 0;
    let completedSessions = 0;

    for (const [, machine] of this.sessionMachines.entries()) {
      const state = machine.getSnapshot().value as string;
      stateDistribution[state] = (stateDistribution[state] || 0) + 1;

      if (state === "failed") {
        failedSessions++;
      } else if (state === "codeGenerated") {
        completedSessions++;
      }
    }

    return {
      totalSessions: this.sessionMachines.size,
      stateDistribution,
      failedSessions,
      completedSessions,
    };
  }

  /**
   * Get detailed information about a session
   */
  getSessionInfo(sessionId: string): {
    sessionId: string;
    currentState: string;
    context: SessionContext;
    canProcessNext: boolean;
    canGenerateCode: boolean;
    isComplete: boolean;
    hasFailed: boolean;
  } {
    const snapshot = this.getSnapshot(sessionId);

    return {
      sessionId,
      currentState: snapshot.value as string,
      context: snapshot.context,
      canProcessNext: snapshot.can({ type: "PROCESS_NEXT_NODE" }),
      canGenerateCode: snapshot.can({ type: "GENERATE_CODE" }),
      isComplete: this.isAnalysisComplete(sessionId),
      hasFailed: this.hasFailed(sessionId),
    };
  }
}
