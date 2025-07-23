import { getLLMClient } from "../core/LLMClient.js";
import type { FunctionDefinition } from "../core/providers/types.js";
import {
  HarvestError,
  type InputVariableItem,
  type InputVariablesResponse,
  type InputVariablesResult,
} from "../types/index.js";
import { createComponentLogger } from "../utils/logger.js";

const logger = createComponentLogger("input-variables-agent");

/**
 * Identify input variables present in a cURL command using LLM analysis
 */
export async function identifyInputVariables(
  curlCommand: string,
  inputVariables: Record<string, string>,
  currentDynamicParts: string[] = []
): Promise<InputVariablesResult> {
  // Return early if no input variables provided
  if (!inputVariables || Object.keys(inputVariables).length === 0) {
    return {
      identifiedVariables: {},
      removedDynamicParts: [],
    };
  }

  try {
    const llmClient = getLLMClient();
    const functionDef = createFunctionDefinition();
    const prompt = createPrompt(curlCommand, inputVariables);

    const response = await llmClient.callFunction<InputVariablesResponse>(
      prompt,
      functionDef,
      "identify_input_variables"
    );

    const identifiedVariables = convertLLMResponse(
      response.identified_variables || []
    );
    const removedDynamicParts = updateDynamicParts(
      currentDynamicParts,
      identifiedVariables
    );

    return {
      identifiedVariables,
      removedDynamicParts,
    };
  } catch (llmError) {
    logger.warn(
      "LLM input variables identification failed, falling back to static analysis",
      {
        error: llmError instanceof Error ? llmError.message : "Unknown error",
      }
    );

    // Fallback to static input variable identification
    try {
      const staticVariables = identifyInputVariablesStatically(
        curlCommand,
        inputVariables
      );
      const removedDynamicParts = updateDynamicParts(
        currentDynamicParts,
        staticVariables
      );

      return {
        identifiedVariables: staticVariables,
        removedDynamicParts,
      };
    } catch (staticError) {
      throw new HarvestError(
        `Both LLM and static input variables identification failed: ${staticError instanceof Error ? staticError.message : "Unknown error"}`,
        "INPUT_VARIABLES_IDENTIFICATION_FAILED",
        {
          originalLLMError: llmError,
          originalStaticError: staticError,
        }
      );
    }
  }
}

/**
 * Static input variables identification that doesn't require LLM calls
 * Used as fallback when LLM services are unavailable
 */
