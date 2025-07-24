import { assign, fromPromise, setup } from "xstate";
import { z } from "zod";
import type { Artifact, LogEntry, SessionConfig } from "../types/index.js";
import { createComponentLogger } from "../utils/logger.js";

const logger = createComponentLogger("manual-session-machine");

// ========== Zod Schemas for Manual Session FSM ==========

const ManualSessionErrorSchema = z.object({
  message: z.string(),
  code: z.string(),
});

/**
 * Manual session context schema
 */
const ManualSessionContextSchema = z.object({
  sessionId: z.string(),
  sessionType: z.literal("manual"),

  // Browser objects (stored as z.any() for external types)
  page: z.any().optional(), // Page - Playwright type
  context: z.any().optional(), // BrowserContext - Playwright type
  browser: z.any().optional(), // Browser - Playwright type

  // Configuration and metadata
  config: z.any(), // SessionConfig - complex external type
  startTime: z.number(),
  outputDir: z.string(),

  // Artifact collection
  artifacts: z.array(z.any()), // Artifact[] - external type
  artifactCollector: z.any().optional(), // ArtifactCollector - external type

  // Session metadata
  metadata: z.object({
    currentUrl: z.string().optional(),
    pageTitle: z.string().optional(),
    sessionDuration: z.number().optional(),
    networkRequestCount: z.number().optional(),
  }),

  // Logging
  logs: z.array(z.any()), // LogEntry[] - external type

  // Error handling
  error: ManualSessionErrorSchema.optional(),
});

/**
 * Manual session events schema
 */
const ManualSessionEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("START_MANUAL_SESSION"),
    config: z.any(), // SessionConfig
  }),
  z.object({
    type: z.literal("BROWSER_LAUNCHED"),
    page: z.any(), // Page
    context: z.any(), // BrowserContext
    browser: z.any(), // Browser
    outputDir: z.string(),
    artifactCollector: z.any(), // ArtifactCollector
  }),
  z.object({
    type: z.literal("NAVIGATE"),
    url: z.string(),
  }),
  z.object({
    type: z.literal("NAVIGATION_COMPLETE"),
    currentUrl: z.string(),
    pageTitle: z.string(),
  }),
  z.object({
    type: z.literal("UPDATE_METADATA"),
    metadata: z.object({
      currentUrl: z.string().optional(),
      pageTitle: z.string().optional(),
      sessionDuration: z.number().optional(),
      networkRequestCount: z.number().optional(),
    }),
  }),
  z.object({
    type: z.literal("COLLECT_ARTIFACTS"),
    artifactTypes: z.array(z.string()).optional(),
    takeScreenshot: z.boolean().optional(),
  }),
  z.object({
    type: z.literal("ARTIFACTS_COLLECTED"),
    artifacts: z.array(z.any()), // Artifact[]
  }),
  z.object({
    type: z.literal("STOP_MANUAL_SESSION"),
    reason: z.string().optional(),
  }),
  z.object({
    type: z.literal("CLEANUP_COMPLETE"),
  }),
  z.object({
    type: z.literal("FAIL"),
    error: ManualSessionErrorSchema,
  }),
  z.object({
    type: z.literal("ADD_LOG"),
    level: z.string(),
    message: z.string(),
    data: z.any().optional(),
  }),
]);

// Export inferred types
export type ManualSessionContext = z.infer<typeof ManualSessionContextSchema>;
export type ManualSessionEvent = z.infer<typeof ManualSessionEventSchema>;

// ========== XState Manual Session Machine ==========

