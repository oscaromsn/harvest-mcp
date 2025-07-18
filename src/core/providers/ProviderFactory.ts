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
 * Create a provider instance based on the specified provider name
 */
export async function createProvider(
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
      `${entry.requiredEnvVar} is required for ${providerName} provider`,
      "MISSING_API_KEY",
      {
        provider: providerName,
        requiredEnvVar: entry.requiredEnvVar,
        setupInstructions: {
          quickFix: [
            "Pass API key directly to tool:",
            `• ..., ${providerName === "openai" ? "openaiApiKey" : "googleApiKey"}: 'your-key'`,
          ],
          environmentVariable: [
            "Set environment variable:",
            `• export ${entry.requiredEnvVar}=your-${providerName}-key`,
          ],
          getApiKey: [
            "Get API key from:",
            `• ${
              providerName === "openai"
                ? "https://platform.openai.com/account/api-keys"
                : "https://makersuite.google.com/app/apikey"
            }`,
          ],
        },
        nextActions: [
          `1. Get ${providerName.toUpperCase()} API key from the URL above`,
          `2. Set ${entry.requiredEnvVar} environment variable`,
          "3. Or pass API key as tool parameter",
          "4. Run system_config_validate to verify setup",
        ],
      }
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
 * Now supports API keys passed as parameters for client-side configuration
 */
export async function getDefaultProvider(
  config?: Partial<ProviderConfig> & {
    openaiApiKey?: string;
    googleApiKey?: string;
    provider?: string;
  }
): Promise<ILLMProvider> {
  // Check for provider passed as parameter first
  const paramProvider = config?.provider;
  if (paramProvider) {
    logger.info({ provider: paramProvider }, "Using provider from parameter");
    return createProvider(paramProvider, config);
  }

  // Check LLM_PROVIDER environment variable
  const envProvider = process.env.LLM_PROVIDER;
  if (envProvider) {
    logger.info(
      { provider: envProvider },
      "Using provider from LLM_PROVIDER env var"
    );
    return createProvider(envProvider, config);
  }

  // Check for API keys in parameters first, then environment
  const openaiKey = config?.openaiApiKey || process.env.OPENAI_API_KEY;
  const googleKey = config?.googleApiKey || process.env.GOOGLE_API_KEY;

  if (openaiKey) {
    logger.info("Using OpenAI provider (API key available)");
    return createProvider("openai", { ...config, apiKey: openaiKey });
  }

  if (googleKey) {
    logger.info("Using Gemini provider (API key available)");
    return createProvider("gemini", { ...config, apiKey: googleKey });
  }

  throw new HarvestError(
    "No LLM provider configured. AI-powered analysis features require API key configuration.",
    "NO_PROVIDER_CONFIGURED",
    {
      setupInstructions: {
        quickFix: [
          "Pass API keys directly to tools:",
          "• workflow_analyze_har(..., openaiApiKey: 'your-key')",
          "• analysis_run_initial_analysis(..., provider: 'openai')",
        ],
        environmentVariables: [
          "Set environment variables:",
          "• export OPENAI_API_KEY=your-openai-key",
          "• export GOOGLE_API_KEY=your-google-key",
          "• export LLM_PROVIDER=openai",
        ],
        mcpClientConfig: [
          "Add to MCP client configuration:",
          '{\n  "mcpServers": {\n    "harvest-mcp": {\n      "env": {\n        "OPENAI_API_KEY": "your-key"\n      }\n    }\n  }\n}',
        ],
      },
      apiKeyUrls: {
        openai: "https://platform.openai.com/account/api-keys",
        google: "https://makersuite.google.com/app/apikey",
      },
      nextActions: [
        "1. Run system_config_validate tool to diagnose configuration issues",
        "2. Get API key from OpenAI or Google AI Studio",
        "3. Configure using one of the methods above",
        "4. Test with workflow_analyze_har tool",
      ],
    }
  );
}

/**
 * List available providers
 */
export function getAvailableProviders(): string[] {
  return Object.keys(PROVIDER_REGISTRY);
}

/**
 * Check if a provider is available
 */
export function isProviderAvailable(providerName: string): boolean {
  return providerName.toLowerCase() in PROVIDER_REGISTRY;
}

/**
 * Get provider information
 */
export function getProviderInfo(
  providerName: string
): ProviderRegistryEntry | undefined {
  return PROVIDER_REGISTRY[providerName.toLowerCase()];
}

/**
 * Register a custom provider
 */
export function registerProvider(entry: ProviderRegistryEntry): void {
  if (PROVIDER_REGISTRY[entry.name.toLowerCase()]) {
    logger.warn(
      { provider: entry.name },
      "Overwriting existing provider registration"
    );
  }

  PROVIDER_REGISTRY[entry.name.toLowerCase()] = entry;
  logger.info({ provider: entry.name }, "Provider registered");
}

/**
 * Validate configuration status and provide setup guidance
 * This function checks environment variables and provides detailed configuration status
 */
export function validateConfiguration(): {
  isConfigured: boolean;
  availableProviders: string[];
  configuredProviders: string[];
  recommendations: string[];
  warnings: string[];
} {
  const envProvider = process.env.LLM_PROVIDER;
  const hasOpenAI = !!process.env.OPENAI_API_KEY;
  const hasGemini = !!process.env.GOOGLE_API_KEY;

  const availableProviders = getAvailableProviders();
  const configuredProviders: string[] = [];
  const recommendations: string[] = [];
  const warnings: string[] = [];

  // Check which providers are configured
  if (hasOpenAI) {
    configuredProviders.push("openai");
  }
  if (hasGemini) {
    configuredProviders.push("gemini");
  }

  // Check if any provider is configured
  const isConfigured = configuredProviders.length > 0;

  // Generate recommendations
  if (isConfigured) {
    // Check if explicit provider is set but unavailable
    if (
      envProvider &&
      !configuredProviders.includes(envProvider.toLowerCase())
    ) {
      warnings.push(
        `LLM_PROVIDER is set to '${envProvider}' but ${getProviderInfo(envProvider)?.requiredEnvVar} is not configured`
      );
    }

    // Provide info about configured providers
    if (configuredProviders.length > 1) {
      recommendations.push(
        `Multiple providers configured: ${configuredProviders.join(", ")}. ` +
          "Set LLM_PROVIDER to explicitly choose one."
      );
    }
  } else {
    recommendations.push(
      "No LLM provider is configured. To enable AI-powered analysis features:"
    );
    recommendations.push(
      "1. Set OPENAI_API_KEY environment variable (get key from https://platform.openai.com/account/api-keys)"
    );
    recommendations.push(
      "2. Or set GOOGLE_API_KEY environment variable (get key from https://makersuite.google.com/app/apikey)"
    );
    recommendations.push(
      "3. Optionally set LLM_PROVIDER to 'openai' or 'gemini' to explicitly choose provider"
    );
    recommendations.push(
      "4. For MCP clients, add environment variables to your client configuration"
    );
  }

  return {
    isConfigured,
    availableProviders,
    configuredProviders,
    recommendations,
    warnings,
  };
}
