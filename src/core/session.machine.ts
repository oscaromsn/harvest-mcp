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
});

const SessionEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("START_SESSION"),
    harPath: z.string(),
    cookiePath: z.string().optional(),
    prompt: z.string(),
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
            inputVariables: {},
            logs: [],
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
        const tempSession = {
          id: context.sessionId,
          prompt: context.prompt,
          harData: context.harData,
          cookieData: context.cookieData,
          dagManager: context.dagManager,
          state: {
            actionUrl:
              context.activeWorkflowId && context.workflowGroups
                ? context.workflowGroups.get(context.activeWorkflowId)
                    ?.masterNodeId
                : undefined,
            masterNodeId:
              context.activeWorkflowId && context.workflowGroups
                ? context.workflowGroups.get(context.activeWorkflowId)
                    ?.masterNodeId
                : undefined,
            workflowGroups: context.workflowGroups || new Map(),
            activeWorkflowId: context.activeWorkflowId,
            inputVariables: context.inputVariables,
            authAnalysis: context.authAnalysis,
            logs: context.logs,
            toBeProcessedNodes: context.toBeProcessedNodes,
            inProcessNodeDynamicParts: context.inProcessNodeDynamicParts,
            isComplete: true,
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
    };
  },
  states: {
    initializing: {
      on: {
        START_SESSION: {
          target: "parsingHar",
          actions: "initializeContext",
        },
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
    },

    readyForCodeGen: {
      on: {
        GENERATE_CODE: {
          target: "generatingCode",
        },
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
    },

    codeGenerated: {
      type: "final",
    },

    failed: {
      type: "final",
      entry: "storeError",
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
  const workflow = context.activeWorkflowId
    ? context.workflowGroups.get(context.activeWorkflowId)
    : undefined;

  return {
    isComplete:
      unresolvedNodes.length === 0 && context.toBeProcessedNodes.length === 0,
    blockers:
      unresolvedNodes.length > 0 ? ["Unresolved dependencies in DAG"] : [],
    recommendations:
      context.toBeProcessedNodes.length > 0
        ? ["Continue processing remaining nodes"]
        : [],
    diagnostics: {
      hasMasterNode: !!workflow?.masterNodeId,
      dagComplete: unresolvedNodes.length === 0,
      queueEmpty: context.toBeProcessedNodes.length === 0,
      totalNodes,
      unresolvedNodes: unresolvedNodes.length,
      pendingInQueue: context.toBeProcessedNodes.length,
      hasActionUrl: !!workflow?.masterNodeId,
      authAnalysisComplete: !!context.authAnalysis,
      authReadiness: true, // Simplified for now
      authErrors: 0, // Simplified for now
      allNodesClassified: true, // Simplified for now
      nodesNeedingClassification: 0, // Simplified for now
      bootstrapAnalysisComplete: true, // Simplified for now
      sessionConstantsCount: 0, // Simplified for now
      unresolvedSessionConstants: 0, // Simplified for now
    },
  };
}