export const manualSessionMachine = setup({
  types: {
    context: {} as ManualSessionContext,
    events: {} as ManualSessionEvent,
  },
  guards: {
    hasValidBrowserSession: ({ context }) => {
      return !!(context.page && context.context && context.browser);
    },

    shouldTakeScreenshot: ({ event }) => {
      return (
        event.type === "COLLECT_ARTIFACTS" && event.takeScreenshot !== false
      );
    },
  },
  actions: {
    initializeContext: assign(({ event }) => {
      if (!event.type.startsWith("xstate.")) {
        const startEvent = ManualSessionEventSchema.parse(event);
        if (startEvent.type === "START_MANUAL_SESSION") {
          return {
            sessionId: crypto.randomUUID(),
            sessionType: "manual" as const,
            config: startEvent.config,
            startTime: Date.now(),
            outputDir: "",
            artifacts: [],
            metadata: {
              networkRequestCount: 0,
            },
            logs: [],
          };
        }
      }
      return {};
    }),

    storeBrowserSession: assign(({ event }) => {
      if (!event.type.startsWith("xstate.")) {
        const browserEvent = ManualSessionEventSchema.parse(event);
        if (browserEvent.type === "BROWSER_LAUNCHED") {
          return {
            page: browserEvent.page,
            context: browserEvent.context,
            browser: browserEvent.browser,
            outputDir: browserEvent.outputDir,
            artifactCollector: browserEvent.artifactCollector,
          };
        }
      }
      return {};
    }),

    updateNavigation: assign(({ event }) => {
      if (!event.type.startsWith("xstate.")) {
        const navEvent = ManualSessionEventSchema.parse(event);
        if (navEvent.type === "NAVIGATION_COMPLETE") {
          return {
            metadata: {
              currentUrl: navEvent.currentUrl,
              pageTitle: navEvent.pageTitle,
              sessionDuration: Date.now() - Date.now(), // Will be calculated properly
              networkRequestCount: 0, // Will be updated by artifact collector
            },
          };
        }
      }
      return {};
    }),

    updateMetadata: assign(({ context, event }) => {
      if (!event.type.startsWith("xstate.")) {
        const metaEvent = ManualSessionEventSchema.parse(event);
        if (metaEvent.type === "UPDATE_METADATA") {
          return {
            metadata: {
              ...context.metadata,
              ...metaEvent.metadata,
            },
          };
        }
      }
      return {};
    }),

    storeArtifacts: assign(({ event }) => {
      if (!event.type.startsWith("xstate.")) {
        const artifactEvent = ManualSessionEventSchema.parse(event);
        if (artifactEvent.type === "ARTIFACTS_COLLECTED") {
          return {
            artifacts: artifactEvent.artifacts,
          };
        }
      }
      return {};
    }),

    addLogEntry: assign(({ context, event }) => {
      if (!event.type.startsWith("xstate.")) {
        const logEvent = ManualSessionEventSchema.parse(event);
        if (logEvent.type === "ADD_LOG") {
          const logEntry: LogEntry = {
            timestamp: new Date(),
            level: logEvent.level as LogEntry["level"],
            message: logEvent.message,
            data: logEvent.data,
          };

          // Keep only last 500 log entries for memory efficiency
          const updatedLogs = [...context.logs, logEntry];
          if (updatedLogs.length > 500) {
            updatedLogs.splice(0, updatedLogs.length - 500);
          }

          return {
            logs: updatedLogs,
          };
        }
      }
      return {};
    }),

    storeError: assign(({ event }) => {
      if (!event.type.startsWith("xstate.")) {
        const failEvent = ManualSessionEventSchema.parse(event);
        if (failEvent.type === "FAIL") {
          return {
            error: failEvent.error,
          };
        }
      }
      return {};
    }),

    logStateTransition: assign(({ context, event }) => {
      const logEntry: LogEntry = {
        timestamp: new Date(),
        level: "debug",
        message: `Manual session state transition: ${event.type}`,
        data: { sessionId: context.sessionId, event },
      };

      return {
        logs: [...context.logs.slice(-499), logEntry], // Keep last 500 entries
      };
    }),
  },
  actors: {
    launchBrowser: fromPromise(
      async ({
        input,
      }: {
        input: { config: SessionConfig; sessionId: string };
      }) => {
        logger.info("Launching browser for manual session", {
          sessionId: input.sessionId,
        });

        // Import browser factory dynamically to avoid circular dependencies
        const { AgentFactory } = await import("../browser/AgentFactory.js");
        const { ArtifactCollector } = await import(
          "../browser/ArtifactCollector.js"
        );
        const { getSafeOutputDirectory } = await import(
          "../utils/pathUtils.js"
        );
        const { tmpdir } = await import("node:os");
        const { join } = await import("node:path");

        // Create safe output directory
        const defaultOutputDir = join(tmpdir(), "harvest-manual-sessions");
        const outputDir = await getSafeOutputDirectory(
          input.config.artifactConfig?.outputDir,
          defaultOutputDir,
          input.sessionId,
          true // Enable client accessibility
        );

        // Create browser session
        const agentFactory = new AgentFactory();
        const browserConfig: any = {
          url: input.config.url,
          browserOptions: input.config.browserOptions,
        };
        const { page, context, browser } =
          await agentFactory.createBrowserSession(browserConfig);

        // Create artifact collector
        const artifactCollector = new ArtifactCollector(true);

        // Start network tracking if enabled
        if (input.config.artifactConfig?.enabled !== false) {
          artifactCollector.startNetworkTracking(page);
        }

        return {
          page,
          context,
          browser,
          outputDir,
          artifactCollector,
        };
      }
    ),

    collectArtifacts: fromPromise(
      async ({
        input,
      }: {
        input: {
          context: ManualSessionContext;
          artifactTypes?: string[];
          takeScreenshot?: boolean;
        };
      }) => {
        const { context, takeScreenshot = true } = input;
        logger.info("Collecting artifacts for manual session", {
          sessionId: context.sessionId,
        });

        if (!context.artifactCollector || !context.page) {
          throw new Error(
            "Browser session not properly initialized for artifact collection"
          );
        }

        const artifacts: Artifact[] = [];

        // Collect HAR if enabled
        if (context.config.artifactConfig?.saveHar !== false) {
          const harArtifact = await context.artifactCollector.saveHar(
            context.outputDir,
            `session-${context.sessionId}`
          );
          if (harArtifact) artifacts.push(harArtifact);
        }

        // Collect cookies if enabled
        if (context.config.artifactConfig?.saveCookies !== false) {
          const cookieArtifact = await context.artifactCollector.saveCookies(
            context.context,
            context.outputDir,
            `session-${context.sessionId}`
          );
          if (cookieArtifact) artifacts.push(cookieArtifact);
        }

        // Take final screenshot if requested
        if (
          takeScreenshot &&
          context.config.artifactConfig?.saveScreenshots !== false
        ) {
          const screenshotArtifact =
            await context.artifactCollector.takeScreenshot(
              context.page,
              context.outputDir,
              `session-${context.sessionId}-final`
            );
          if (screenshotArtifact) artifacts.push(screenshotArtifact);
        }

        return { artifacts };
      }
    ),

    cleanupBrowser: fromPromise(
      async ({ input }: { input: { context: ManualSessionContext } }) => {
        const { context } = input;
        logger.info("Cleaning up browser session", {
          sessionId: context.sessionId,
        });

        try {
          // Stop network tracking
          if (context.artifactCollector) {
            context.artifactCollector.stopNetworkTracking();
          }

          // Close browser context and browser
          if (context.context) {
            await context.context.close();
          }

          if (context.browser) {
            await context.browser.close();
          }
        } catch (error) {
          logger.warn("Error during browser cleanup", {
            sessionId: context.sessionId,
            error: error instanceof Error ? error.message : "Unknown error",
          });
        }

        return { cleanupComplete: true };
      }
    ),
  },
}).createMachine({
  id: "manualSession",
  initial: "initializing",
  context: ({ input }) => {
    const inputData = input as {
      sessionId?: string;
      config?: SessionConfig;
    };
    return {
      sessionId: inputData?.sessionId || crypto.randomUUID(),
      sessionType: "manual" as const,
      config: inputData?.config || {},
      startTime: Date.now(),
      outputDir: "",
      artifacts: [],
      metadata: {
        networkRequestCount: 0,
      },
      logs: [],
    };
  },
  states: {
    initializing: {
      on: {
        START_MANUAL_SESSION: {
          target: "launchingBrowser",
          actions: "initializeContext",
        },
        // Global events
        ADD_LOG: { actions: "addLogEntry" },
      },
    },

    launchingBrowser: {
      invoke: {
        id: "launchBrowser",
        src: "launchBrowser",
        input: ({ context }) => ({
          config: context.config,
          sessionId: context.sessionId,
        }),
        onDone: {
          target: "active",
          actions: "storeBrowserSession",
        },
        onError: {
          target: "failed",
          actions: assign({
            error: ({ event }) => ({
              message: `Browser launch failed: ${
                event.error instanceof Error
                  ? event.error.message
                  : "Unknown error"
              }`,
              code: "BROWSER_LAUNCH_FAILED",
            }),
          }),
        },
      },
      on: {
        ADD_LOG: { actions: "addLogEntry" },
      },
    },

    active: {
      entry: "logStateTransition",
      on: {
        NAVIGATE: {
          target: "navigating",
        },
        UPDATE_METADATA: {
          actions: "updateMetadata",
        },
        COLLECT_ARTIFACTS: {
          target: "collectingArtifacts",
        },
        STOP_MANUAL_SESSION: {
          target: "stopping",
        },
        ADD_LOG: { actions: "addLogEntry" },
      },
    },

    navigating: {
      entry: "logStateTransition",
      on: {
        NAVIGATION_COMPLETE: {
          target: "active",
          actions: "updateNavigation",
        },
        UPDATE_METADATA: {
          actions: "updateMetadata",
        },
        STOP_MANUAL_SESSION: {
          target: "stopping",
        },
        ADD_LOG: { actions: "addLogEntry" },
      },
    },

    collectingArtifacts: {
      invoke: {
        id: "collectArtifacts",
        src: "collectArtifacts",
        input: ({
          context,
          event,
        }: {
          context: ManualSessionContext;
          event: any;
        }) => ({
          context,
          ...(event.type === "COLLECT_ARTIFACTS" && {
            artifactTypes: event.artifactTypes,
            takeScreenshot: event.takeScreenshot,
          }),
        }),
        onDone: {
          target: "active",
          actions: "storeArtifacts",
        },
        onError: {
          target: "active", // Continue session even if artifact collection fails
          actions: assign({
            error: ({ event }) => ({
              message: `Artifact collection failed: ${
                event.error instanceof Error
                  ? event.error.message
                  : "Unknown error"
              }`,
              code: "ARTIFACT_COLLECTION_FAILED",
            }),
          }),
        },
      },
      on: {
        STOP_MANUAL_SESSION: {
          target: "stopping",
        },
        ADD_LOG: { actions: "addLogEntry" },
      },
    },

    stopping: {
      invoke: {
        id: "collectFinalArtifacts",
        src: "collectArtifacts",
        input: ({ context }) => ({
          context,
          takeScreenshot: true,
        }),
        onDone: {
          target: "cleanup",
          actions: "storeArtifacts",
        },
        onError: {
          target: "cleanup", // Proceed to cleanup even if final artifacts fail
        },
      },
      on: {
        ADD_LOG: { actions: "addLogEntry" },
      },
    },

    cleanup: {
      invoke: {
        id: "cleanupBrowser",
        src: "cleanupBrowser",
        input: ({ context }) => ({ context }),
        onDone: {
          target: "stopped",
        },
        onError: {
          target: "stopped", // Mark as stopped even if cleanup has issues
        },
      },
      on: {
        ADD_LOG: { actions: "addLogEntry" },
      },
    },

    stopped: {
      type: "final",
      entry: "logStateTransition",
      on: {
        ADD_LOG: { actions: "addLogEntry" },
      },
    },

    failed: {
      type: "final",
      entry: ["storeError", "logStateTransition"],
      on: {
        ADD_LOG: { actions: "addLogEntry" },
      },
    },
  },
});
