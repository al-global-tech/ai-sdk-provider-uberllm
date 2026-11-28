// Offline tests: every request goes to a fake fetch, nothing leaves the machine.
import { readFileSync } from 'node:fs';
import { embed, experimental_generateVideo as generateVideo, generateImage, generateText, Output, streamText } from 'ai';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createMartLLM, createUberLLM, listModels, martllm, VERSION } from '../src/index';

type Call = { url: string; headers: Record<string, string>; body: any };

function fakeFetch(respond: (call: Call) => Response) {
  const calls: Call[] = [];
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const call: Call = {
      url: String(input),
      headers,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    return respond(call);
  };
  return { fetch: fetch as typeof globalThis.fetch, calls };
}

const chatCompletion = (content: string) =>
  Response.json({
    id: 'chatcmpl-1',
    object: 'chat.completion',
    created: 1,
    model: 'deepseek/deepseek-v4-flash',
    choices: [
      { index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' },
    ],
    usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
  });

let savedKey: string | undefined;
let savedOldKey: string | undefined;
beforeEach(() => {
  savedKey = process.env.MARTLLM_API_KEY;
  savedOldKey = process.env.UBERLLM_API_KEY;
  delete process.env.MARTLLM_API_KEY;
  delete process.env.UBERLLM_API_KEY;
});
afterEach(() => {
  if (savedKey === undefined) delete process.env.MARTLLM_API_KEY;
  else process.env.MARTLLM_API_KEY = savedKey;
  if (savedOldKey === undefined) delete process.env.UBERLLM_API_KEY;
  else process.env.UBERLLM_API_KEY = savedOldKey;
});

describe('createMartLLM', () => {
  it('sends chat requests to MartLLM with the key and identifying headers', async () => {
    const { fetch, calls } = fakeFetch(() => chatCompletion('hello'));
    const p = createMartLLM({
      apiKey: 'ull_test',
      appName: 'My App',
      appUrl: 'https://example.com',
      fetch,
    });
    const { text, usage } = await generateText({
      model: p('deepseek/deepseek-v4-flash'),
      prompt: 'hi',
    });
    expect(text).toBe('hello');
    expect(usage.totalTokens).toBe(8);
    expect(calls[0].url).toBe('https://api.martllm.com/v1/chat/completions');
    expect(calls[0].headers.authorization).toBe('Bearer ull_test');
    expect(calls[0].headers['x-title']).toBe('My App');
    expect(calls[0].headers['http-referer']).toBe('https://example.com');
    expect(calls[0].body.model).toBe('deepseek/deepseek-v4-flash');
  });

  it('reads MARTLLM_API_KEY when the request is made, not at import', async () => {
    const { fetch, calls } = fakeFetch(() => chatCompletion('ok'));
    const p = createMartLLM({ fetch }); // no key yet: must not throw
    process.env.MARTLLM_API_KEY = 'ull_env';
    await generateText({ model: p('m'), prompt: 'hi' });
    expect(calls[0].headers.authorization).toBe('Bearer ull_env');
  });

  it('still reads UBERLLM_API_KEY (the old name) when MARTLLM_API_KEY is unset', async () => {
    const { fetch, calls } = fakeFetch(() => chatCompletion('ok'));
    const p = createUberLLM({ fetch });
    process.env.UBERLLM_API_KEY = 'ull_old';
    await generateText({ model: p('m'), prompt: 'hi' });
    expect(calls[0].headers.authorization).toBe('Bearer ull_old');
    process.env.MARTLLM_API_KEY = 'ull_new';
    await generateText({ model: p('m'), prompt: 'hi' });
    expect(calls[1].headers.authorization).toBe('Bearer ull_new');
  });

  it('accepts an async key function', async () => {
    const { fetch, calls } = fakeFetch(() => chatCompletion('ok'));
    const p = createMartLLM({ apiKey: async () => 'ull_fn', fetch });
    await generateText({ model: p.chatModel('m'), prompt: 'hi' });
    expect(calls[0].headers.authorization).toBe('Bearer ull_fn');
  });

  it('fails with a clear error when there is no key', async () => {
    const { fetch, calls } = fakeFetch(() => chatCompletion('ok'));
    const p = createMartLLM({ fetch });
    await expect(
      generateText({ model: p('m'), prompt: 'hi', maxRetries: 0 }),
    ).rejects.toThrow(/MARTLLM_API_KEY/);
    expect(calls).toHaveLength(0);
  });

  it('honours a custom baseURL (trailing slash removed)', async () => {
    const { fetch, calls } = fakeFetch(() => chatCompletion('ok'));
    const p = createMartLLM({ apiKey: 'k', baseURL: 'https://proxy.test/v1/', fetch });
    await generateText({ model: p.languageModel('m'), prompt: 'hi' });
    expect(calls[0].url).toBe('https://proxy.test/v1/chat/completions');
  });

  it('streams with usage included', async () => {
    const sse = [
      { choices: [{ index: 0, delta: { role: 'assistant', content: 'Hel' } }] },
      { choices: [{ index: 0, delta: { content: 'lo' }, finish_reason: 'stop' }] },
      { choices: [], usage: { prompt_tokens: 2, completion_tokens: 2, total_tokens: 4 } },
    ]
      .map((c) => `data: ${JSON.stringify({ id: 'x', created: 1, model: 'm', ...c })}\n\n`)
      .join('') + 'data: [DONE]\n\n';
    const { fetch, calls } = fakeFetch(
      () => new Response(sse, { headers: { 'content-type': 'text/event-stream' } }),
    );
    const p = createMartLLM({ apiKey: 'k', fetch });
    const result = streamText({ model: p('m'), prompt: 'hi' });
    let text = '';
    for await (const d of result.textStream) text += d;
    expect(text).toBe('Hello');
    expect((await result.usage).totalTokens).toBe(4);
    expect(calls[0].body.stream).toBe(true);
    expect(calls[0].body.stream_options).toEqual({ include_usage: true });
  });

  it('sends json_schema for structured output', async () => {
    const { fetch, calls } = fakeFetch(() => chatCompletion('{"name":"Ada","age":36}'));
    const p = createMartLLM({ apiKey: 'k', fetch });
    const { output } = await generateText({
      model: p('m'),
      output: Output.object({ schema: z.object({ name: z.string(), age: z.number() }) }),
      prompt: 'Ada is 36',
    });
    expect(output).toEqual({ name: 'Ada', age: 36 });
    expect(calls[0].body.response_format.type).toBe('json_schema');
  });

  it('passes MartLLM routing options through providerOptions.martllm', async () => {
    const { fetch, calls } = fakeFetch(() => chatCompletion('ok'));
    const p = createMartLLM({ apiKey: 'k', fetch });
    await generateText({
      model: p('m'),
      prompt: 'hi',
      providerOptions: {
        martllm: { provider: { max_price: { prompt: 0.2, completion: 0.4 } } },
      },
    });
    expect(calls[0].body.provider).toEqual({ max_price: { prompt: 0.2, completion: 0.4 } });
  });

  it('generates images through /v1/images/generations', async () => {
    const png = Buffer.from('fake-png').toString('base64');
    const { fetch, calls } = fakeFetch(() =>
      Response.json({ created: 1, data: [{ b64_json: png }] }),
    );
    const p = createMartLLM({ apiKey: 'k', fetch });
    const { image } = await generateImage({
      model: p.imageModel('black-forest-labs/flux.2-klein-4b'),
      prompt: 'a red bicycle',
      size: '1024x1024',
    });
    expect(Buffer.from(image.uint8Array).toString()).toBe('fake-png');
    expect(calls[0].url).toBe('https://api.martllm.com/v1/images/generations');
    expect(calls[0].body.model).toBe('black-forest-labs/flux.2-klein-4b');
  });

  it('embeds through /v1/embeddings', async () => {
    const { fetch, calls } = fakeFetch(() =>
      Response.json({
        object: 'list',
        data: [{ object: 'embedding', index: 0, embedding: [0.1, 0.2] }],
        model: 'openai/text-embedding-3-small',
        usage: { prompt_tokens: 1, total_tokens: 1 },
      }),
    );
    const p = createMartLLM({ apiKey: 'k', fetch });
    const { embedding } = await embed({
      model: p.embeddingModel('openai/text-embedding-3-small'),
      value: 'hello',
    });
    expect(embedding).toEqual([0.1, 0.2]);
    expect(calls[0].url).toBe('https://api.martllm.com/v1/embeddings');
    expect(calls[0].body.input).toEqual(['hello']);
  });

  it('identifies as the martllm provider', () => {
    expect(martllm('m').provider).toBe('martllm.chat');
    expect(martllm.videoModel('v').provider).toBe('martllm.video');
    expect(martllm('m').provider).toBe('martllm.chat');
    expect(martllm.specificationVersion).toBe('v4');
  });
});

describe('video', () => {
  const job = (status: string, extra: object = {}) =>
    Response.json(
      { id: 'job_1', object: 'media.job', kind: 'video', status, model: 'bytedance/seedance-1-0-lite', ...extra },
      { status: status === 'queued' || status === 'running' ? 202 : 200 },
    );
  const fastPoll = { intervalMs: 1, timeoutMs: 5_000 };

  it('starts a job, polls it, and downloads the file with the key', async () => {
    let polls = 0;
    const { fetch, calls } = fakeFetch((call) => {
      if (call.url.endsWith('/video/generations')) return job('queued', { max_cost_usd: 0.03 });
      if (call.url.endsWith('/video/generations/job_1')) {
        polls++;
        if (polls < 2) return job('running', { progress: 0.5 });
        return job('succeeded', {
          results: [{ artifact_index: 0, url: 'https://api.martllm.com/v1/media/artifacts/job_1/0', content_type: 'video/mp4', duration_seconds: 2 }],
          usage: { cost_usd: 0.0224 },
        });
      }
      if (call.url.endsWith('/media/artifacts/job_1/0')) return new Response(new Uint8Array([1, 2, 3]));
      return new Response('unexpected', { status: 500 });
    });
    const p = createMartLLM({ apiKey: 'ull_vid', fetch });
    const { video, providerMetadata } = await generateVideo({
      model: p.videoModel('bytedance/seedance-1-0-lite'),
      prompt: 'a red ball bouncing',
      duration: 2,
      aspectRatio: '16:9',
      resolution: '854x480',
      generateAudio: false,
      providerOptions: { martllm: { max_cost: 0.05, models: ['vidu/viduq3-turbo-text-to-video'] } },
      poll: fastPoll,
    });
    expect([...video.uint8Array]).toEqual([1, 2, 3]);
    expect(video.mediaType).toBe('video/mp4');
    const start = calls[0];
    expect(start.url).toBe('https://api.martllm.com/v1/video/generations');
    expect(start.headers.authorization).toBe('Bearer ull_vid');
    expect(start.headers['idempotency-key']).toMatch(/^aisdk_vid_/);
    expect(start.body).toEqual({
      model: 'bytedance/seedance-1-0-lite',
      prompt: 'a red ball bouncing',
      duration_seconds: 2,
      aspect_ratio: '16:9',
      resolution: '480p',
      audio: false,
      max_cost: 0.05,
      models: ['vidu/viduq3-turbo-text-to-video'],
    });
    const poll = calls.find((c) => c.url.endsWith('/job_1'))!;
    expect(poll.headers['idempotency-key']).toBeUndefined();
    const download = calls.at(-1)!;
    expect(download.headers.authorization).toBe('Bearer ull_vid');
    expect(providerMetadata.martllm).toMatchObject({ jobId: 'job_1', costUsd: 0.0224, status: 'succeeded' });
  });

  it('maps pictures: first/last frame and references', async () => {
    const p = createMartLLM({ apiKey: 'k' });
    const m = p.videoModel('v');
    const { body, warnings } = m.getArgs({
      prompt: 'p',
      n: 2,
      aspectRatio: 'adaptive',
      resolution: undefined,
      duration: undefined,
      fps: 24,
      seed: 7,
      image: undefined,
      frameImages: [
        { frameType: 'first_frame', image: { type: 'url', url: 'https://x.test/a.png' } },
        { frameType: 'last_frame', image: { type: 'file', mediaType: 'image/png', data: new Uint8Array([1]) } },
      ],
      inputReferences: [
        { type: 'url', url: 'https://x.test/ref.png', mediaType: 'image/png' },
        { type: 'url', url: 'https://x.test/clip.mp4', mediaType: 'video/mp4' },
      ],
      generateAudio: undefined,
      providerOptions: {},
      webhookUrl: 'https://hook.test/done',
    });
    expect(body).toEqual({
      model: 'v',
      prompt: 'p',
      aspect_ratio: 'auto',
      image_url: 'https://x.test/a.png',
      end_image_url: 'data:image/png;base64,AQ==',
      input_images: [{ url: 'https://x.test/ref.png', role: 'reference' }],
      video_url: 'https://x.test/clip.mp4',
      callback_url: 'https://hook.test/done',
    });
    expect(warnings.map((w) => ('feature' in w ? w.feature : w.type))).toEqual(['n', 'fps', 'seed']);
  });

  it('fails with the job error when the job does not succeed', async () => {
    const { fetch } = fakeFetch((call) =>
      call.url.endsWith('/video/generations')
        ? job('queued')
        : job('failed', { error: { type: 'content_refused', message: 'The prompt was refused.', retryable: false } }),
    );
    const p = createMartLLM({ apiKey: 'k', fetch });
    await expect(
      generateVideo({ model: p.videoModel('v'), prompt: 'x', poll: fastPoll, maxRetries: 0 }),
    ).rejects.toThrow(/job_1: The prompt was refused/);
  });

  it('turns an API error into an APICallError with the message', async () => {
    const { fetch } = fakeFetch(() =>
      Response.json({ error: { type: 'insufficient_balance', message: 'Add credit to make this video.' } }, { status: 402 }),
    );
    const p = createMartLLM({ apiKey: 'k', fetch });
    await expect(
      generateVideo({ model: p.videoModel('v'), prompt: 'x', poll: fastPoll, maxRetries: 0 }),
    ).rejects.toThrow(/Add credit/);
  });

  it('never sends the key to another host', async () => {
    const { fetch, calls } = fakeFetch((call) => {
      if (call.url.endsWith('/video/generations')) return job('queued');
      if (call.url.endsWith('/job_1'))
        return job('succeeded', { results: [{ url: 'https://elsewhere.test/v.mp4', content_type: 'video/mp4' }] });
      return new Response(new Uint8Array([9]));
    });
    const p = createMartLLM({ apiKey: 'ull_secret', fetch });
    await generateVideo({ model: p.videoModel('v'), prompt: 'x', poll: fastPoll });
    expect(calls.at(-1)!.url).toBe('https://elsewhere.test/v.mp4');
    expect(calls.at(-1)!.headers.authorization).toBeUndefined();
  });
});

describe('listModels', () => {
  it('fetches chat models by default and other types on request', async () => {
    const { fetch, calls } = fakeFetch(() =>
      Response.json({ data: [{ id: 'deepseek/deepseek-v4-flash' }] }),
    );
    expect(await listModels({ fetch })).toEqual([{ id: 'deepseek/deepseek-v4-flash' }]);
    expect(calls[0].url).toBe('https://api.martllm.com/v1/models');
    expect(calls[0].headers.authorization).toBeUndefined();
    await listModels({ fetch, type: 'image', apiKey: 'k' });
    expect(calls[1].url).toBe('https://api.martllm.com/v1/models?type=image');
    expect(calls[1].headers.authorization).toBe('Bearer k');
  });

  it('throws on an error status', async () => {
    const { fetch } = fakeFetch(() => new Response('nope', { status: 500 }));
    await expect(listModels({ fetch })).rejects.toThrow(/500/);
  });
});

it('VERSION matches package.json', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  expect(VERSION).toBe(pkg.version);
});
