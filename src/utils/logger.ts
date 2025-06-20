/**
 * General purpose logging utility for Harvest MCP
 */

import pino from "pino";

// Create the base logger with harvest-mcp specific configuration
const loggerOptions: Record<string, unknown> = {
  level: process.env.HARVEST_LOG_LEVEL || process.env.LOG_LEVEL || "info",
};

// Add transport only in development to avoid type issues with undefined
if (process.env.NODE_ENV === "development") {
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
