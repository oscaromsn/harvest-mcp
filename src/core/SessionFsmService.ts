import { type ActorRefFrom, createActor, type SnapshotFrom } from "xstate";
import type { CompletionAnalysis, SessionStartParams } from "../types";
import { SessionNotFoundError } from "../types";
import { createComponentLogger } from "../utils/logger.js";
import {
  type ManualSessionContext,
  type ManualSessionEvent,
  manualSessionMachine,
} from "./manualSession.machine.js";
import {
  createCompletionAnalysis,
  type SessionContext,
  type SessionEvent,
  sessionMachine,
} from "./session.machine.js";

const logger = createComponentLogger("session-fsm-service");

export type SessionActor = ActorRefFrom<typeof sessionMachine>;
export type SessionSnapshot = SnapshotFrom<typeof sessionMachine>;
export type ManualSessionActor = ActorRefFrom<typeof manualSessionMachine>;
export type ManualSessionSnapshot = SnapshotFrom<typeof manualSessionMachine>;

// Union types for handling both session types
export type AnySessionActor = SessionActor | ManualSessionActor;
export type AnySessionSnapshot = SessionSnapshot | ManualSessionSnapshot;
export type AnySessionContext = SessionContext | ManualSessionContext;
export type SessionType = "analysis" | "manual";

// Session metadata for tracking different session types
interface SessionMetadata {
  sessionId: string;
  type: SessionType;
  actor: AnySessionActor;
  createdAt: Date;
  lastActivity: Date;
}

/**
 * Unified service to manage both analysis and manual session state machines
 * Provides a centralized way to create, manage, and interact with both types of session FSMs
 */
export class SessionFsmService {
  private sessionMachines = new Map<string, SessionMetadata>();

  /**
   * Create a new analysis session state machine and start it
   */
  createSessionMachine(params: SessionStartParams): string {
    const sessionId = crypto.randomUUID();

    logger.info("Creating new analysis session state machine", {
      sessionId,
      harPath: params.harPath,
      cookiePath: params.cookiePath,
    });

    // Create the analysis state machine with initial context
    const actor = createActor(sessionMachine, {
      input: {
        sessionId,
        prompt: params.prompt,
        harPath: params.harPath,
        cookiePath: params.cookiePath,
      },
    });

    // Set up error handling
    this.setupErrorHandling(actor, sessionId, "analysis");

    // Start the machine
    actor.start();

    // Store the running machine with metadata
    const metadata: SessionMetadata = {
      sessionId,
      type: "analysis",
      actor: actor as AnySessionActor,
      createdAt: new Date(),
      lastActivity: new Date(),
    };
    this.sessionMachines.set(sessionId, metadata);

    // Send the initial START_SESSION event
    const startEvent = {
      type: "START_SESSION" as const,
      harPath: params.harPath,
      prompt: params.prompt,
      ...(params.cookiePath && { cookiePath: params.cookiePath }),
      ...(params.inputVariables && { inputVariables: params.inputVariables }),
    };
    actor.send(startEvent);

    logger.info("Analysis session state machine created and started", {
      sessionId,
      initialState: actor.getSnapshot().value,
    });

    return sessionId;
  }

  /**
   * Create a new manual session state machine and start it
   */
  createManualSessionMachine(config: {
    url?: string;
    sessionConfig?: any;
  }): string {
    const sessionId = crypto.randomUUID();

    logger.info("Creating new manual session state machine", {
      sessionId,
      url: config.url,
    });

    // Create the manual session state machine with initial context
    const actor = createActor(manualSessionMachine, {
      input: {
        sessionId,
        config: {
          url: config.url,
          ...config.sessionConfig,
        },
      },
    });

    // Set up error handling
    this.setupErrorHandling(actor, sessionId, "manual");

    // Start the machine
    actor.start();

    // Store the running machine with metadata
    const metadata: SessionMetadata = {
      sessionId,
      type: "manual",
      actor: actor as AnySessionActor,
      createdAt: new Date(),
      lastActivity: new Date(),
    };
    this.sessionMachines.set(sessionId, metadata);

    // Send the initial START_MANUAL_SESSION event
    const startEvent = {
      type: "START_MANUAL_SESSION" as const,
      config: {
        url: config.url,
        ...config.sessionConfig,
      },
    };
    (actor as ManualSessionActor).send(startEvent);

    logger.info("Manual session state machine created and started", {
      sessionId,
      initialState: actor.getSnapshot().value,
    });

    return sessionId;
  }

