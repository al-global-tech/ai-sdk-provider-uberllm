import { type FetchFunction, withoutTrailingSlash } from '@ai-sdk/provider-utils';
import { MARTLLM_BASE_URL } from './martllm-provider';

export interface MartLLMModelPricing {
  /** USD per 1M input tokens (chat models). */
  input_usd?: number;
  /** USD per 1M output tokens (chat models). */
  output_usd?: number;
  /** Official list price for the same model, when known. */
  list_input_usd?: number;
  list_output_usd?: number;
  /** USD per unit for media models (see `unit`). */
  usd?: number;
  list_usd?: number;
  unit?: string;
  [key: string]: unknown;
}

export interface MartLLMModel {
  id: string;
  type?: string;
  display_name?: string;
  context_length?: number;
  max_output_tokens?: number;
  endpoints?: string[];
  supports_tools?: boolean;
  supports_vision?: boolean;
  supports_reasoning?: boolean;
  available?: boolean;
  pricing?: MartLLMModelPricing;
  [key: string]: unknown;
}

export interface ListModelsOptions {
  /**
   * `chat` (default), `image`, `video`, `music`, `speech`, `transcription`,
   * `embedding` or `all`.
   */
  type?: 'chat' | 'image' | 'video' | 'music' | 'speech' | 'transcription' | 'embedding' | 'all';
  /**
   * Defaults to `MARTLLM_API_KEY` if set. Chat, image and video lists are
   * public; the embedding list needs a key.
   */
  apiKey?: string;
  baseURL?: string;
  fetch?: FetchFunction;
  signal?: AbortSignal;
}

/**
 * The live MartLLM model catalog (`GET /v1/models`), with prices.
 * Same data as https://martllm.com/models.
 */
export async function listModels(
  options: ListModelsOptions = {},
): Promise<MartLLMModel[]> {
  const baseURL = withoutTrailingSlash(options.baseURL ?? MARTLLM_BASE_URL);
  const url = new URL(`${baseURL}/models`);
  if (options.type && options.type !== 'chat') {
    url.searchParams.set('type', options.type);
  }
  const key =
    options.apiKey ??
    (typeof process !== 'undefined' ? process.env?.MARTLLM_API_KEY || process.env?.UBERLLM_API_KEY : undefined);
  const doFetch = options.fetch ?? globalThis.fetch;
  const res = await doFetch(url.toString(), {
    headers: key ? { Authorization: `Bearer ${key}` } : {},
    signal: options.signal,
  });
  if (!res.ok) {
    throw new Error(
      `MartLLM GET /v1/models failed: ${res.status} ${await res.text()}`,
    );
  }
  const body = (await res.json()) as { data?: MartLLMModel[] };
  return body.data ?? [];
}
