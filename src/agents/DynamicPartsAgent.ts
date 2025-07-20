import { getLLMClient } from "../core/LLMClient.js";
import type { FunctionDefinition } from "../core/providers/types.js";
import { type DynamicPartsResponse, HarvestError } from "../types/index.js";

/**
 * Result of filtering input variables from dynamic parts
 */
interface FilterResult {
  filteredParts: string[];
  removedParts: string[];
}

/**
 * Identify dynamic parts present in a cURL command using LLM analysis
 */
export async function identifyDynamicParts(
  curlCommand: string,
  inputVariables: Record<string, string> = {}
): Promise<string[]> {
  // Skip analysis for JavaScript files
  if (isJavaScriptFile(curlCommand)) {
    return [];
  }

  try {
    const llmClient = getLLMClient();
    const functionDef = createFunctionDefinition();
    const prompt = createPrompt(curlCommand, inputVariables);

    const response = await llmClient.callFunction<DynamicPartsResponse>(
      prompt,
      functionDef,
      "identify_dynamic_parts"
    );

    let dynamicParts = response.dynamic_parts || [];

    // Filter out input variables that are present in the request
    const filterResult = filterInputVariables(
      dynamicParts,
      inputVariables,
      curlCommand
    );
    dynamicParts = filterResult.filteredParts;

    return dynamicParts;
  } catch (error) {
    if (error instanceof HarvestError) {
      throw error;
    }

    throw new HarvestError(
      `Dynamic parts identification failed: ${error instanceof Error ? error.message : "Unknown error"}`,
      "DYNAMIC_PARTS_IDENTIFICATION_FAILED",
      { originalError: error }
    );
  }
}

/**
 * Create the OpenAI function definition for dynamic parts identification
 */
export function createFunctionDefinition(): FunctionDefinition {
  return {
    name: "identify_dynamic_parts",
    description:
      "Given the above cURL command, identify which parts are dynamic and validated by the server " +
      "for correctness (e.g., authentication tokens, session IDs, CSRF tokens, API keys). Include all " +
      "authentication-related values but exclude arbitrary user input or general data that can be hardcoded.",
    parameters: {
      type: "object",
      properties: {
        dynamic_parts: {
          type: "array",
          items: { type: "string" },
          description:
            "List of dynamic parts identified in the cURL command, with special focus on authentication tokens. " +
            "Include: Bearer tokens, API keys, session cookies, CSRF tokens, authentication parameters. " +
            "Only include the dynamic values (not the keys) of parts that are unique to a user or session " +
            "and, if incorrect, will cause the request to fail due to authentication or authorization errors. " +
            "Do not include duplicates. Do not include the keys, only the values.",
        },
      },
      required: ["dynamic_parts"],
    },
  };
}

/**
 * Create the prompt for LLM analysis
 */
export function createPrompt(
  curlCommand: string,
  inputVariables: Record<string, string>
): string {
  return `URL: ${curlCommand}

Task:

Use your best judgment to identify which parts of the cURL command are dynamic, specific to a user or session, and are checked by the server for validity. These include tokens, IDs, session variables, or any other values that are unique to a user or session and, if incorrect, will cause the request to fail.

Important:
    - INCLUDE authentication tokens from Authorization headers, API key headers, and authentication cookies
    - INCLUDE session identifiers, CSRF tokens, and authentication parameters
    - Ignore common non-authentication headers like user-agent, sec-ch-ua, accept-encoding, referer, etc.
    - Exclude parameters that represent arbitrary user input or general data that can be hardcoded, such as amounts, notes, messages, actions, etc.
    - Only output the variable values and not the keys.
    - Focus on unique identifiers, authentication tokens, session variables, and security tokens.
    - Pay special attention to Bearer tokens, API keys, session cookies, and URL-based authentication parameters.

${Object.keys(inputVariables).length > 0 ? `Input Variables Available: ${JSON.stringify(inputVariables)}` : ""}`;
}

/**
 * Check if the request is for a JavaScript file (should skip analysis)
 */
export function isJavaScriptFile(curlCommand: string): boolean {
  return (
    curlCommand.includes(".js'") ||
    curlCommand.endsWith(".js") ||
    curlCommand.includes(".js ")
  );
}

/**
 * Filter input variables from dynamic parts
 * Removes any dynamic parts that match input variable values
 */
