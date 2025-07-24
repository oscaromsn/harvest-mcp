import { assign, fromPromise, setup } from "xstate";
import { z } from "zod";
import { findDependencies } from "../agents/DependencyAgent.js";
import { identifyDynamicParts } from "../agents/DynamicPartsAgent.js";
import { identifyInputVariables } from "../agents/InputVariablesAgent.js";
import { classifyParameters } from "../agents/ParameterClassificationAgent.js";
import {
  discoverWorkflows,
  getPrimaryWorkflow,
} from "../agents/WorkflowDiscoveryAgent.js";
import type {
  CompletionAnalysis,
  DAGManager,
  HarvestSession,
  LogEntry,
  RequestModel,
  WorkflowGroup,
} from "../types";
import { createComponentLogger } from "../utils/logger.js";
import { parseCookieFile } from "./CookieParser.js";
import { DAGManager as DAGManagerImpl } from "./DAGManager.js";
import { parseHARFile } from "./HARParser.js";

const logger = createComponentLogger("session-machine");

// ========== Zod Schemas for Type Safety ==========

/**
 * Note on z.any() usage:
 * Some external types (ParsedHARData, CookieData, DAGManager, etc.) are kept as z.any()
 * rather than z.unknown() because:
 * 1. They are complex interfaces used throughout the codebase
 * 2. XState requires type compatibility between schemas and actual usage
 * 3. Making them z.unknown() would break all consuming code with TS18046 errors
 * 4. These types are defined and validated in their respective modules
 * 5. The FSM context validation is primarily for XState internal consistency
 */

const SessionErrorSchema = z.object({
  message: z.string(),
  code: z.string(),
});

const SessionContextSchema = z.object({
  sessionId: z.string(),
  prompt: z.string(),
  harPath: z.string().optional(),
  cookiePath: z.string().optional(),
  harData: z.any().optional(), // ParsedHARData - external type, kept as z.any() for compatibility
  cookieData: z.any().optional(), // CookieData - external type, kept as z.any() for compatibility
  dagManager: z.any(), // DAGManager - external interface, kept as z.any() for compatibility
  workflowGroups: z.any(), // Map<string, WorkflowGroup> - complex type, kept as z.any() for compatibility
  activeWorkflowId: z.string().optional(),
  toBeProcessedNodes: z.array(z.string()),
  inProcessNodeId: z.string().optional(),
  inProcessNodeDynamicParts: z.array(z.string()),
  inputVariables: z.record(z.string()),
  logs: z.array(z.any()), // LogEntry[] - external type, kept as z.any() for compatibility
  generatedCode: z.string().optional(),
  authAnalysis: z.any().optional(), // AuthenticationAnalysis - external type, kept as z.any() for compatibility
  error: SessionErrorSchema.optional(),
  // Legacy compatibility properties migrated from SessionState
  actionUrl: z.string().optional(),
  masterNodeId: z.string().optional(),
  authReadiness: z.any().optional(), // AuthReadiness - external type, kept as z.any() for compatibility
  bootstrapAnalysis: z.any().optional(), // BootstrapAnalysis - external type, kept as z.any() for compatibility
});

const SessionEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("START_SESSION"),
    harPath: z.string(),
    cookiePath: z.string().optional(),
    prompt: z.string(),
    inputVariables: z.record(z.string()).optional(),
  }),
  z.object({
    type: z.literal("HAR_PARSED"),
    harData: z.any(), // ParsedHARData - external type, kept as z.any() for compatibility
    cookieData: z.any().optional(), // CookieData - external type, kept as z.any() for compatibility
  }),
  z.object({
    type: z.literal("WORKFLOWS_DISCOVERED"),
    workflowGroups: z.any(), // Map<string, WorkflowGroup> - complex type, kept as z.any() for compatibility
  }),
  z.object({
    type: z.literal("SELECT_WORKFLOW"),
    workflowId: z.string(),
  }),
  z.object({
    type: z.literal("PROCESS_NEXT_NODE"),
  }),
  z.object({
    type: z.literal("NODE_PROCESSED"),
    nodeId: z.string(),
    hasMoreNodes: z.boolean(),
  }),
  z.object({
    type: z.literal("PROCESSING_COMPLETE"),
  }),
  z.object({
    type: z.literal("GENERATE_CODE"),
  }),
  z.object({
    type: z.literal("CODE_GENERATED"),
    code: z.string(),
  }),
  z.object({
    type: z.literal("FAIL"),
    error: SessionErrorSchema,
  }),
  z.object({
    type: z.literal("RESET"),
  }),
  // New events for state management
  z.object({
    type: z.literal("SET_MASTER_NODE"),
    nodeId: z.string(),
    actionUrl: z.string().optional(),
  }),
  z.object({
    type: z.literal("ADD_LOG"),
    level: z.string(),
    message: z.string(),
    data: z.any().optional(),
  }),
  z.object({
    type: z.literal("UPDATE_AUTH_ANALYSIS"),
    authAnalysis: z.any(), // AuthenticationAnalysis - external type
  }),
  z.object({
    type: z.literal("SET_ACTION_URL"),
    actionUrl: z.string(),
  }),
  z.object({
    type: z.literal("UPDATE_AUTH_READINESS"),
    authReadiness: z.any(), // AuthReadiness - external type
  }),
  z.object({
    type: z.literal("UPDATE_BOOTSTRAP_ANALYSIS"),
    bootstrapAnalysis: z.any(), // BootstrapAnalysis - external type
  }),
  z.object({
    type: z.literal("UPDATE_PROCESSING_QUEUE"),
    nodeIds: z.array(z.string()),
  }),
]);