  /**
   * Setup error handling for any session actor
   */
  private setupErrorHandling(
    actor: AnySessionActor,
    sessionId: string,
    type: SessionType
  ): void {
    // Type-safe error handling for both session types
    if (type === "analysis") {
      (actor as SessionActor).subscribe({
        error: (error: any) => {
          logger.error(`${type} session state machine error`, {
            sessionId,
            type,
            error: error instanceof Error ? error.message : "Unknown error",
            stack: error instanceof Error ? error.stack : undefined,
          });
        },
      });
    } else {
      (actor as ManualSessionActor).subscribe({
        error: (error: any) => {
          logger.error(`${type} session state machine error`, {
            sessionId,
            type,
            error: error instanceof Error ? error.message : "Unknown error",
            stack: error instanceof Error ? error.stack : undefined,
          });
        },
      });
    }
  }

  /**
   * Get a running session state machine (analysis sessions only)
   */
  getSessionMachine(sessionId: string): SessionActor {
    const metadata = this.sessionMachines.get(sessionId);
    if (!metadata) {
      throw new SessionNotFoundError(sessionId);
    }
    if (metadata.type !== "analysis") {
      throw new Error(
        `Session ${sessionId} is not an analysis session (type: ${metadata.type})`
      );
    }
    return metadata.actor as SessionActor;
  }

  /**
   * Get a running manual session state machine
   */
  getManualSessionMachine(sessionId: string): ManualSessionActor {
    const metadata = this.sessionMachines.get(sessionId);
    if (!metadata) {
      throw new SessionNotFoundError(sessionId);
    }
    if (metadata.type !== "manual") {
      throw new Error(
        `Session ${sessionId} is not a manual session (type: ${metadata.type})`
      );
    }
    return metadata.actor as ManualSessionActor;
  }

  /**
   * Get any session state machine (unified interface)
   */
  getAnySessionMachine(sessionId: string): {
    actor: AnySessionActor;
    type: SessionType;
  } {
    const metadata = this.sessionMachines.get(sessionId);
    if (!metadata) {
      throw new SessionNotFoundError(sessionId);
    }
    return {
      actor: metadata.actor,
      type: metadata.type,
    };
  }

  /**
   * Get session type
   */
  getSessionType(sessionId: string): SessionType {
    const metadata = this.sessionMachines.get(sessionId);
    if (!metadata) {
      throw new SessionNotFoundError(sessionId);
    }
    return metadata.type;
  }

  /**
   * Send an event to an analysis session state machine
   */
  sendEvent(sessionId: string, event: SessionEvent): void {
    const machine = this.getSessionMachine(sessionId);
    this.updateLastActivity(sessionId);

    logger.debug("Sending event to analysis session machine", {
      sessionId,
      event: event.type,
      currentState: machine.getSnapshot().value,
    });

    machine.send(event);

    logger.debug("Event sent to analysis session machine", {
      sessionId,
      event: event.type,
      newState: machine.getSnapshot().value,
    });
  }

  /**
   * Send an event to a manual session state machine
   */
  sendManualEvent(sessionId: string, event: ManualSessionEvent): void {
    const machine = this.getManualSessionMachine(sessionId);
    this.updateLastActivity(sessionId);

    logger.debug("Sending event to manual session machine", {
      sessionId,
      event: event.type,
      currentState: machine.getSnapshot().value,
    });

    machine.send(event);

    logger.debug("Event sent to manual session machine", {
      sessionId,
      event: event.type,
      newState: machine.getSnapshot().value,
    });
  }

  /**
   * Send an event to any session state machine (unified interface)
   */
  sendAnyEvent(
    sessionId: string,
    event: SessionEvent | ManualSessionEvent
  ): void {
    const { actor, type } = this.getAnySessionMachine(sessionId);
    this.updateLastActivity(sessionId);

    logger.debug(`Sending event to ${type} session machine`, {
      sessionId,
      type,
      event: event.type,
      currentState: actor.getSnapshot().value,
    });

    actor.send(event as any); // Type assertion needed for union events

    logger.debug(`Event sent to ${type} session machine`, {
      sessionId,
      type,
      event: event.type,
      newState: actor.getSnapshot().value,
    });
  }

