import type {
  Experimental_VideoModelV4 as VideoModelV4,
  Experimental_VideoModelV4CallOptions as VideoModelV4CallOptions,
  Experimental_VideoModelV4OperationStartResult as StartResult,
  Experimental_VideoModelV4OperationStatusResult as StatusResult,
  Experimental_VideoModelV4VideoData as VideoData,
  JSONValue,
  SharedV4Warning,
} from '@ai-sdk/provider';
import {
  type FetchFunction,
  combineHeaders,
  convertUint8ArrayToBase64,
  createBinaryResponseHandler,
  createJsonErrorResponseHandler,
  createJsonResponseHandler,
  createStatusCodeErrorResponseHandler,
  getFromApi,
  postJsonToApi,
  zodSchema,
} from '@ai-sdk/provider-utils';
import { z } from 'zod/v4';

/**
 * Video model ids for `experimental_generateVideo`. Any video id from
 * https://martllm.com/models works; the named ones are only for autocomplete.
 */
export type MartLLMVideoModelId =
  | 'meta-llama/muse-video'
  | 'google/gemini-omni-flash-1-1'
  | 'bytedance/seedance-2-0-fast-image-to-video'
  | 'bytedance/seedance-2-5-flash-text-to-video-turbo'
  | 'google/veo-3.1-lite'
  | 'kling/kling-2-5-turbo-pro-text-to-video'
  | 'minimax/hailuo-2-3-pro-text-to-video'
  | 'vidu/viduq3-turbo-text-to-video'
  | 'wan/wan-2-6-image-to-video'
  | (string & {});

export interface MartLLMVideoConfig {
  provider: string;
  baseURL: string;
  headers: () => Promise<Record<string, string | undefined>>;
  fetch?: FetchFunction;
  currentDate?: () => Date;
}

type VideoFile = NonNullable<VideoModelV4CallOptions['image']>;

const errorSchema = z.object({
  error: z.object({ message: z.string(), type: z.string().nullish() }).passthrough(),
});
const failedResponseHandler = createJsonErrorResponseHandler({
  errorSchema: zodSchema(errorSchema),
  errorToMessage: (e) => e.error.message,
});

const jobSchema = z
  .object({
    id: z.string(),
    status: z.string(),
    model: z.string().nullish(),
    progress: z.number().nullish(),
    estimated_cost_usd: z.number().nullish(),
    max_cost_usd: z.number().nullish(),
    results: z
      .array(
        z
          .object({
            url: z.string(),
            content_type: z.string().nullish(),
            duration_seconds: z.number().nullish(),
            width: z.number().nullish(),
            height: z.number().nullish(),
          })
          .passthrough(),
      )
      .nullish(),
    usage: z
      .object({ cost_usd: z.number().nullish(), cost_pending: z.boolean().nullish() })
      .passthrough()
      .nullish(),
    error: z.object({ message: z.string().nullish(), retryable: z.boolean().nullish() }).passthrough().nullish(),
  })
  .passthrough();
type Job = z.infer<typeof jobSchema>;
const jobResponseHandler = createJsonResponseHandler(zodSchema(jobSchema));

/** `1280x720` → `720p` (MartLLM names resolutions by their short side). */
export function toMartLLMResolution(resolution: string): string {
  const [w, h] = resolution.split('x').map(Number);
  return `${Math.min(w, h)}p`;
}

function fileToField(file: VideoFile): string {
  if (file.type === 'url') return file.url;
  const b64 = typeof file.data === 'string' ? file.data : convertUint8ArrayToBase64(file.data);
  return `data:${file.mediaType};base64,${b64}`;
}

function jobMetadata(job: Job): Record<string, JSONValue> {
  const meta: Record<string, JSONValue> = { jobId: job.id, status: job.status };
  if (job.model != null) meta.model = job.model;
  if (job.estimated_cost_usd != null) meta.estimatedCostUsd = job.estimated_cost_usd;
  if (job.max_cost_usd != null) meta.maxCostUsd = job.max_cost_usd;
  if (job.usage?.cost_usd != null) meta.costUsd = job.usage.cost_usd;
  if (job.usage?.cost_pending) meta.costPending = true;
  return meta;
}

/**
 * A MartLLM video model. Videos are jobs on MartLLM: `doStart` posts
 * `/v1/video/generations`, `doStatus` reads the job, and the AI SDK polls
 * (or waits for a callback when you pass `webhook`).
 */
export class MartLLMVideoModel implements VideoModelV4 {
  readonly specificationVersion = 'v4' as const;
  readonly maxVideosPerCall = 1;

  constructor(
    readonly modelId: MartLLMVideoModelId,
    private readonly config: MartLLMVideoConfig,
  ) {}

  get provider(): string {
    return this.config.provider;
  }

  /** MartLLM calls `callback_url` when a job ends, so the SDK can skip polling. */
  async handleWebhookOption({
    webhook,
  }: Parameters<NonNullable<VideoModelV4['handleWebhookOption']>>[0]) {
    const { url, received } = await webhook();
    return { webhookUrl: url, received };
  }