// Export inferred types from Zod schemas
export type SessionContext = z.infer<typeof SessionContextSchema>;
export type SessionEvent = z.infer<typeof SessionEventSchema>;
// SessionError type is internal and not used elsewhere

// Guards are now defined inline in the setup() function below

// Actions are now defined inline in the setup() function below

// Services are now defined inline in the setup() function below

// ========== XState Setup with Type Safety ==========

export const sessionMachine = setup({
  types: {
    context: {} as SessionContext,
    events: {} as SessionEvent,
  },
  guards: {
    hasWorkflows: ({ context }) => {
      return context.workflowGroups?.size > 0;
    },

    canSelectPrimaryWorkflow: ({ context }) => {
      return context.workflowGroups?.size > 0 && !context.activeWorkflowId;
    },

    hasNodesToProcess: ({ context }) => {
      return context.toBeProcessedNodes.length > 0;
    },

    isProcessingComplete: ({ context }) => {
      return (
        context.toBeProcessedNodes.length === 0 &&
        context.dagManager?.getUnresolvedNodes().length === 0
      );
    },
  },
  actions: {
    initializeContext: assign(({ event }) => {
      // Only validate custom events, not XState internal events
      if (!event.type.startsWith("xstate.")) {
        const startEvent = SessionEventSchema.parse(event);
        if (startEvent.type === "START_SESSION") {
          return {
            sessionId: crypto.randomUUID(),
            prompt: startEvent.prompt,
            harPath: startEvent.harPath,
            cookiePath: startEvent.cookiePath,
            dagManager: new DAGManagerImpl() as DAGManager,
            workflowGroups: new Map<string, WorkflowGroup>(),
            toBeProcessedNodes: [],
            inProcessNodeDynamicParts: [],
            inputVariables: startEvent.inputVariables || {},
            logs: [],
            // Initialize legacy compatibility properties
            actionUrl: undefined,
            masterNodeId: undefined,
            authReadiness: undefined,
            bootstrapAnalysis: undefined,
          };
        }
      }
      return {};
    }),

    storeHarData: assign(({ event }) => {
      // XState onDone event structure: { type: 'xstate.done.actor.parseHarFiles', output: { harData, cookieData } }
      if (event.type.startsWith("xstate.done.actor.parseHarFiles")) {
        const doneEvent = event as any; // XState internal event types
        if (doneEvent.output) {
          return {
            harData: doneEvent.output.harData,
            cookieData: doneEvent.output.cookieData,
          };
        }
      }
      return {};
    }),

    storeWorkflows: assign(({ event }) => {
      // XState onDone event structure: { type: 'xstate.done.actor.discoverWorkflows', output: { workflowGroups } }
      if (event.type.startsWith("xstate.done.actor.discoverWorkflows")) {
        const doneEvent = event as any; // XState internal event types
        if (doneEvent.output) {
          return {
            workflowGroups: doneEvent.output.workflowGroups,
          };
        }
      }
      return {};
    }),

    selectPrimaryWorkflow: assign(({ context }) => {
      if (!context.workflowGroups) {
        return {};
      }

      const primaryWorkflow = getPrimaryWorkflow(context.workflowGroups);
      logger.info("Auto-selecting primary workflow", {
        sessionId: context.sessionId,
        workflowId: primaryWorkflow?.id,
        workflowName: primaryWorkflow?.name,
      });

      const update: Partial<SessionContext> = {};
      if (primaryWorkflow?.id) {
        update.activeWorkflowId = primaryWorkflow.id;
      }
      return update;
    }),

    selectWorkflow: assign(({ event }) => {
      // Only validate custom events, not XState internal events
      if (!event.type.startsWith("xstate.")) {
        const selectEvent = SessionEventSchema.parse(event);
        if (selectEvent.type === "SELECT_WORKFLOW") {
          return {
            activeWorkflowId: selectEvent.workflowId,
          };
        }
      }
      return {};
    }),

    populateProcessingQueue: assign(({ context }) => {
      if (
        !context.harData ||
        !context.activeWorkflowId ||
        !context.workflowGroups
      ) {
        return { toBeProcessedNodes: [] };
      }

      const workflow = context.workflowGroups.get(context.activeWorkflowId);
      if (!workflow) {
        return { toBeProcessedNodes: [] };
      }

      // Add all requests to DAG and populate processing queue
      const nodeIds: string[] = [];
      for (const request of context.harData.requests) {
        const nodeId = context.dagManager.addNode("curl", {
          key: request,
          value: request.response || null,
        });
        nodeIds.push(nodeId);
      }

      logger.info("Populated processing queue", {
        sessionId: context.sessionId,
        nodeCount: nodeIds.length,
        workflowId: context.activeWorkflowId,
      });

      return { toBeProcessedNodes: nodeIds };
    }),

    processNextNode: assign(({ context }) => {
      if (context.toBeProcessedNodes.length === 0) {
        return {};
      }

      const nodeId = context.toBeProcessedNodes[0];
      logger.debug("Processing next node", {
        sessionId: context.sessionId,
        nodeId,
        remaining: context.toBeProcessedNodes.length - 1,
      });

      const update: Partial<SessionContext> = {
        toBeProcessedNodes: context.toBeProcessedNodes.slice(1),
      };
      if (nodeId) {
        update.inProcessNodeId = nodeId;
      }
      return update;
    }),

    completeNodeProcessing: assign(() => ({
      inProcessNodeId: undefined,
      inProcessNodeDynamicParts: [],
    })),

    storeGeneratedCode: assign(({ event }) => {
      // XState onDone event structure: { type: 'xstate.done.actor.generateCode', output: { code } }
      if (event.type.startsWith("xstate.done.actor.generateCode")) {
        const doneEvent = event as any; // XState internal event types
        if (doneEvent.output) {
          return {
            generatedCode: doneEvent.output.code,
          };
        }
      }
      return {};
    }),

    storeError: assign(({ event }) => {
      // Only validate custom events, not XState internal events
      if (!event.type.startsWith("xstate.")) {
        const failEvent = SessionEventSchema.parse(event);
        if (failEvent.type === "FAIL") {
          return {
            error: failEvent.error,
          };
        }
      }
      return {};
    }),

    addLog: assign(({ context, event }) => {
      const logEntry: LogEntry = {
        timestamp: new Date(),
        level: "info",
        message: `State transition: ${event.type}`,
        data: event,
      };

      return {
        logs: [...context.logs, logEntry],
      };
    }),

    // New actions for state management
    setMasterNode: assign(({ event }) => {
      if (!event.type.startsWith("xstate.")) {
        const parsedEvent = SessionEventSchema.parse(event);
        if (parsedEvent.type === "SET_MASTER_NODE") {
          return {
            masterNodeId: parsedEvent.nodeId,
            actionUrl: parsedEvent.actionUrl,
          };
        }
      }
      return {};
    }),

    addLogEntry: assign(({ context, event }) => {
      if (!event.type.startsWith("xstate.")) {
        const parsedEvent = SessionEventSchema.parse(event);
        if (parsedEvent.type === "ADD_LOG") {
          const logEntry: LogEntry = {
            timestamp: new Date(),
            level: parsedEvent.level as LogEntry["level"],
            message: parsedEvent.message,
            data: parsedEvent.data,
          };

          // Keep only last 1000 log entries to prevent memory bloat
          const updatedLogs = [...context.logs, logEntry];
          if (updatedLogs.length > 1000) {
            updatedLogs.splice(0, updatedLogs.length - 1000);
          }

          return {
            logs: updatedLogs,
          };
        }
      }
      return {};
    }),

    updateAuthAnalysis: assign(({ event }) => {
      if (!event.type.startsWith("xstate.")) {
        const parsedEvent = SessionEventSchema.parse(event);
        if (parsedEvent.type === "UPDATE_AUTH_ANALYSIS") {
          return {
            authAnalysis: parsedEvent.authAnalysis,
          };
        }
      }
      return {};
    }),

    setActionUrl: assign(({ event }) => {
      if (!event.type.startsWith("xstate.")) {
        const parsedEvent = SessionEventSchema.parse(event);
        if (parsedEvent.type === "SET_ACTION_URL") {
          return {
            actionUrl: parsedEvent.actionUrl,
          };
        }
      }
      return {};
    }),

    updateAuthReadiness: assign(({ event }) => {
      if (!event.type.startsWith("xstate.")) {
        const parsedEvent = SessionEventSchema.parse(event);
        if (parsedEvent.type === "UPDATE_AUTH_READINESS") {
          return {
            authReadiness: parsedEvent.authReadiness,
          };
        }
      }
      return {};
    }),

    updateBootstrapAnalysis: assign(({ event }) => {
      if (!event.type.startsWith("xstate.")) {
        const parsedEvent = SessionEventSchema.parse(event);
        if (parsedEvent.type === "UPDATE_BOOTSTRAP_ANALYSIS") {
          return {
            bootstrapAnalysis: parsedEvent.bootstrapAnalysis,
          };
        }
      }
      return {};
    }),

    updateProcessingQueue: assign(({ event }) => {
      if (!event.type.startsWith("xstate.")) {
        const parsedEvent = SessionEventSchema.parse(event);
        if (parsedEvent.type === "UPDATE_PROCESSING_QUEUE") {
          return {
            toBeProcessedNodes: parsedEvent.nodeIds,
          };
        }
      }
      return {};
    }),
  },
  actors: {
    parseHarFiles: fromPromise(
      async ({
        input,
      }: {
        input: { harPath: string; cookiePath?: string };
      }) => {
        logger.info("Parsing HAR and cookie files", {
          harPath: input.harPath,
          cookiePath: input.cookiePath,
        });

        const harData = await parseHARFile(input.harPath);
        const cookieData = input.cookiePath
          ? await parseCookieFile(input.cookiePath)
          : undefined;

        return { harData, cookieData };
      }
    ),

    discoverWorkflows: fromPromise(
      async ({ input }: { input: { session: Partial<HarvestSession> } }) => {
        logger.info("Discovering workflows", { sessionId: input.session.id });

        if (!input.session.harData) {
          throw new Error("HAR data is required for workflow discovery");
        }

        // Create a minimal session object for the workflow discovery agent
        const tempSession = {
          ...input.session,
          harData: input.session.harData,
        } as HarvestSession;

        const workflowGroups = await discoverWorkflows(tempSession);
        return { workflowGroups };
      }
    ),

    processNode: fromPromise(
      async ({
        input,
      }: {
        input: {
          context: SessionContext;
          nodeId: string;
        };
      }) => {
        const { context, nodeId } = input;
        logger.debug("Processing node", {
          sessionId: context.sessionId,
          nodeId,
        });

        const node = context.dagManager.getNode(nodeId);
        if (!node) {
          throw new Error(`Node ${nodeId} not found in DAG`);
        }

        // Get the request from the node - safe type assertion
        const nodeContent = node as { content: { key: RequestModel } };
        const request = nodeContent.content.key;

        // Run agent analysis on the request
        const curlCommand = request.toCurlCommand();
        const dynamicPartsResult = await identifyDynamicParts(curlCommand);
        const dynamicParts = Array.isArray(dynamicPartsResult)
          ? dynamicPartsResult
          : (dynamicPartsResult as { dynamic_parts?: string[] })
              ?.dynamic_parts || [];

        if (!context.harData) {
          throw new Error("HAR data is required for node processing");
        }

        // Create a temporary session for agent calls
        const tempSession = {
          id: context.sessionId,
          harData: context.harData,
          dagManager: context.dagManager,
          cookieData: context.cookieData,
        } as HarvestSession;

        // Run other agents
        const [dependencies, classifiedParams, inputVarsResult] =
          await Promise.all([
            findDependencies(
              dynamicParts,
              context.harData,
              context.cookieData || {}
            ),
            classifyParameters(request, tempSession),
            identifyInputVariables(curlCommand, {}),
          ]);

        // Update the node with analysis results
        context.dagManager.updateNode(nodeId, {
          dynamicParts: dynamicParts,
          classifiedParameters: classifiedParams,
          inputVariables: inputVarsResult.identifiedVariables,
        });

        // Add dependencies to DAG
        for (const dep of dependencies.requestDependencies) {
          const depNodeId = context.dagManager.findNodeByRequest(
            dep.sourceRequest
          );
          if (depNodeId) {
            context.dagManager.addEdge(depNodeId, nodeId);
          }
        }

        for (const dep of dependencies.cookieDependencies) {
          const cookieNodeId = context.dagManager.addNode("cookie", {
            key: dep.cookieKey,
            value: context.cookieData?.[dep.cookieKey]?.value || "",
          });
          context.dagManager.addEdge(cookieNodeId, nodeId);
        }

        const hasMoreNodes = context.toBeProcessedNodes.length > 0;
        return { nodeId, hasMoreNodes };
      }
    ),

    generateCode: fromPromise(
      async ({ input }: { input: { context: SessionContext } }) => {
        const { context } = input;
        logger.info("Generating wrapper code", {
          sessionId: context.sessionId,
        });

        if (!context.harData) {
          throw new Error("HAR data is required for code generation");
        }

        // Import the CodeGenerator here to avoid circular dependencies
        const { generateWrapperScript } = await import("./CodeGenerator.js");

        // Create a temporary session for code generation
        // Since HarvestSession now uses FSM context getters, we need to create a mock FSM
        const mockFsm = {
          getSnapshot: () => ({
            context: context,
            value: "codeGenerated" as const,
          }),
        };

        const tempSession = {
          id: context.sessionId,
          fsm: mockFsm as any,
          createdAt: new Date(),
          lastActivity: new Date(),

          // FSM context getters - match the pattern from SessionManager
          get prompt() {
            return context.prompt;
          },
          get harData() {
            return context.harData as any;
          },
          get cookieData() {
            return context.cookieData;
          },
          get dagManager() {
            return context.dagManager;
          },
          get workflowGroups() {
            return context.workflowGroups || new Map();
          },
          get selectedWorkflowId() {
            return context.activeWorkflowId;
          },
          get logs() {
            return context.logs;
          },
          get generatedCode() {
            return context.generatedCode;
          },
          get authAnalysis() {
            return context.authAnalysis;
          },
          get actionUrl() {
            return context.actionUrl;
          },
          get masterNodeId() {
            return context.masterNodeId;
          },
          get inProcessNodeId() {
            return context.inProcessNodeId;
          },
          get toBeProcessedNodes() {
            return context.toBeProcessedNodes;
          },
          get inProcessNodeDynamicParts() {
            return context.inProcessNodeDynamicParts;
          },
          get inputVariables() {
            return context.inputVariables;
          },
          get isComplete() {
            return true;
          },
          get authReadiness() {
            return context.authReadiness;
          },
          get bootstrapAnalysis() {
            return context.bootstrapAnalysis;
          },
        } as HarvestSession;

        const code = await generateWrapperScript(tempSession);
        return { code };
      }
    ),
  },
}).createMachine({
  id: "harvestSession",
  initial: "initializing",
  context: ({ input }) => {
    const inputData = input as {
      sessionId?: string;
      prompt?: string;
      harPath?: string;
      cookiePath?: string;
    };
    return {
      sessionId: inputData?.sessionId || crypto.randomUUID(),
      prompt: inputData?.prompt || "",
      harPath: inputData?.harPath,
      cookiePath: inputData?.cookiePath,
      dagManager: new DAGManagerImpl() as DAGManager,
      workflowGroups: new Map(),
      activeWorkflowId: undefined,
      toBeProcessedNodes: [],
      inProcessNodeId: undefined,
      inProcessNodeDynamicParts: [],
      inputVariables: {},
      logs: [],
      harData: undefined,
      cookieData: undefined,
      generatedCode: undefined,
      authAnalysis: undefined,
      error: undefined,
      // Initialize new legacy compatibility properties
      actionUrl: undefined,
      masterNodeId: undefined,
      authReadiness: undefined,
      bootstrapAnalysis: undefined,
    };
  },
  states: {
    initializing: {
      on: {
        START_SESSION: {
          target: "parsingHar",
          actions: "initializeContext",
        },
        // Global state management events
        SET_MASTER_NODE: { actions: "setMasterNode" },
        ADD_LOG: { actions: "addLogEntry" },
        UPDATE_AUTH_ANALYSIS: { actions: "updateAuthAnalysis" },
        SET_ACTION_URL: { actions: "setActionUrl" },
        UPDATE_AUTH_READINESS: { actions: "updateAuthReadiness" },
        UPDATE_BOOTSTRAP_ANALYSIS: { actions: "updateBootstrapAnalysis" },
        UPDATE_PROCESSING_QUEUE: { actions: "updateProcessingQueue" },
      },
    },

    parsingHar: {
      invoke: {
        id: "parseHarFiles",
        src: "parseHarFiles",
        input: ({ context }) => {
          const input: { harPath: string; cookiePath?: string } = {
            harPath: context.harPath || "",
          };
          if (context.cookiePath) {
            input.cookiePath = context.cookiePath;
          }
          return input;
        },
        onDone: {
          target: "discoveringWorkflows",
          actions: ["storeHarData"],
        },
        onError: {
          target: "failed",
          actions: assign({
            error: ({ event }) => ({
              message: `HAR parsing failed: ${
                event.error instanceof Error
                  ? event.error.message
                  : "Unknown error"
              }`,
              code: "HAR_PARSING_FAILED",
            }),
          }),
        },
      },
      on: {
        // Global state management events
        SET_MASTER_NODE: { actions: "setMasterNode" },
        ADD_LOG: { actions: "addLogEntry" },
        UPDATE_AUTH_ANALYSIS: { actions: "updateAuthAnalysis" },
        SET_ACTION_URL: { actions: "setActionUrl" },
        UPDATE_AUTH_READINESS: { actions: "updateAuthReadiness" },
        UPDATE_BOOTSTRAP_ANALYSIS: { actions: "updateBootstrapAnalysis" },
        UPDATE_PROCESSING_QUEUE: { actions: "updateProcessingQueue" },
      },
    },

    discoveringWorkflows: {
      invoke: {
        id: "discoverWorkflows",
        src: "discoverWorkflows",
        input: ({ context }) => ({
          session: {
            id: context.sessionId,
            prompt: context.prompt,
            harData: context.harData,
            cookieData: context.cookieData,
          },
        }),
        onDone: {
          target: "awaitingWorkflowSelection",
          actions: ["storeWorkflows"],
        },
        onError: {
          target: "failed",
          actions: assign({
            error: ({ event }) => ({
              message: `Workflow discovery failed: ${
                event.error instanceof Error
                  ? event.error.message
                  : "Unknown error"
              }`,
              code: "WORKFLOW_DISCOVERY_FAILED",
            }),
          }),
        },
      },
      on: {
        // Global state management events
        SET_MASTER_NODE: { actions: "setMasterNode" },
        ADD_LOG: { actions: "addLogEntry" },
        UPDATE_AUTH_ANALYSIS: { actions: "updateAuthAnalysis" },
        SET_ACTION_URL: { actions: "setActionUrl" },
        UPDATE_AUTH_READINESS: { actions: "updateAuthReadiness" },
        UPDATE_BOOTSTRAP_ANALYSIS: { actions: "updateBootstrapAnalysis" },
        UPDATE_PROCESSING_QUEUE: { actions: "updateProcessingQueue" },
      },
    },

    awaitingWorkflowSelection: {
      always: [
        {
          target: "processingDependencies",
          guard: "canSelectPrimaryWorkflow",
          actions: ["selectPrimaryWorkflow", "populateProcessingQueue"],
        },
      ],
      on: {
        SELECT_WORKFLOW: {
          target: "processingDependencies",
          actions: ["selectWorkflow", "populateProcessingQueue"],
        },
        // Global state management events
        SET_MASTER_NODE: { actions: "setMasterNode" },
        ADD_LOG: { actions: "addLogEntry" },
        UPDATE_AUTH_ANALYSIS: { actions: "updateAuthAnalysis" },
        SET_ACTION_URL: { actions: "setActionUrl" },
        UPDATE_AUTH_READINESS: { actions: "updateAuthReadiness" },
        UPDATE_BOOTSTRAP_ANALYSIS: { actions: "updateBootstrapAnalysis" },
        UPDATE_PROCESSING_QUEUE: { actions: "updateProcessingQueue" },
      },
    },

    processingDependencies: {
      always: [
        {
          target: "readyForCodeGen",
          guard: "isProcessingComplete",
        },
      ],
      on: {
        PROCESS_NEXT_NODE: [
          {
            target: "processingNode",
            guard: "hasNodesToProcess",
            actions: "processNextNode",
          },
          {
            target: "readyForCodeGen",
          },
        ],
        // Global state management events
        SET_MASTER_NODE: { actions: "setMasterNode" },
        ADD_LOG: { actions: "addLogEntry" },
        UPDATE_AUTH_ANALYSIS: { actions: "updateAuthAnalysis" },
        SET_ACTION_URL: { actions: "setActionUrl" },
        UPDATE_AUTH_READINESS: { actions: "updateAuthReadiness" },
        UPDATE_BOOTSTRAP_ANALYSIS: { actions: "updateBootstrapAnalysis" },
        UPDATE_PROCESSING_QUEUE: { actions: "updateProcessingQueue" },
      },
    },

    processingNode: {
      invoke: {
        id: "processNode",
        src: "processNode",
        input: ({ context }) => ({
          context,
          nodeId: context.inProcessNodeId || "",
        }),
        onDone: {
          target: "processingDependencies",
          actions: ["completeNodeProcessing"],
        },
        onError: {
          target: "failed",
          actions: assign({
            error: ({ event }) => ({
              message: `Node processing failed: ${
                event.error instanceof Error
                  ? event.error.message
                  : "Unknown error"
              }`,
              code: "NODE_PROCESSING_FAILED",
            }),
          }),
        },
      },
      on: {
        // Global state management events
        SET_MASTER_NODE: { actions: "setMasterNode" },
        ADD_LOG: { actions: "addLogEntry" },
        UPDATE_AUTH_ANALYSIS: { actions: "updateAuthAnalysis" },
        SET_ACTION_URL: { actions: "setActionUrl" },
        UPDATE_AUTH_READINESS: { actions: "updateAuthReadiness" },
        UPDATE_BOOTSTRAP_ANALYSIS: { actions: "updateBootstrapAnalysis" },
        UPDATE_PROCESSING_QUEUE: { actions: "updateProcessingQueue" },
      },
    },

    readyForCodeGen: {
      on: {
        GENERATE_CODE: {
          target: "generatingCode",
        },
        // Global state management events
        SET_MASTER_NODE: { actions: "setMasterNode" },
        ADD_LOG: { actions: "addLogEntry" },
        UPDATE_AUTH_ANALYSIS: { actions: "updateAuthAnalysis" },
        SET_ACTION_URL: { actions: "setActionUrl" },
        UPDATE_AUTH_READINESS: { actions: "updateAuthReadiness" },
        UPDATE_BOOTSTRAP_ANALYSIS: { actions: "updateBootstrapAnalysis" },
        UPDATE_PROCESSING_QUEUE: { actions: "updateProcessingQueue" },
      },
    },

    generatingCode: {
      invoke: {
        id: "generateCode",
        src: "generateCode",
        input: ({ context }) => ({ context }),
        onDone: {
          target: "codeGenerated",
          actions: "storeGeneratedCode",
        },
        onError: {
          target: "failed",
          actions: assign({
            error: ({ event }) => ({
              message: `Code generation failed: ${
                event.error instanceof Error
                  ? event.error.message
                  : "Unknown error"
              }`,
              code: "CODE_GENERATION_FAILED",
            }),
          }),
        },
      },
      on: {
        // Global state management events
        SET_MASTER_NODE: { actions: "setMasterNode" },
        ADD_LOG: { actions: "addLogEntry" },
        UPDATE_AUTH_ANALYSIS: { actions: "updateAuthAnalysis" },
        SET_ACTION_URL: { actions: "setActionUrl" },
        UPDATE_AUTH_READINESS: { actions: "updateAuthReadiness" },
        UPDATE_BOOTSTRAP_ANALYSIS: { actions: "updateBootstrapAnalysis" },
        UPDATE_PROCESSING_QUEUE: { actions: "updateProcessingQueue" },
      },
    },

    codeGenerated: {
      type: "final",
      on: {
        // Global state management events (even in final states for completeness)
        SET_MASTER_NODE: { actions: "setMasterNode" },
        ADD_LOG: { actions: "addLogEntry" },
        UPDATE_AUTH_ANALYSIS: { actions: "updateAuthAnalysis" },
        SET_ACTION_URL: { actions: "setActionUrl" },
        UPDATE_AUTH_READINESS: { actions: "updateAuthReadiness" },
        UPDATE_BOOTSTRAP_ANALYSIS: { actions: "updateBootstrapAnalysis" },
      },
    },

    failed: {
      type: "final",
      entry: "storeError",
      on: {
        // Global state management events (even in final states for completeness)
        SET_MASTER_NODE: { actions: "setMasterNode" },
        ADD_LOG: { actions: "addLogEntry" },
        UPDATE_AUTH_ANALYSIS: { actions: "updateAuthAnalysis" },
        SET_ACTION_URL: { actions: "setActionUrl" },
        UPDATE_AUTH_READINESS: { actions: "updateAuthReadiness" },
        UPDATE_BOOTSTRAP_ANALYSIS: { actions: "updateBootstrapAnalysis" },
      },
    },
  },
});