  /**
   * Update last activity timestamp
   */
  private updateLastActivity(sessionId: string): void {
    const metadata = this.sessionMachines.get(sessionId);
    if (metadata) {
      metadata.lastActivity = new Date();
    }
  }

  /**
   * Get the current snapshot of an analysis session state machine
   */
  getSnapshot(sessionId: string): SessionSnapshot {
    const machine = this.getSessionMachine(sessionId);
    return machine.getSnapshot();
  }

  /**
   * Get the current snapshot of a manual session state machine
   */
  getManualSnapshot(sessionId: string): ManualSessionSnapshot {
    const machine = this.getManualSessionMachine(sessionId);
    return machine.getSnapshot();
  }

  /**
   * Get the current snapshot of any session state machine
   */
  getAnySnapshot(sessionId: string): AnySessionSnapshot {
    const { actor } = this.getAnySessionMachine(sessionId);
    return actor.getSnapshot();
  }

  /**
   * Get the current state value of an analysis session state machine
   */
  getCurrentState(sessionId: string): string {
    const snapshot = this.getSnapshot(sessionId);
    return snapshot.value as string;
  }

  /**
   * Get the current state value of a manual session state machine
   */
  getCurrentManualState(sessionId: string): string {
    const snapshot = this.getManualSnapshot(sessionId);
    return snapshot.value as string;
  }

  /**
   * Get the current state value of any session state machine
   */
  getCurrentAnyState(sessionId: string): string {
    const snapshot = this.getAnySnapshot(sessionId);
    return snapshot.value as string;
  }

  /**
   * Get the context (data) of an analysis session state machine
   */
  getContext(sessionId: string): SessionContext {
    const snapshot = this.getSnapshot(sessionId);
    return snapshot.context;
  }

  /**
   * Get the context (data) of a manual session state machine
   */
  getManualContext(sessionId: string): ManualSessionContext {
    const snapshot = this.getManualSnapshot(sessionId);
    return snapshot.context;
  }

  /**
   * Get the context (data) of any session state machine
   */
  getAnyContext(sessionId: string): AnySessionContext {
    const snapshot = this.getAnySnapshot(sessionId);
    return snapshot.context;
  }

  /**
   * Check if an analysis session state machine can accept a specific event
   */
  canSendEvent(sessionId: string, eventType: SessionEvent["type"]): boolean {
    const snapshot = this.getSnapshot(sessionId);
    return snapshot.can({ type: eventType } as SessionEvent);
  }

  /**
   * Check if a manual session state machine can accept a specific event
   */
  canSendManualEvent(
    sessionId: string,
    eventType: ManualSessionEvent["type"]
  ): boolean {
    const snapshot = this.getManualSnapshot(sessionId);
    return snapshot.can({ type: eventType } as ManualSessionEvent);
  }

  /**
   * Check if an analysis session is in a specific state
   */
  isInState(sessionId: string, state: string): boolean {
    const snapshot = this.getSnapshot(sessionId);
    return snapshot.value === state;
  }

  /**
   * Check if a manual session is in a specific state
   */
  isManualInState(sessionId: string, state: string): boolean {
    const snapshot = this.getManualSnapshot(sessionId);
    return snapshot.value === state;
  }

