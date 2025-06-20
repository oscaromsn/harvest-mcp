/**
 * General purpose logging utility for Harvest MCP
 * Configured to work with MCP stdio transport without interference
 */

import pino from "pino";

// Determine if we're running in MCP mode (stdio transport)
const isMcpMode = process.env.MCP_STDIO === "true" || process.argv.includes("--stdio");

// Create the base logger with harvest-mcp specific configuration
const loggerOptions: Record<string, unknown> = {
  level: process.env.HARVEST_LOG_LEVEL || process.env.LOG_LEVEL || "info",
};

// In MCP mode, log to stderr to avoid stdio interference
// In development, use pino-pretty for readable output 
if (isMcpMode) {
  // MCP mode: log to stderr in JSON format to avoid stdio conflicts
  loggerOptions.transport = {
    target: "pino/file",
    options: {
      destination: 2, // stderr
    },
  };
} else if (process.env.NODE_ENV === "development") {
  // Development mode: use pino-pretty for readable output
  loggerOptions.transport = {
    target: "pino-pretty",
    options: {
      colorize: true,
      translateTime: "HH:MM:ss",
      ignore: "pid,hostname",
    },
  };
}

export const logger = pino(loggerOptions).child({
  name: "harvest-mcp",
});

// Create specialized loggers for different components
export const serverLogger = logger.child({ component: "server" });
export const browserLogger = logger.child({ component: "browser" });
export const sessionLogger = logger.child({ component: "session" });
export const artifactLogger = logger.child({ component: "artifacts" });
export const providerLogger = logger.child({ component: "provider" });

/**
 * Create a component-specific logger
 */
export function createComponentLogger(component: string) {
  return logger.child({ component });
}

/**
 * Create a session-specific logger
 */
export function createSessionLogger(sessionId: string) {
  return sessionLogger.child({ sessionId });
}

/**
 * Log browser operation with context
 */
export function logBrowserOperation(
  operation: string,
  context?: Record<string, unknown>
) {
  browserLogger.info(
    { operation, ...context },
    `Browser operation: ${operation}`
  );
}

/**
 * Log artifact collection event
 */
export function logArtifactEvent(
  event: string,
  artifactType: string,
  context?: Record<string, unknown>
) {
  artifactLogger.info(
    { event, artifactType, ...context },
    `Artifact ${event}: ${artifactType}`
  );
}

/**
 * Log session lifecycle event
 */
export function logSessionEvent(
  sessionId: string,
  event: string,
  context?: Record<string, unknown>
) {
  const sessionLog = createSessionLogger(sessionId);
  sessionLog.info({ event, ...context }, `Session ${event}`);
}

/**
 * Log error with browser context
 */
export function logBrowserError(
  error: Error | string,
  context?: Record<string, unknown>
) {
  const errorMessage = error instanceof Error ? error.message : error;
  const errorStack = error instanceof Error ? error.stack : undefined;

  browserLogger.error(
    { error: errorMessage, stack: errorStack, ...context },
    `Browser error: ${errorMessage}`
  );
}
