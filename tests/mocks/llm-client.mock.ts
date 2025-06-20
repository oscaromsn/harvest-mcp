import type { FunctionDefinition } from "openai/resources/shared";
import { vi } from "vitest";
import type {
  DynamicPartsResponse,
  InputVariablesResponse,
  SimplestRequestResponse,
  URLIdentificationResponse,
} from "../../src/types/index.js";

// Mock OpenAI client interface for testing
interface MockOpenAIClient {
  apiKey: string;
}

/**
 * LLM Client mocks specifically for unit testing
 * These mocks should ONLY be used in unit tests where we need to isolate LLM calls
 */

export const DEFAULT_MOCK_RESPONSES = {
  identify_end_url: {
    url: "https://api.example.com/search",
  } as URLIdentificationResponse,

  identify_dynamic_parts: {
    dynamic_parts: ["auth_token", "user_id", "session_key"],
  } as DynamicPartsResponse,

  identify_input_variables: {
    identified_variables: [
      { variable_name: "search_term", variable_value: "documents" },
      { variable_name: "user_input", variable_value: "test_value" },
    ],
  } as InputVariablesResponse,

  get_simplest_curl_index: {
    index: 0,
  } as SimplestRequestResponse,
} as const;

/**
 * Creates a fully mocked LLM client for unit tests
 * Use this ONLY when you need to isolate the component being tested from LLM calls
 */
export const createMockLLMClient = (
  customResponses: Partial<typeof DEFAULT_MOCK_RESPONSES> = {}
) => {
  const responses = { ...DEFAULT_MOCK_RESPONSES, ...customResponses };

  return {
    // Mock the private properties that LLMClient has
    client: { apiKey: "test-api-key" } as MockOpenAIClient,
    model: "gpt-4o",

    callFunction: vi.fn(
      async (
        _prompt: string,
        _functionDef: FunctionDefinition,
        functionName: string
      ) => {
        // Simulate realistic API delay
        await new Promise((resolve) => setTimeout(resolve, 10));

        switch (functionName) {
          case "identify_end_url":
            return responses.identify_end_url;
          case "identify_dynamic_parts":
            return responses.identify_dynamic_parts;
          case "identify_input_variables":
            return responses.identify_input_variables;
          case "get_simplest_curl_index":
            return responses.get_simplest_curl_index;
          default:
            throw new Error(`Unknown function: ${functionName}`);
        }
      }
    ),

    generateResponse: vi.fn(async (prompt: string) => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return `Mock LLM response for prompt: ${prompt.slice(0, 50)}...`;
    }),

    getModel: vi.fn(() => "gpt-4o"),
    setModel: vi.fn(),
  };
};

/**
 * Mock LLM client that simulates errors for testing error handling
 */
export const createFailingMockLLMClient = (errorMessage = "LLM API Error") => {
  return {
    // Mock the private properties that LLMClient has
    client: { apiKey: "test-api-key" } as MockOpenAIClient,
    model: "gpt-4o",

    callFunction: vi.fn().mockRejectedValue(new Error(errorMessage)),
    generateResponse: vi.fn().mockRejectedValue(new Error(errorMessage)),
    getModel: vi.fn(() => "gpt-4o"),
    setModel: vi.fn(),
  };
};

/**
 * Updates mock responses for specific test scenarios
 */
export const updateMockLLMResponse = (
  mockClient: ReturnType<typeof createMockLLMClient>,
  functionName: keyof typeof DEFAULT_MOCK_RESPONSES,
  response:
    | DynamicPartsResponse
    | InputVariablesResponse
    | URLIdentificationResponse
    | SimplestRequestResponse
) => {
  const currentImplementation = mockClient.callFunction.getMockImplementation();

  mockClient.callFunction.mockImplementation(
    // biome-ignore lint/suspicious/useAwait: Mock function must return Promise to match interface
    async (
      prompt: string,
      functionDef: FunctionDefinition,
      funcName: string
    ) => {
      if (funcName === functionName) {
        return response;
      }

      // Fall back to original implementation for other functions
      return currentImplementation?.(prompt, functionDef, funcName) ?? response;
    }
  );
};