  /**
   * Check if any session is in a specific state
   */
  isAnyInState(sessionId: string, state: string): boolean {
    const snapshot = this.getAnySnapshot(sessionId);
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
   * Get all active session IDs
   */
  getActiveSessionIds(): string[] {
    return Array.from(this.sessionMachines.keys());
  }

  /**
   * Get active session IDs by type
   */
  getActiveSessionIdsByType(type: SessionType): string[] {
    return Array.from(this.sessionMachines.entries())
      .filter(([, metadata]) => metadata.type === type)
      .map(([sessionId]) => sessionId);
  }

  /**
   * Get all analysis session IDs
   */
  getActiveAnalysisSessionIds(): string[] {
    return this.getActiveSessionIdsByType("analysis");
  }

  /**
   * Get all manual session IDs
   */
  getActiveManualSessionIds(): string[] {
    return this.getActiveSessionIdsByType("manual");
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
    const metadata = this.sessionMachines.get(sessionId);
    if (!metadata) {
      return false;
    }

    logger.info("Stopping and removing session state machine", {
      sessionId,
      type: metadata.type,
    });

    metadata.actor.stop();
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

    for (const [sessionId, metadata] of this.sessionMachines.entries()) {
      logger.debug("Stopping session machine", {
        sessionId,
        type: metadata.type,
      });
      metadata.actor.stop();
    }

    this.sessionMachines.clear();
  }

  /**
   * Get statistics about active sessions
   */
  getStats(): {
    totalSessions: number;
    analysisSessions: number;
    manualSessions: number;
    stateDistribution: Record<string, number>;
    stateDistributionByType: Record<SessionType, Record<string, number>>;
    failedSessions: number;
    completedSessions: number;
  } {
    const stateDistribution: Record<string, number> = {};
    const stateDistributionByType: Record<
      SessionType,
      Record<string, number>
    > = {
      analysis: {},
      manual: {},
    };
    let failedSessions = 0;
    let completedSessions = 0;
    let analysisSessions = 0;
    let manualSessions = 0;

    for (const [, metadata] of this.sessionMachines.entries()) {
      const state = metadata.actor.getSnapshot().value as string;
      const type = metadata.type;

      // Overall distribution
      stateDistribution[state] = (stateDistribution[state] || 0) + 1;

      // Distribution by type
      stateDistributionByType[type][state] =
        (stateDistributionByType[type][state] || 0) + 1;

      // Count by type
      if (type === "analysis") {
        analysisSessions++;
        if (state === "failed") {
          failedSessions++;
        } else if (state === "codeGenerated") {
          completedSessions++;
        }
      } else if (type === "manual") {
        manualSessions++;
        if (state === "failed") {
          failedSessions++;
        } else if (state === "stopped") {
          completedSessions++;
        }
      }
    }

    return {
      totalSessions: this.sessionMachines.size,
      analysisSessions,
      manualSessions,
      stateDistribution,
      stateDistributionByType,
      failedSessions,
      completedSessions,
    };
  }

  /**
   * Get detailed information about an analysis session
   */
  getSessionInfo(sessionId: string): {
    sessionId: string;
    type: "analysis";
    currentState: string;
    context: SessionContext;
    canProcessNext: boolean;
    canGenerateCode: boolean;
    isComplete: boolean;
    hasFailed: boolean;
    createdAt: Date;
    lastActivity: Date;
  } {
    const snapshot = this.getSnapshot(sessionId);
    const metadata = this.sessionMachines.get(sessionId)!;

    return {
      sessionId,
      type: "analysis",
      currentState: snapshot.value as string,
      context: snapshot.context,
      canProcessNext: snapshot.can({ type: "PROCESS_NEXT_NODE" }),
      canGenerateCode: snapshot.can({ type: "GENERATE_CODE" }),
      isComplete: this.isAnalysisComplete(sessionId),
      hasFailed: this.hasFailed(sessionId),
      createdAt: metadata.createdAt,
      lastActivity: metadata.lastActivity,
    };
  }

  /**
   * Get detailed information about a manual session
   */
  getManualSessionInfo(sessionId: string): {
    sessionId: string;
    type: "manual";
    currentState: string;
    context: ManualSessionContext;
    canStop: boolean;
    canCollectArtifacts: boolean;
    isActive: boolean;
    hasFailed: boolean;
    createdAt: Date;
    lastActivity: Date;
  } {
    const snapshot = this.getManualSnapshot(sessionId);
    const metadata = this.sessionMachines.get(sessionId)!;

    return {
      sessionId,
      type: "manual",
      currentState: snapshot.value as string,
      context: snapshot.context,
      canStop: snapshot.can({ type: "STOP_MANUAL_SESSION" }),
      canCollectArtifacts: snapshot.can({ type: "COLLECT_ARTIFACTS" }),
      isActive: snapshot.value === "active",
      hasFailed: snapshot.value === "failed",
      createdAt: metadata.createdAt,
      lastActivity: metadata.lastActivity,
    };
  }

  /**
   * Get detailed information about any session
   */
  getAnySessionInfo(sessionId: string): {
    sessionId: string;
    type: SessionType;
    currentState: string;
    context: AnySessionContext;
    createdAt: Date;
    lastActivity: Date;
  } {
    const { type } = this.getAnySessionMachine(sessionId);
    const snapshot = this.getAnySnapshot(sessionId);
    const metadata = this.sessionMachines.get(sessionId)!;

    return {
      sessionId,
      type,
      currentState: snapshot.value as string,
      context: snapshot.context,
      createdAt: metadata.createdAt,
      lastActivity: metadata.lastActivity,
    };
  }
}
