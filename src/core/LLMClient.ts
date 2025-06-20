import OpenAI from "openai";
import type {
  ChatCompletionCreateParams,
  ChatCompletionMessageParam,
} from "openai/resources/chat/completions";
import type { FunctionDefinition } from "openai/resources/shared";
import { HarvestError } from "../types/index.js";

/**
 * Client for OpenAI API integration with function calling support
 * Used for intelligent analysis of HAR data and dependency resolution
 */
export class LLMClient {
  private client: OpenAI;
  private model: string;

  constructor(model = "gpt-4o") {
    if (!process.env.OPENAI_API_KEY) {
      throw new HarvestError(
        "OPENAI_API_KEY environment variable is required",
        "MISSING_API_KEY"
      );
    }

    this.model = model;
    this.client = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
    });
  }

  /**
   * Call OpenAI with function calling to extract structured data
   */
  async callFunction<T>(
    prompt: string,
    functionDef: FunctionDefinition,
    functionName: string,
    messages?: ChatCompletionMessageParam[]
  ): Promise<T> {
    const startTime = Date.now();
    const maxRetries = 3;
    let lastError: Error | null = null;

    console.error(`[LLM] Starting function call: ${functionName}`);

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const allMessages: ChatCompletionMessageParam[] = messages || [
          { role: "user", content: prompt },
        ];

        const params: ChatCompletionCreateParams = {
          model: this.model,
          messages: allMessages,
          functions: [functionDef],
          function_call: { name: functionName },
          temperature: 0.1, // Low temperature for more consistent results
        };

        console.error(
          `[LLM] Attempt ${attempt}/${maxRetries} - Calling ${this.model} with function: ${functionName}`
        );
        const response = await this.client.chat.completions.create(params);

        const duration = Date.now() - startTime;
        console.error(
          `[LLM] Function call successful in ${duration}ms (attempt ${attempt})`
        );

        const choice = response.choices[0];
        if (!choice?.message?.function_call) {
          throw new HarvestError(
            "No function call found in LLM response",
            "NO_FUNCTION_CALL"
          );
        }

        const functionCall = choice.message.function_call;
        if (functionCall.name !== functionName) {
          throw new HarvestError(
            `Expected function ${functionName}, got ${functionCall.name}`,
            "WRONG_FUNCTION_CALL"
          );
        }

        try {
          const result = JSON.parse(functionCall.arguments || "{}") as T;
          console.error(
            `[LLM] Successfully parsed function result for ${functionName}`
          );
          return result;
        } catch (error) {
          throw new HarvestError(
            "Failed to parse function call arguments",
            "INVALID_FUNCTION_ARGS",
            { arguments: functionCall.arguments, error }
          );
        }
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        if (error instanceof HarvestError) {
          console.error(
            `[LLM] HarvestError on attempt ${attempt}: ${error.message}`
          );
          throw error; // Don't retry HarvestErrors
        }

        console.error(
          `[LLM] Attempt ${attempt}/${maxRetries} failed: ${lastError.message}`
        );

        if (attempt === maxRetries) {
          break; // Don't wait after the last attempt
        }

        // Wait before retrying (exponential backoff)
        const waitTime = 2 ** (attempt - 1) * 1000; // 1s, 2s, 4s
        console.error(`[LLM] Waiting ${waitTime}ms before retry...`);
        await new Promise((resolve) => setTimeout(resolve, waitTime));
      }
    }

    // All retries failed
    const totalTime = Date.now() - startTime;
    console.error(
      `[LLM] All attempts failed for ${functionName} after ${totalTime}ms`
    );

    throw new HarvestError(
      `LLM function call failed after ${maxRetries} attempts: ${lastError?.message || "Unknown error"}`,
      "LLM_CALL_FAILED",
      { originalError: lastError, attempts: maxRetries }
    );
  }

  /**
   * Generate a text response without function calling
   */
  async generateResponse(
    prompt: string,
    messages?: ChatCompletionMessageParam[],
    temperature = 0.7
  ): Promise<string> {
    const startTime = Date.now();
    console.error(`[LLM] Starting text generation with ${this.model}`);

    try {
      const allMessages: ChatCompletionMessageParam[] = messages || [
        { role: "user", content: prompt },
      ];

      const params: ChatCompletionCreateParams = {
        model: this.model,
        messages: allMessages,
        temperature,
      };

      const response = await this.client.chat.completions.create(params);

      const duration = Date.now() - startTime;
      console.error(`[LLM] Text generation completed in ${duration}ms`);

      const choice = response.choices[0];
      if (!choice?.message?.content) {
        throw new HarvestError(
          "No content found in LLM response",
          "NO_RESPONSE_CONTENT"
        );
      }

      return choice.message.content;
    } catch (error) {
      if (error instanceof HarvestError) {
        throw error;
      }

      throw new HarvestError(
        `LLM response generation failed: ${error instanceof Error ? error.message : "Unknown error"}`,
        "LLM_GENERATION_FAILED",
        { originalError: error }
      );
    }
  }

  /**
   * Get the current model name
   */
  getModel(): string {
    return this.model;
  }

  /**
   * Set a new model
   */
  setModel(model: string): void {
    this.model = model;
  }
}

/**
 * Singleton instance for global access
 */
let instance: LLMClient | null = null;

export function getLLMClient(): LLMClient {
  if (!instance) {
    instance = new LLMClient();
  }
  return instance;
}

export function setLLMClient(client: LLMClient): void {
  instance = client;
}

export function resetLLMClient(): void {
  instance = null;
}
