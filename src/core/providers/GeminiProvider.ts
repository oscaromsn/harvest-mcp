import {
  type GenerativeModel,
  GoogleGenerativeAI,
} from "@google/generative-ai";
import type { z } from "zod";
import { HarvestError } from "../../types/index.js";
import { createComponentLogger } from "../../utils/logger.js";
import type {
  CompletionOptions,
  CompletionResponse,
  FunctionDefinition,
  FunctionParameter,
  ILLMProvider,
  Message,
  ProviderConfig,
} from "./types.js";

const logger = createComponentLogger("gemini-provider");

/**
 * Google Gemini provider implementation
 */
export class GeminiProvider implements ILLMProvider {
  readonly name = "gemini";
  private client?: GoogleGenerativeAI;
  private model?: GenerativeModel;
  private config?: ProviderConfig;

  async initialize(config: ProviderConfig): Promise<void> {
    this.config = config;
    this.client = new GoogleGenerativeAI(config.apiKey);

    const modelName = config.model ?? this.getDefaultModel();
    this.model = this.client.getGenerativeModel({ model: modelName });

    logger.info({ model: modelName }, "Gemini provider initialized");
  }

  isConfigured(): boolean {
    return !!this.client && !!this.model && !!this.config?.apiKey;
  }

  getDefaultModel(): string {
    return "gemini-1.5-pro";
  }

  getSupportedModels(): string[] {
    return [
      "gemini-1.5-pro",
      "gemini-1.5-pro-latest",
      "gemini-1.5-flash",
      "gemini-1.5-flash-latest",
      "gemini-1.0-pro",
    ];
  }

  async generateCompletion(
    messages: Message[],
    options?: CompletionOptions
  ): Promise<CompletionResponse> {
    if (!this.client || !this.model) {
      throw new HarvestError(
        "Gemini provider not initialized",
        "PROVIDER_NOT_INITIALIZED"
      );
    }

    const startTime = Date.now();
    const modelName =
      options?.model ?? this.config?.model ?? this.getDefaultModel();
    logger.info({ model: modelName }, "Starting completion");

    try {
      // Use a different model if specified in options
      const model =
        options?.model && options.model !== modelName
          ? this.client.getGenerativeModel({ model: options.model })
          : this.model;

      // Configure generation settings
      const generationConfig: any = {
        temperature: options?.temperature ?? 0.7,
        ...(options?.maxTokens !== undefined && {
          maxOutputTokens: options.maxTokens,
        }),
        ...(options?.topP !== undefined && { topP: options.topP }),
      };

      // Handle function calling
      if (options?.functions && options.functions.length > 0) {
        // Create function declarations for Gemini
        const functions = options.functions.map(
          this.convertToGeminiFunctionDeclaration
        );

        const modelWithFunctions = this.client.getGenerativeModel({
          model: modelName,
          tools: [
            {
              functionDeclarations: functions,
            },
          ],
        });

        const chat = modelWithFunctions.startChat({
          history: this.convertMessagesToGeminiHistory(messages.slice(0, -1)),
          generationConfig,
        });

        // Get the last message as the current prompt
        const lastMessage = messages[messages.length - 1];
        if (!lastMessage) {
          throw new HarvestError("No messages provided", "NO_MESSAGES");
        }
        const result = await chat.sendMessage(lastMessage.content || "");

        const duration = Date.now() - startTime;
        logger.info({ duration }, "Completion successful");

        return this.parseGeminiResponse(result);
      }
      // Regular text generation without functions
      const chat = model.startChat({
        history: this.convertMessagesToGeminiHistory(messages.slice(0, -1)),
        generationConfig,
      });

      const lastMessage = messages[messages.length - 1];
      if (!lastMessage) {
        throw new HarvestError("No messages provided", "NO_MESSAGES");
      }
      const result = await chat.sendMessage(lastMessage.content || "");

      const duration = Date.now() - startTime;
      logger.info({ duration }, "Completion successful");

      return {
        content: result.response.text(),
        usage: result.response.usageMetadata
          ? {
              promptTokens: result.response.usageMetadata.promptTokenCount || 0,
              completionTokens:
                result.response.usageMetadata.candidatesTokenCount || 0,
              totalTokens: result.response.usageMetadata.totalTokenCount || 0,
            }
          : undefined,
      };
    } catch (error) {
      if (error instanceof HarvestError) {
        throw error;
      }

      throw new HarvestError(
        `Gemini completion failed: ${error instanceof Error ? error.message : "Unknown error"}`,
        "GEMINI_COMPLETION_FAILED",
        { originalError: error }
      );
    }
  }