// ========== Helper Functions ==========

/**
 * Create a completion analysis from the current session state machine context
 */
export function createCompletionAnalysis(
  context: SessionContext
): CompletionAnalysis {
  const unresolvedNodes = context.dagManager.getUnresolvedNodes();
  const totalNodes = context.dagManager.getNodeCount();

  const blockers: string[] = [];
  const recommendations: string[] = [];

  // Check for unresolved dependencies
  if (unresolvedNodes.length > 0) {
    blockers.push("Unresolved dependencies in DAG");
  }

  // Check for master node existence and recover actionUrl if needed
  if (context.masterNodeId) {
    const masterNode = context.dagManager.getNode(context.masterNodeId);
    if (!masterNode) {
      // Only add blocker if actionUrl is also not set
      // If actionUrl is explicitly set, we can proceed even without the master node in DAG
      if (!context.actionUrl || context.actionUrl.trim() === "") {
        blockers.push("Master node ID is set but node does not exist in DAG");
      }
    } else if (!context.actionUrl && masterNode.content?.key?.url) {
      // Recovery logic: if actionUrl is missing but master node has a URL, recover it
      // Note: This modifies the context during analysis, which is a side effect
      // In a pure functional approach, this would be handled differently
      context.actionUrl = masterNode.content.key.url;
    }
  }

  // Add recommendations based on current state - match legacy SessionManager logic
  // For master node identification, only consider session context, not workflow
  const hasMasterNode = !!context.masterNodeId;
  const hasActionUrl = !!(context.actionUrl && context.actionUrl.trim() !== "");
  const hasUnresolvedNodes = unresolvedNodes.length > 0;
  const hasQueuedNodes = context.toBeProcessedNodes.length > 0;

  if (!hasMasterNode || !hasActionUrl) {
    recommendations.push(
      "Run 'analysis_start_primary_workflow' to identify the target action URL"
    );
  } else if (hasUnresolvedNodes || hasQueuedNodes) {
    recommendations.push(
      "Continue processing with 'analysis_process_next_node' until queue is empty"
    );
  } else {
    recommendations.push("All dependencies resolved. Ready to generate code.");
  }

  // Add specific blocker-based recommendations
  if (!hasMasterNode) {
    blockers.push("Master node has not been identified");
  }
  if (!hasActionUrl) {
    blockers.push("Target action URL has not been identified");
  }
  if (hasQueuedNodes) {
    blockers.push(
      `${context.toBeProcessedNodes.length} nodes are still pending in the processing queue`
    );
  }

  return {
    isComplete:
      hasMasterNode &&
      hasActionUrl &&
      unresolvedNodes.length === 0 &&
      context.toBeProcessedNodes.length === 0,
    blockers,
    recommendations,
    diagnostics: {
      hasMasterNode: !!context.masterNodeId,
      dagComplete: unresolvedNodes.length === 0,
      queueEmpty: context.toBeProcessedNodes.length === 0,
      totalNodes,
      unresolvedNodes: unresolvedNodes.length,
      pendingInQueue: context.toBeProcessedNodes.length,
      hasActionUrl: !!(context.actionUrl && context.actionUrl.trim() !== ""),
      authAnalysisComplete: !!context.authAnalysis,
      authReadiness: !!context.authReadiness,
      authErrors: 0, // TODO: Extract from authAnalysis when available
      allNodesClassified: true, // TODO: Implement node classification tracking
      nodesNeedingClassification: 0, // TODO: Implement node classification tracking
      bootstrapAnalysisComplete: !!context.bootstrapAnalysis,
      sessionConstantsCount: 0, // TODO: Implement session constants tracking
      unresolvedSessionConstants: 0, // TODO: Implement session constants tracking
    },
  };
}