function identifyInputVariablesStatically(
  curlCommand: string,
  existingInputVariables: Record<string, string>
): Record<string, string> {
  logger.debug("Performing static input variables identification", {
    commandLength: curlCommand.length,
    existingVariablesCount: Object.keys(existingInputVariables).length,
  });

  const identifiedVariables: Record<string, string> = {};

  // Common patterns for input variables that users typically need to provide
  const inputPatterns = [
    // Search terms and queries
    { pattern: /[?&]q=([^&]+)/g, name: "search_query" },
    { pattern: /[?&]query=([^&]+)/g, name: "search_query" },
    { pattern: /[?&]search=([^&]+)/g, name: "search_term" },
    { pattern: /[?&]termo=([^&]+)/g, name: "search_term" },
    { pattern: /[?&]pesquisa=([^&]+)/g, name: "search_term" },

    // User identification
    { pattern: /[?&]user=([^&]+)/g, name: "user_id" },
    { pattern: /[?&]username=([^&]+)/g, name: "username" },
    { pattern: /[?&]email=([^&]+)/g, name: "email" },

    // IDs and references
    { pattern: /[?&]id=([^&]+)/g, name: "record_id" },
    { pattern: /[?&]doc_id=([^&]+)/g, name: "document_id" },
    { pattern: /[?&]ref=([^&]+)/g, name: "reference" },

    // Filters and options
    { pattern: /[?&]filter=([^&]+)/g, name: "filter" },
    { pattern: /[?&]category=([^&]+)/g, name: "category" },
    { pattern: /[?&]type=([^&]+)/g, name: "content_type" },
    { pattern: /[?&]status=([^&]+)/g, name: "status" },

    // Pagination
    { pattern: /[?&]page=([^&]+)/g, name: "page_number" },
    { pattern: /[?&]limit=([^&]+)/g, name: "page_size" },
    { pattern: /[?&]offset=([^&]+)/g, name: "offset" },

    // Dates and time ranges
    { pattern: /[?&]date=([^&]+)/g, name: "date" },
    { pattern: /[?&]start_date=([^&]+)/g, name: "start_date" },
    { pattern: /[?&]end_date=([^&]+)/g, name: "end_date" },
  ];

  // Extract parameters from URL
  for (const { pattern, name } of inputPatterns) {
    const matches = curlCommand.match(pattern);
    if (matches) {
      for (const match of matches) {
        const valueMatch = match.match(/=([^&]+)/);
        if (valueMatch && valueMatch[1]) {
          const value = decodeURIComponent(valueMatch[1]);

          // Only consider it an input variable if:
          // 1. It's not already in existing variables
          // 2. It looks like user-provided content (not system-generated)
          // 3. It's not too short or too long
          if (
            !existingInputVariables[name] &&
            isUserProvidedValue(value) &&
            value.length >= 2 &&
            value.length <= 200
          ) {
            identifiedVariables[name] = value;
            logger.debug(
              `Identified input variable: ${name} = ${value.substring(0, 20)}...`
            );
          }
        }
      }
    }
  }

  // Extract input variables from POST data
  const dataMatch = curlCommand.match(/--data[^"]*"([^"]+)"/);
  if (dataMatch) {
    const postData = dataMatch[1];

    for (const { pattern, name } of inputPatterns) {
      const matches = postData?.match(pattern);
      if (matches) {
        for (const match of matches) {
          const valueMatch = match.match(/=([^&]+)/);
          if (valueMatch && valueMatch[1]) {
            const value = decodeURIComponent(valueMatch[1]);

            if (
              !existingInputVariables[name] &&
              isUserProvidedValue(value) &&
              value.length >= 2 &&
              value.length <= 200
            ) {
              identifiedVariables[name] = value;
              logger.debug(
                `Identified input variable from POST: ${name} = ${value.substring(0, 20)}...`
              );
            }
          }
        }
      }
    }
  }

  logger.debug("Static input variables identification completed", {
    identifiedCount: Object.keys(identifiedVariables).length,
    variables: Object.keys(identifiedVariables),
  });

  return identifiedVariables;
}

/**
 * Check if a value looks like user-provided content rather than system-generated
 */
function isUserProvidedValue(value: string): boolean {
  // Skip values that look system-generated
  const systemPatterns = [
    /^[0-9a-f]{8,}$/i, // Long hex strings (IDs, tokens)
    /^[A-Z0-9]{20,}$/, // Long uppercase alphanumeric (tokens)
    /^\d{13,}$/, // Long numeric strings (timestamps)
    /^[a-zA-Z0-9+/]{20,}={0,2}$/, // Base64-like strings
  ];

  for (const pattern of systemPatterns) {
    if (pattern.test(value)) {
      return false;
    }
  }

  // Values that look like user content
  const userPatterns = [
    /^[a-zA-Z\s]+$/, // Natural language text
    /^[a-zA-Z0-9\s\-_]+$/, // Mixed alphanumeric with common separators
    /\w+@\w+\.\w+/, // Email-like
    /^\d{1,4}$/, // Small numbers (page numbers, etc.)
  ];

  for (const pattern of userPatterns) {
    if (pattern.test(value)) {
      return true;
    }
  }

  // Default to considering it user content if it contains spaces or common punctuation
  return /[\s\-_.,!?]/.test(value);
}

/**
 * Create the OpenAI function definition for input variables identification
 */
export function createFunctionDefinition(): FunctionDefinition {
  return {
    name: "identify_input_variables",
    description: "Identify input variables present in the cURL command.",
    parameters: {
      type: "object",
      properties: {
        identified_variables: {
          type: "array",
          items: {
            type: "object",
            properties: {
              variable_name: {
                type: "string",
                description: "The original key of the variable",
              },
              variable_value: {
                type: "string",
                description:
                  "The exact version of the variable that is present in the cURL command. This should closely match the value in the provided Input Variables.",
              },
            },
          },
          description: "A list of identified variables and their values.",
        },
      },
      required: ["identified_variables"],
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
  return `cURL: ${curlCommand}
Input Variables: ${JSON.stringify(inputVariables)}

Task:
Identify which input variables (the value in the key-value pair) from the Input Variables provided above are present in the cURL command.

Important:
- If an input variable is found in the cURL, include it in the output.
- Do not include variables that are not provided above.
- The key of the input variable is a description of the variable.
- The value is the value that should closely match the value in the cURL command. No substitutions.
- Only return variables whose values are actually present in the cURL command.`;
}

/**
 * Find variables that are present in the curl command (heuristic approach)
 */
export function findPresentVariables(
  inputVariables: Record<string, string>,
  curlCommand: string
): string[] {
  const presentVariables: string[] = [];

  for (const [, value] of Object.entries(inputVariables)) {
    if (value && curlCommand.includes(value)) {
      presentVariables.push(value);
    }
  }

  return presentVariables;
}

/**
 * Convert LLM response to the expected format
 */
export function convertLLMResponse(
  identifiedVariables: InputVariableItem[]
): Record<string, string> {
  const converted: Record<string, string> = {};

  for (const item of identifiedVariables) {
    // Validate the item has required properties
    if (
      item &&
      typeof item.variable_name === "string" &&
      typeof item.variable_value === "string" &&
      item.variable_name.trim() !== "" &&
      item.variable_value.trim() !== ""
    ) {
      converted[item.variable_name] = item.variable_value;
    }
  }

  return converted;
}

/**
 * Update dynamic parts by removing identified input variables
 */
export function updateDynamicParts(
  currentDynamicParts: string[],
  identifiedVariables: Record<string, string>
): string[] {
  const identifiedValues = Object.values(identifiedVariables);

  return currentDynamicParts.filter((part) => !identifiedValues.includes(part));
}