  async callFunction<T extends z.ZodType>(
    messages: Message[],
    functionDef: FunctionDefinition,
    schema: T,
    options?: CompletionOptions
  ): Promise<z.infer<T>> {
    const startTime = Date.now();
    const maxRetries = this.config?.maxRetries ?? 3;
    let lastError: Error | null = null;

    logger.info({ functionName: functionDef.name }, "Starting function call");

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const completionOptions: CompletionOptions = {
          ...options,
          functions: [functionDef],
          temperature: 0.1, // Low temperature for consistent results
        };

        const response = await this.generateCompletion(
          messages,
          completionOptions
        );

        if (!response.functionCall) {
          throw new HarvestError(
            "No function call found in response",
            "NO_FUNCTION_CALL"
          );
        }

        if (response.functionCall.name !== functionDef.name) {
          throw new HarvestError(
            `Expected function ${functionDef.name}, got ${response.functionCall.name}`,
            "WRONG_FUNCTION_CALL"
          );
        }

        try {
          const parsedArgs = JSON.parse(
            response.functionCall.arguments || "{}"
          );
          const validatedResult = schema.parse(parsedArgs);

          const duration = Date.now() - startTime;
          logger.info({ duration, attempt }, "Function call successful");

          return validatedResult;
        } catch (error) {
          throw new HarvestError(
            "Failed to parse or validate function arguments",
            "INVALID_FUNCTION_ARGS",
            { arguments: response.functionCall.arguments, error }
          );
        }
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        if (
          error instanceof HarvestError &&
          error.code !== "GEMINI_COMPLETION_FAILED"
        ) {
          logger.error(
            { attempt, error: error.message },
            "HarvestError on attempt"
          );
          throw error; // Don't retry validation errors
        }

        logger.error(
          { attempt, maxRetries, error: lastError.message },
          "Attempt failed"
        );

        if (attempt === maxRetries) {
          break;
        }

        // Exponential backoff
        const waitTime = 2 ** (attempt - 1) * 1000;
        logger.info({ waitTime, attempt }, "Waiting before retry");
        await new Promise((resolve) => setTimeout(resolve, waitTime));
      }
    }

    throw new HarvestError(
      `Function call failed after ${maxRetries} attempts: ${lastError?.message || "Unknown error"}`,
      "FUNCTION_CALL_FAILED",
      { originalError: lastError, attempts: maxRetries }
    );
  }

  private convertMessagesToGeminiHistory(
    messages: Message[]
  ): Array<{ role: string; parts: Array<{ text: string }> }> {
    return messages.map((msg) => {
      // Gemini uses 'model' instead of 'assistant'
      const role =
        msg.role === "assistant"
          ? "model"
          : msg.role === "system"
            ? "user"
            : msg.role;

      // System messages need to be prefixed in Gemini
      let content = msg.content || "";
      if (msg.role === "system") {
        content = `System: ${content}`;
      }

      return {
        role,
        parts: [{ text: content }],
      };
    });
  }

  private convertToGeminiFunctionDeclaration(func: FunctionDefinition): any {
    const declaration: any = {
      name: func.name,
      description: func.description,
    };

    if (func.parameters) {
      declaration.parameters = {
        type: "OBJECT",
        properties: {},
        required: func.parameters.required || [],
      };

      if (func.parameters.properties) {
        for (const [key, param] of Object.entries(func.parameters.properties)) {
          declaration.parameters.properties[key] =
            this.convertParameterToGemini(param);
        }
      }
    }

    return declaration;
  }

  private convertParameterToGemini(param: FunctionParameter): any {
    const geminiParam: any = {
      type: this.mapTypeToGemini(param.type),
    };

    if (param.description) {
      geminiParam.description = param.description;
    }

    if (param.enum) {
      geminiParam.enum = param.enum;
    }

    if (param.type === "object" && param.properties) {
      geminiParam.properties = {};
      for (const [key, subParam] of Object.entries(param.properties)) {
        geminiParam.properties[key] = this.convertParameterToGemini(subParam);
      }
    }

    if (param.type === "array" && param.items) {
      geminiParam.items = this.convertParameterToGemini(param.items);
    }

    return geminiParam;
  }

  private mapTypeToGemini(type: string): string {
    switch (type) {
      case "string":
        return "STRING";
      case "number":
      case "integer":
        return "NUMBER";
      case "boolean":
        return "BOOLEAN";
      case "object":
        return "OBJECT";
      case "array":
        return "ARRAY";
      default:
        return "STRING";
    }
  }

  private parseGeminiResponse(result: any): CompletionResponse {
    const response = result.response;

    // Check for function calls
    const functionCalls = response.functionCalls();
    if (functionCalls && functionCalls.length > 0) {
      const functionCall = functionCalls[0];
      return {
        content: null,
        functionCall: {
          name: functionCall.name,
          arguments: JSON.stringify(functionCall.args),
        },
        usage: response.usageMetadata
          ? {
              promptTokens: response.usageMetadata.promptTokenCount || 0,
              completionTokens:
                response.usageMetadata.candidatesTokenCount || 0,
              totalTokens: response.usageMetadata.totalTokenCount || 0,
            }
          : undefined,
      };
    }

    // Regular text response
    return {
      content: response.text(),
      usage: response.usageMetadata
        ? {
            promptTokens: response.usageMetadata.promptTokenCount || 0,
            completionTokens: response.usageMetadata.candidatesTokenCount || 0,
            totalTokens: response.usageMetadata.totalTokenCount || 0,
          }
        : undefined,
    };
  }
}