  /** The request body for `POST /v1/video/generations`, with warnings for options MartLLM has no field for. */
  getArgs(options: VideoModelV4CallOptions & { webhookUrl?: string }) {
    const warnings: SharedV4Warning[] = [];
    const body: Record<string, unknown> = { model: this.modelId };
    if (options.prompt != null) body.prompt = options.prompt;
    if (options.duration != null) body.duration_seconds = options.duration;
    if (options.aspectRatio != null) {
      body.aspect_ratio = options.aspectRatio === 'adaptive' ? 'auto' : options.aspectRatio;
    }
    if (options.resolution != null) body.resolution = toMartLLMResolution(options.resolution);
    if (options.generateAudio != null) body.audio = options.generateAudio;
    if (options.image != null) body.image_url = fileToField(options.image);
    for (const frame of options.frameImages ?? []) {
      body[frame.frameType === 'last_frame' ? 'end_image_url' : 'image_url'] = fileToField(frame.image);
    }
    const pictures: string[] = [];
    for (const ref of options.inputReferences ?? []) {
      const isVideo = (ref.mediaType ?? '').startsWith('video/');
      if (!isVideo) pictures.push(fileToField(ref));
      else if (body.video_url == null) body.video_url = fileToField(ref);
      else warnings.push({ type: 'other', message: 'MartLLM takes one source video; extra video references were dropped.' });
    }
    if (pictures.length > 0) body.input_images = pictures.map((url) => ({ url, role: 'reference' }));
    if (options.n > 1) {
      warnings.push({ type: 'unsupported', feature: 'n', details: 'MartLLM makes one video per job.' });
    }
    if (options.fps != null) warnings.push({ type: 'unsupported', feature: 'fps' });
    if (options.seed != null) {
      warnings.push({ type: 'unsupported', feature: 'seed', details: 'Pass it in providerOptions.martllm for models whose schema lists one.' });
    }
    if (options.webhookUrl != null) body.callback_url = options.webhookUrl;
    // MartLLM's own fields (models, max_cost, provider.max_price, metadata, audio_url,
    // video_url, kit, a model's own options...) go through unchanged.
    Object.assign(body, options.providerOptions?.martllm ?? {});
    return { body, warnings };
  }

  async doStart(options: VideoModelV4CallOptions & { webhookUrl?: string }): Promise<StartResult> {
    const { body, warnings } = this.getArgs(options);
    const { value: job, responseHeaders } = await postJsonToApi({
      url: `${this.config.baseURL}/video/generations`,
      headers: combineHeaders(await this.config.headers(), options.headers),
      body,
      failedResponseHandler,
      successfulResponseHandler: jobResponseHandler,
      abortSignal: options.abortSignal,
      fetch: this.config.fetch,
    });
    return {
      operation: { jobId: job.id },
      warnings,
      providerMetadata: { martllm: jobMetadata(job) },
      response: { timestamp: this.now(), modelId: job.model ?? this.modelId, headers: responseHeaders },
    };
  }

  async doStatus(options: {
    operation: JSONValue;
    abortSignal?: AbortSignal;
    headers?: Record<string, string | undefined>;
  }): Promise<StatusResult> {
    const { jobId } = options.operation as { jobId: string };
    const headers = combineHeaders(await this.config.headers(), withoutIdempotencyKey(options.headers));
    const { value: job, responseHeaders } = await getFromApi({
      url: `${this.config.baseURL}/video/generations/${encodeURIComponent(jobId)}`,
      headers,
      failedResponseHandler,
      successfulResponseHandler: jobResponseHandler,
      abortSignal: options.abortSignal,
      fetch: this.config.fetch,
    });
    const response = { timestamp: this.now(), modelId: job.model ?? this.modelId, headers: responseHeaders };
    const results = job.results ?? [];
    const providerMetadata = {
      martllm: {
        ...jobMetadata(job),
        videos: results.map((r) => ({
          url: r.url,
          ...(r.duration_seconds != null ? { durationSeconds: r.duration_seconds } : {}),
          ...(r.width != null ? { width: r.width } : {}),
          ...(r.height != null ? { height: r.height } : {}),
        })),
      },
    };

    if (job.status === 'queued' || job.status === 'running') {
      return { status: 'pending', providerMetadata, response };
    }
    if (job.status !== 'succeeded') {
      const why = job.error?.message ?? `The video job ended ${job.status}.`;
      return { status: 'error', error: `MartLLM job ${job.id}: ${why}`, providerMetadata, response };
    }
    // Result links need the API key, so the file is fetched here, not by the SDK.
    const videos: VideoData[] = await Promise.all(
      results.map(async (r) => {
        const { value } = await getFromApi({
          url: r.url,
          headers,
          // The key goes only to MartLLM, never to a host a redirect points at.
          validateUrl: true,
          trustedOrigin: this.config.baseURL,
          credentialedOrigin: this.config.baseURL,
          failedResponseHandler: createStatusCodeErrorResponseHandler(),
          successfulResponseHandler: createBinaryResponseHandler(),
          abortSignal: options.abortSignal,
          fetch: this.config.fetch,
        });
        return { type: 'binary' as const, data: value, mediaType: r.content_type ?? 'video/mp4' };
      }),
    );
    return { status: 'completed', videos, warnings: [], providerMetadata, response };
  }

  private now(): Date {
    return this.config.currentDate?.() ?? new Date();
  }
}

/** The SDK adds an Idempotency-Key for the start call; it has no meaning on reads. */
function withoutIdempotencyKey(headers?: Record<string, string | undefined>) {
  if (headers == null) return undefined;
  return Object.fromEntries(Object.entries(headers).filter(([k]) => k.toLowerCase() !== 'idempotency-key'));
}
