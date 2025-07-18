import { HarvestError } from "../../types/index.js";
import { createComponentLogger } from "../../utils/logger.js";
import { GeminiProvider } from "./GeminiProvider.js";
import { OpenAIProvider } from "./OpenAIProvider.js";
import type {
  ILLMProvider,
  ProviderConfig,
  ProviderRegistryEntry,
} from "./types.js";

const logger = createComponentLogger("provider-factory");

/**
 * Registry of available LLM providers
 */
const PROVIDER_REGISTRY: Record<string, ProviderRegistryEntry> = {
  openai: {
    name: "openai",
    factory: async (config) => {
      const provider = new OpenAIProvider();
      await provider.initialize(config);
      return provider;
    },
    requiredEnvVar: "OPENAI_API_KEY",
    defaultModel: "gpt-4o",
  },
  gemini: {
    name: "gemini",
    factory: async (config) => {
      const provider = new GeminiProvider();
      await provider.initialize(config);
      return provider;
    },
    requiredEnvVar: "GOOGLE_API_KEY",
    defaultModel: "gemini-1.5-pro",
  },
};

/**
 * Factory for creating LLM provider instances
 */
export class ProviderFactory {
  /**
   * Create a provider instance based on the specified provider name
   */
  static async createProvider(
    providerName: string,
    config?: Partial<ProviderConfig>
  ): Promise<ILLMProvider> {
    const entry = PROVIDER_REGISTRY[providerName.toLowerCase()];

    if (!entry) {
      const availableProviders = Object.keys(PROVIDER_REGISTRY).join(", ");
      throw new HarvestError(
        `Unknown provider: ${providerName}. Available providers: ${availableProviders}`,
        "UNKNOWN_PROVIDER"
      );
    }

    // Get API key from config or environment
    const apiKey = config?.apiKey || process.env[entry.requiredEnvVar];

    if (!apiKey) {
      throw new HarvestError(
        `${entry.requiredEnvVar} environment variable is required for ${providerName} provider`,
        "MISSING_API_KEY"
      );
    }

    // Merge config with defaults
    const fullConfig: ProviderConfig = {
      apiKey,
      model: config?.model || entry.defaultModel,
      ...(config?.baseUrl !== undefined && { baseUrl: config.baseUrl }),
      ...(config?.timeout !== undefined && { timeout: config.timeout }),
      ...(config?.maxRetries !== undefined && {
        maxRetries: config.maxRetries,
      }),
    };

    logger.info(
      { provider: providerName, model: fullConfig.model },
      "Creating provider instance"
    );

    try {
      return await entry.factory(fullConfig);
    } catch (error) {
      throw new HarvestError(
        `Failed to create ${providerName} provider: ${error instanceof Error ? error.message : "Unknown error"}`,
        "PROVIDER_CREATION_FAILED",
        { originalError: error }
      );
    }
  }

  /**
   * Get the default provider based on environment configuration
   */
  static async getDefaultProvider(
    config?: Partial<ProviderConfig>
  ): Promise<ILLMProvider> {
    // Check LLM_PROVIDER environment variable first
    const envProvider = process.env.LLM_PROVIDER;
    if (envProvider) {
      logger.info(
        { provider: envProvider },
        "Using provider from LLM_PROVIDER env var"
      );
      return ProviderFactory.createProvider(envProvider, config);
    }

    // Fall back to checking which API keys are available
    if (process.env.OPENAI_API_KEY) {
      logger.info("Using OpenAI provider (OPENAI_API_KEY found)");
      return ProviderFactory.createProvider("openai", config);
    }

    if (process.env.GOOGLE_API_KEY) {
      logger.info("Using Gemini provider (GOOGLE_API_KEY found)");
      return ProviderFactory.createProvider("gemini", config);
    }

    throw new HarvestError(
      "No LLM provider configured. Set LLM_PROVIDER env var or provide OPENAI_API_KEY or GOOGLE_API_KEY",
      "NO_PROVIDER_CONFIGURED"
    );
  }

  /**
   * List available providers
   */
  static getAvailableProviders(): string[] {
    return Object.keys(PROVIDER_REGISTRY);
  }

  /**
   * Check if a provider is available
   */
  static isProviderAvailable(providerName: string): boolean {
    return providerName.toLowerCase() in PROVIDER_REGISTRY;
  }

  /**
   * Get provider information
   */
  static getProviderInfo(
    providerName: string
  ): ProviderRegistryEntry | undefined {
    return PROVIDER_REGISTRY[providerName.toLowerCase()];
  }

  /**
   * Register a custom provider
   */
  static registerProvider(entry: ProviderRegistryEntry): void {
    if (PROVIDER_REGISTRY[entry.name.toLowerCase()]) {
      logger.warn(
        { provider: entry.name },
        "Overwriting existing provider registration"
      );
    }

    PROVIDER_REGISTRY[entry.name.toLowerCase()] = entry;
    logger.info({ provider: entry.name }, "Provider registered");
  }
}
