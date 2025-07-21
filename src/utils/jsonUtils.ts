import { HarvestError } from "../types/index.js";

/**
 * Safely parse JSON with contextual error information to prevent
 * generic parsing errors that lack debugging context.
 *
 * @param content - The string content to parse as JSON
 * @param context - Description of what is being parsed (for error context)
 * @returns Parsed JSON object
 * @throws HarvestError with contextual information on parse failure
 */
export function safeJsonParse<T>(content: string, context: string): T {
  try {
    return JSON.parse(content) as T;
  } catch (error) {
    // Truncate content for logging to avoid overwhelming error messages
    const truncatedContent =
      content.length > 200 ? `${content.substring(0, 200)}...` : content;

    throw new HarvestError(
      `JSON Parse error while processing ${context}: ${error instanceof Error ? error.message : "Unknown error"}`,
      "JSON_PARSE_ERROR",
      {
        context,
        contentPreview: truncatedContent,
        contentLength: content.length,
        originalError: error,
      }
    );
  }
}

/**
 * Safely parse JSON with a default fallback value.
 * Returns the fallback value if parsing fails instead of throwing.
 *
 * @param content - The string content to parse as JSON
 * @param context - Description of what is being parsed (for logging)
 * @param fallback - Default value to return on parse failure
 * @returns Parsed JSON object or fallback value
 */
export function safeJsonParseWithFallback<T>(
  content: string,
  context: string,
  fallback: T
): T {
  try {
    return JSON.parse(content) as T;
  } catch (error) {
    console.warn(
      `Failed to parse JSON for ${context}: ${error instanceof Error ? error.message : "Unknown error"}`
    );
    return fallback;
  }
}
