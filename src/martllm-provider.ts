import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import {
  type ImageModelV4,
  type LanguageModelV4,
  NoSuchModelError,
  type ProviderV4,
} from '@ai-sdk/provider';
import {
  type FetchFunction,
  type Resolvable,
  loadApiKey,
  resolve,
  withoutTrailingSlash,
} from '@ai-sdk/provider-utils';

export const MARTLLM_BASE_URL = 'https://api.martllm.com/v1';

/**
 * Chat model ids. Any id from https://martllm.com/models works; the named
 * ones are only for editor autocomplete.
 */
export type MartLLMChatModelId =
  | 'deepseek/deepseek-v4-flash'
  | 'deepseek/deepseek-v4.1-flash'
  | 'anthropic/claude-opus-5.5'
  | 'anthropic/claude-sonnet-5.5'
  | 'anthropic/claude-haiku-4.5'
  | 'openai/gpt-5.5'
  | 'google/gemini-3.5-flash'
  | 'google/gemini-3.1-flash-lite'
  | 'google/gemini-3.1-pro'
  | 'z-ai/glm-5.3-flash'
  | 'moonshotai/kimi-k3'
  | (string & {});

/**
 * Image model ids for `generateImage`. Any image id from
 * https://martllm.com/models that takes /v1/images/generations works.
 */
export type MartLLMImageModelId =
  | 'black-forest-labs/flux.2-klein-4b'
  | 'black-forest-labs/flux.2-flex'
  | 'bytedance/seedream-4.5'
  | 'google/imagen-4'
  | 'google/imagen-4-fast'
  | 'venice/z-image-turbo'
  | (string & {});

export interface MartLLMProviderSettings {
  /**
   * MartLLM API key (`ull_...`). Defaults to the `MARTLLM_API_KEY`
   * environment variable. A function is called before each request and may
   * return a promise.
   */
  apiKey?: Resolvable<string | undefined>;

  /**
   * Base URL for API calls. Defaults to `https://api.martllm.com/v1`.
   */
  baseURL?: string;

  /**
   * Your app's name, sent as `X-Title`. Apps that send it can be listed on
   * https://martllm.com/apps.
   */
  appName?: string;

  /**
   * Your app's URL, sent as `HTTP-Referer`.
   */
  appUrl?: string;

  /**
   * Extra headers sent with every request.
   */
  headers?: Record<string, string>;

  /**
   * Send `response_format: json_schema` for structured output
   * (`Output.object`, `generateObject`). Defaults to `true`. Set `false` for a
   * model that only takes `json_object`.
   */
  supportsStructuredOutputs?: boolean;

  /**
   * Custom fetch implementation, for middleware or tests.
   */
  fetch?: FetchFunction;
}

export interface MartLLMProvider extends ProviderV4 {
  /** A chat model (`/v1/chat/completions`). */
  (modelId: MartLLMChatModelId): LanguageModelV4;

  /** A chat model (`/v1/chat/completions`). */
  languageModel(modelId: MartLLMChatModelId): LanguageModelV4;

  /** A chat model (`/v1/chat/completions`). */
  chatModel(modelId: MartLLMChatModelId): LanguageModelV4;

  /** An image model (`/v1/images/generations`), for `generateImage`. */
  imageModel(modelId: MartLLMImageModelId): ImageModelV4;

  /** MartLLM has no embeddings endpoint; this always throws. */
  embeddingModel(modelId: string): never;

  /** @deprecated Use `embeddingModel` instead. Always throws. */
  textEmbeddingModel(modelId: string): never;
}

/**
 * Create a MartLLM provider for the Vercel AI SDK.
 *
 * ```ts
 * import { createMartLLM } from 'ai-sdk-provider-martllm';
 * const martllm = createMartLLM({ apiKey: process.env.MARTLLM_API_KEY });
 * ```
 */
/** UBERLLM_API_KEY (the name before the rename), only when MARTLLM_API_KEY is unset. */
function oldEnvKey(): string | undefined {
  if (typeof process === 'undefined') return undefined;
  return process.env?.MARTLLM_API_KEY ? undefined : process.env?.UBERLLM_API_KEY || undefined;
}

export function createMartLLM(
  options: MartLLMProviderSettings = {},
): MartLLMProvider {
  const baseURL =
    withoutTrailingSlash(options.baseURL ?? MARTLLM_BASE_URL) ??
    MARTLLM_BASE_URL;

  const headers: Record<string, string> = {
    ...(options.appName ? { 'X-Title': options.appName } : {}),
    ...(options.appUrl ? { 'HTTP-Referer': options.appUrl } : {}),
    ...options.headers,
  };

  const base = createOpenAICompatible<
    MartLLMChatModelId,
    string,
    string,
    MartLLMImageModelId
  >({
    name: 'martllm',
    baseURL,
    // Read lazily, so importing the default instance never throws.
    apiKey: async () =>
      loadApiKey({
        apiKey: (await resolve(options.apiKey)) ?? oldEnvKey(),
        environmentVariableName: 'MARTLLM_API_KEY',
        description: 'MartLLM',
      }),
    headers,
    includeUsage: true,
    supportsStructuredOutputs: options.supportsStructuredOutputs ?? true,
    fetch: options.fetch,
  });

  const noEmbeddings = (modelId: string): never => {
    throw new NoSuchModelError({
      modelId,
      modelType: 'embeddingModel',
      message: 'MartLLM has no embeddings endpoint.',
    });
  };

  const provider = ((modelId: MartLLMChatModelId) =>
    base.chatModel(modelId)) as MartLLMProvider;
  (provider as { specificationVersion: 'v4' }).specificationVersion = 'v4';
  provider.languageModel = (modelId) => base.chatModel(modelId);
  provider.chatModel = (modelId) => base.chatModel(modelId);
  provider.imageModel = (modelId) => base.imageModel(modelId);
  provider.embeddingModel = noEmbeddings;
  provider.textEmbeddingModel = noEmbeddings;
  return provider;
}

/**
 * Default MartLLM provider. Reads the key from `MARTLLM_API_KEY` when a
 * request is made.
 */
export const martllm = createMartLLM();

/** Old names (MartLLM was called UberLLM until November 2026). */
export const createUberLLM = createMartLLM;
export const uberllm = martllm;