export function filterInputVariables(
  dynamicParts: string[],
  inputVariables: Record<string, string>,
  curlCommand: string
): FilterResult {
  const inputValues = Object.values(inputVariables);
  const removedParts: string[] = [];

  // Find which input variables are present in the curl command
  const presentVariables = inputValues.filter((value) =>
    curlCommand.includes(value)
  );

  // Remove any dynamic parts that match present input variables
  const filteredParts = dynamicParts.filter((part) => {
    if (presentVariables.includes(part)) {
      removedParts.push(part);
      return false;
    }
    return true;
  });

  return {
    filteredParts,
    removedParts,
  };
}

/**
 * Validate dynamic parts against common patterns
 */
export function validateDynamicParts(dynamicParts: string[]): {
  valid: string[];
  invalid: string[];
  reasons: Record<string, string>;
} {
  const valid: string[] = [];
  const invalid: string[] = [];
  const reasons: Record<string, string> = {};

  for (const part of dynamicParts) {
    // Skip empty or very short parts
    if (!part || part.length < 3) {
      invalid.push(part);
      reasons[part] = "Too short to be meaningful";
      continue;
    }

    // Skip common static values
    const staticPatterns = [
      "application/json",
      "text/html",
      "utf-8",
      "gzip",
      "deflate",
      "en-US",
      "Mozilla",
      "Chrome",
      "Safari",
    ];

    if (staticPatterns.some((pattern) => part.includes(pattern))) {
      invalid.push(part);
      reasons[part] = "Appears to be static content";
      continue;
    }

    // Look for token-like patterns (alphanumeric, often with specific lengths)
    const tokenPatterns = [
      /^[a-f0-9]{8,}$/i, // Hex tokens
      /^[A-Z0-9]{10,}$/, // Uppercase alphanumeric
      /^[a-zA-Z0-9+/]{20,}={0,2}$/, // Base64-like
      /^\d{10,}$/, // Long numeric IDs
      /^[a-zA-Z0-9-_]{10,}$/, // General tokens with common separators
    ];

    if (tokenPatterns.some((pattern) => pattern.test(part))) {
      valid.push(part);
    } else if (part.length >= 6 && /^[a-zA-Z0-9-_]+$/.test(part)) {
      // Check if it looks like a meaningful identifier
      valid.push(part);
    } else {
      invalid.push(part);
      reasons[part] = "Does not match common token patterns";
    }
  }

  return { valid, invalid, reasons };
}

/**
 * Get suggested dynamic parts from a request using heuristics
 * This provides a fallback when LLM analysis is not available
 */
export function extractPotentialDynamicParts(curlCommand: string): string[] {
  const potentialParts: Set<string> = new Set();

  // Extract from Authorization headers
  const authMatches = curlCommand.match(
    /Authorization['":\s]+(?:Bearer\s+)?([a-zA-Z0-9+/=_-]+)/gi
  );
  if (authMatches) {
    for (const match of authMatches) {
      const token = match.replace(
        /.*(?:Bearer\s+)?([a-zA-Z0-9+/=_-]+).*/,
        "$1"
      );
      if (token.length > 10) {
        potentialParts.add(token);
      }
    }
  }

  // Extract tokens from headers (X-*, CSRF, etc.)
  const tokenHeaders = curlCommand.match(
    /['"]\s*[Xx]-[^:]+:\s*([a-zA-Z0-9+/=_-]{8,})\s*['"]/g
  );
  if (tokenHeaders) {
    for (const match of tokenHeaders) {
      const token = match.replace(/.*:\s*([a-zA-Z0-9+/=_-]+).*/, "$1");
      potentialParts.add(token);
    }
  }

  // Extract IDs from URLs
  const urlIds = curlCommand.match(/\/(\d{6,}|[a-f0-9]{8,}|[A-Z0-9]{8,})\b/gi);
  if (urlIds) {
    for (const match of urlIds) {
      const id = match.replace("/", "");
      potentialParts.add(id);
    }
  }

  // Extract from JSON body
  const jsonMatches = curlCommand.match(/"([a-zA-Z0-9+/=_-]{10,})"/g);
  if (jsonMatches) {
    for (const match of jsonMatches) {
      const value = match.replace(/"/g, "");
      if (!/^[a-z\s]+$/.test(value)) {
        // Skip plain text values
        potentialParts.add(value);
      }
    }
  }

  return Array.from(potentialParts);
}
