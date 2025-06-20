import type { FunctionDefinition } from "openai/resources/shared";
import { getLLMClient } from "../core/LLMClient.js";
import {
  HarvestError,
  type InputVariableItem,
  type InputVariablesResponse,
  type InputVariablesResult,
} from "../types/index.js";

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
  } catch (error) {
    if (error instanceof HarvestError) {
      throw error;
    }

    throw new HarvestError(
      `Input variables identification failed: ${error instanceof Error ? error.message : "Unknown error"}`,
      "INPUT_VARIABLES_IDENTIFICATION_FAILED",
      { originalError: error }
    );
  }
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
            required: ["variable_name", "variable_value"],
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

/**
 * Validate input variables format
 */
export function validateInputVariables(
  inputVariables: Record<string, string>
): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];

  if (typeof inputVariables !== "object" || inputVariables === null) {
    errors.push("Input variables must be an object");
    return { valid: false, errors };
  }

  for (const [key, value] of Object.entries(inputVariables)) {
    if (typeof key !== "string" || key.trim() === "") {
      errors.push(`Invalid key: "${key}" - must be a non-empty string`);
    }

    if (typeof value !== "string") {
      errors.push(`Invalid value for key "${key}" - must be a string`);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Get potential input variables from a curl command using heuristics
 * This provides suggestions when input variables are not explicitly provided
 */
export function extractPotentialInputVariables(
  curlCommand: string
): Record<string, string> {
  const potentialVars: Record<string, string> = {};

  // Extract common user input patterns from JSON body
  const jsonBodyMatch = curlCommand.match(/--data\s+'([^']+)'/);
  if (jsonBodyMatch?.[1]) {
    try {
      const bodyData = JSON.parse(jsonBodyMatch[1]);

      // Look for fields that might be user inputs
      const userInputFields = [
        "amount",
        "value",
        "quantity",
        "count",
        "name",
        "title",
        "description",
        "message",
        "comment",
        "note",
        "email",
        "username",
        "phone",
        "address",
        "search",
        "query",
        "term",
        "keyword",
        "category",
        "type",
        "status",
        "priority",
      ];

      for (const [key, value] of Object.entries(bodyData)) {
        const lowerKey = key.toLowerCase();

        if (userInputFields.some((field) => lowerKey.includes(field))) {
          if (typeof value === "string" || typeof value === "number") {
            potentialVars[key] = String(value);
          }
        }
      }
    } catch (_error) {
      // If JSON parsing fails, continue without body extraction
    }
  }

  // Extract from query parameters
  const queryParamMatches = curlCommand.match(/[?&]([^=]+)=([^&\s']+)/g);
  if (queryParamMatches) {
    for (const match of queryParamMatches) {
      const [, key, value] = match.match(/[?&]([^=]+)=([^&\s']+)/) || [];
      if (key && value) {
        // Decode URL-encoded values
        try {
          const decodedValue = decodeURIComponent(value);
          potentialVars[key] = decodedValue;
        } catch {
          potentialVars[key] = value;
        }
      }
    }
  }

  return potentialVars;
}

/**
 * Merge and deduplicate input variables
 */
export function mergeInputVariables(
  primary: Record<string, string>,
  secondary: Record<string, string>
): Record<string, string> {
  const merged = { ...secondary };

  // Primary variables take precedence
  for (const [key, value] of Object.entries(primary)) {
    merged[key] = value;
  }

  return merged;
}
