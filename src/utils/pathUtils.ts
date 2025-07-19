import { access, mkdir } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createComponentLogger } from "./logger.js";

const logger = createComponentLogger("path-utils");

/**
 * Expand tilde (~) in file paths to user home directory
 */
export function expandTilde(filePath: string): string {
  if (filePath.startsWith("~/") || filePath === "~") {
    return filePath.replace(/^~/, homedir());
  }
  return filePath;
}

/**
 * Check if a directory is writable
 */
export async function isDirectoryWritable(dirPath: string): Promise<boolean> {
  try {
    await access(dirPath, 2); // F_OK | W_OK (exists and writable)
    return true;
  } catch {
    return false;
  }
}

/**
 * Create a directory with proper error handling and fallback
 */
export async function createSafeDirectory(
  requestedPath: string,
  fallbackPrefix = "harvest-session"
): Promise<string> {
  // Expand tilde if present
  const expandedPath = expandTilde(requestedPath);
  const resolvedPath = resolve(expandedPath);

  try {
    // Try to create the requested directory
    await mkdir(resolvedPath, { recursive: true });

    // Verify it's writable
    const isWritable = await isDirectoryWritable(resolvedPath);
    if (isWritable) {
      logger.info(`Created directory: ${resolvedPath}`);
      return resolvedPath;
    }

    logger.warn(`Directory created but not writable: ${resolvedPath}`);
  } catch (error) {
    logger.warn(`Failed to create requested directory: ${resolvedPath}`, {
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }

  // Fallback to temporary directory
  const fallbackPath = join(tmpdir(), fallbackPrefix, `session-${Date.now()}`);

  try {
    await mkdir(fallbackPath, { recursive: true });

    // Verify fallback is writable
    const isWritable = await isDirectoryWritable(fallbackPath);
    if (isWritable) {
      logger.info(`Using fallback directory: ${fallbackPath}`, {
        requestedPath: resolvedPath,
      });
      return fallbackPath;
    }
  } catch (error) {
    logger.error(`Failed to create fallback directory: ${fallbackPath}`, {
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }

  // Final fallback - use temp dir directly
  const finalFallback = tmpdir();
  logger.warn(
    `Using system temp directory as final fallback: ${finalFallback}`,
    { requestedPath: resolvedPath, fallbackPath }
  );

  return finalFallback;
}

/**
 * Get a safe output directory with proper fallbacks
 */
export async function getSafeOutputDirectory(
  requestedDir?: string,
  defaultDir?: string,
  sessionId?: string,
  clientAccessible = false
): Promise<string> {
  // If client accessibility is required, use shared directory
  if (clientAccessible) {
    const sharedBaseDir =
      process.env.HARVEST_SHARED_DIR || join(homedir(), ".harvest", "shared");
    const sessionPart = sessionId ? `/${sessionId}` : `/session-${Date.now()}`;
    const sharedPath = `${sharedBaseDir}${sessionPart}`;

    try {
      const result = await createSafeDirectory(sharedPath, "harvest-shared");

      // Verify the result is actually in the shared directory for client accessibility
      if (result.includes(".harvest") || result.includes("harvest-shared")) {
        logger.info(
          { sharedPath: result, sessionId },
          "Created client-accessible directory"
        );
        return result;
      }
      throw new Error("Created directory is not client-accessible");
    } catch (error) {
      logger.error(
        `Failed to create client-accessible directory: ${sharedPath}`,
        {
          error: error instanceof Error ? error.message : "Unknown error",
        }
      );

      // For client-accessible requirements, try additional fallbacks in accessible locations
      const fallbackPaths = [
        join(
          homedir(),
          ".harvest",
          "temp",
          sessionId || `session-${Date.now()}`
        ),
        join(
          homedir(),
          ".harvest",
          "artifacts",
          sessionId || `session-${Date.now()}`
        ),
      ];

      for (const fallbackPath of fallbackPaths) {
        try {
          const result = await createSafeDirectory(
            fallbackPath,
            "harvest-shared"
          );
          logger.warn(
            { fallbackPath: result, originalPath: sharedPath },
            "Using client-accessible fallback directory"
          );
          return result;
        } catch (fallbackError) {
          logger.warn(`Client-accessible fallback failed: ${fallbackPath}`, {
            error:
              fallbackError instanceof Error
                ? fallbackError.message
                : "Unknown error",
          });
        }
      }

      // If all client-accessible options fail, throw error instead of falling back to temp
      throw new Error(
        `Cannot create client-accessible directory. All attempts failed: ${sharedPath}, ${fallbackPaths.join(", ")}`
      );
    }
  }

  // If specific directory requested, try that first
  if (requestedDir) {
    return createSafeDirectory(requestedDir, "harvest-manual");
  }

  // Try default directory if provided
  if (defaultDir) {
    const datePart = new Date().toISOString().split("T")[0];
    const sessionPart = sessionId ? `/${sessionId}` : "";
    const fullDefaultPath = `${defaultDir}/${datePart}${sessionPart}`;

    try {
      return await createSafeDirectory(fullDefaultPath, "harvest-manual");
    } catch (error) {
      logger.warn(`Default directory creation failed: ${fullDefaultPath}`, {
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }

  // Final fallback to temp directory
  const tempDir = join(tmpdir(), "harvest-manual-sessions");
  const datePart = new Date().toISOString().split("T")[0];
  const sessionPart = sessionId ? `/${sessionId}` : `/session-${Date.now()}`;
  const finalPath = `${tempDir}/${datePart}${sessionPart}`;

  return createSafeDirectory(finalPath, "harvest-manual");
}

/**
 * Validate and normalize a path for safe usage
 */
export function validateAndNormalizePath(inputPath: string): {
  isValid: boolean;
  normalizedPath: string;
  error?: string;
} {
  try {
    const expanded = expandTilde(inputPath);
    const normalized = resolve(expanded);

    // Basic security checks
    if (normalized.includes("..")) {
      return {
        isValid: false,
        normalizedPath: "",
        error: "Path contains invalid traversal sequences",
      };
    }

    return {
      isValid: true,
      normalizedPath: normalized,
    };
  } catch (error) {
    return {
      isValid: false,
      normalizedPath: "",
      error: error instanceof Error ? error.message : "Unknown path error",
    };
  }
}
