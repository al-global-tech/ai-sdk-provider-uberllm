# @martllm/ai-sdk-provider

The [MartLLM](https://martllm.com) provider for the [Vercel AI SDK](https://ai-sdk.dev).
One API key reaches the chat, embedding, image and video models on MartLLM:
`generateText`, `streamText`, tool calls, structured output, `embed`,
`generateImage` and `experimental_generateVideo`.

- Models and live prices: <https://martllm.com/models>
- Docs: <https://martllm.com/docs/ai-sdk>
- Get a key: <https://martllm.com/dashboard/keys> (prepaid credit; a failed request is not billed)

Chat, embeddings and images are built on the official `@ai-sdk/openai-compatible`
provider. Video uses the AI SDK's start/status video interface: the SDK starts a
MartLLM video job, polls it (or waits for a callback) and hands you the file.

## Install

```sh
npm i @martllm/ai-sdk-provider ai zod
```

Requires `ai` 7 and Node.js 22 or later (ESM).

## Set your key

```sh
export MARTLLM_API_KEY="ull_..."
```

The key is read when a request is made, so importing the provider never throws.
To pass it yourself:

```ts
import { createMartLLM } from '@martllm/ai-sdk-provider';

const martllm = createMartLLM({ apiKey: process.env.MARTLLM_API_KEY });
```

## Generate text

```ts
import { martllm } from '@martllm/ai-sdk-provider';
import { generateText } from 'ai';

const { text, usage } = await generateText({
  model: martllm('deepseek/deepseek-v4-flash'),
  prompt: 'Say hello in five words.',
});
```

Any chat model id from <https://martllm.com/models> works, for example
`anthropic/claude-sonnet-5.5`, `google/gemini-3.5-flash` or `moonshotai/kimi-k3`.
`usage.raw.cost_usd` is what the call cost, in US dollars.

## Stream

```ts
import { streamText } from 'ai';

const result = streamText({
  model: martllm('deepseek/deepseek-v4-flash'),
  prompt: 'Count from 1 to 5.',
});
for await (const delta of result.textStream) process.stdout.write(delta);
console.log(await result.usage); // token usage comes with streamed replies too
```

## Tools

```ts
import { generateText, stepCountIs, tool } from 'ai';
import { z } from 'zod';

const { text } = await generateText({
  model: martllm('deepseek/deepseek-v4-flash'),
  tools: {
    weather: tool({
      description: 'Get the current temperature in a city, in Celsius',
      inputSchema: z.object({ city: z.string() }),
      execute: async ({ city }) => ({ city, celsius: 21 }),
    }),
  },
  stopWhen: stepCountIs(3),
  prompt: 'What is the temperature in Paris right now?',
});
```

## Structured output

JSON-schema output is on by default (`supportsStructuredOutputs: true`):

```ts
import { generateText, Output } from 'ai';
import { z } from 'zod';

const { output } = await generateText({
  model: martllm('google/gemini-3.1-flash-lite'),
  output: Output.object({ schema: z.object({ name: z.string(), age: z.number() }) }),
  prompt: 'Ada is 36 years old. Extract the person.',
});
```

Set `createMartLLM({ supportsStructuredOutputs: false })` for a model that only
takes `json_object`.

## Embeddings

```ts
import { embed, embedMany } from 'ai';

const { embedding } = await embed({
  model: martllm.embeddingModel('openai/text-embedding-3-small'),
  value: 'sunny day at the beach',
});
```

`GET https://api.martllm.com/v1/models?type=embedding` (with your key) lists every
embedding model.

## Images

```ts
import { generateImage } from 'ai';

const { image } = await generateImage({
  model: martllm.imageModel('venice/z-image-turbo'),
  prompt: 'A red bicycle on a white background',
  size: '1024x1024',
});
// image.uint8Array holds the picture
```

To edit a picture, use an editing model and pass the source picture:

```ts
const { image } = await generateImage({
  model: martllm.imageModel('venice/gpt-image-2-edit'),
  prompt: { text: 'Make the sky a sunset', images: [sourcePngBytes] },
});
```

## Video

```ts
import { experimental_generateVideo as generateVideo } from 'ai';

const { video, providerMetadata } = await generateVideo({
  model: martllm.videoModel('meta-llama/muse-video'),
  prompt: 'A red ball bouncing on green grass',
  duration: 5,
  resolution: '1280x720', // sent as 720p
  aspectRatio: '16:9',
  generateAudio: true,
  poll: { intervalMs: 5_000, timeoutMs: 600_000 },
});
// video.uint8Array holds the MP4
console.log(providerMetadata.martllm); // jobId, model, costUsd, videos[].url
```

How the AI SDK options map to a MartLLM video job (`POST /v1/video/generations`):

| AI SDK | MartLLM |
| --- | --- |
| `prompt` | `prompt` |
| `duration` | `duration_seconds` |
| `resolution` (`1280x720`) | `resolution` (`720p`, the short side) |
| `aspectRatio` (`'adaptive'` = `auto`) | `aspect_ratio` |
| `generateAudio` | `audio` |
| `prompt: { image, text }` or a `first_frame` in `frameImages` | `image_url` (and `prompt`) |
| a `last_frame` in `frameImages` | `end_image_url` |
| picture `inputReferences` | `input_images` (role `reference`) |
| a video in `inputReferences` | `video_url` |
| `webhook` | `callback_url` (the SDK waits for the callback instead of polling) |

Each model takes its own clip lengths, resolutions and shapes;
`GET https://api.martllm.com/v1/models/<model id>` lists them. A request a model
can't make is refused before anything is charged, with a message that says what
it takes. `seed` and `fps` have no MartLLM field and come back as warnings.

Anything else MartLLM takes goes in `providerOptions.martllm` and is sent as is:
backup models, a price cap, a talking-avatar recording, tags:

```ts
await generateVideo({
  model: martllm.videoModel('bytedance/seedance-2-0-fast-image-to-video'),
  prompt: { image: 'https://example.com/first-frame.png', text: 'Slow push-in as the waves roll' },
  providerOptions: {
    martllm: {
      models: ['kling/kling-2-5-turbo-pro-image-to-video'], // tried only if the first can't be served
      max_cost: 1.5, // US dollars; a request that can cost more is refused
      metadata: { feature: 'onboarding-video' },
    },
  },
});
```

The SDK sends an `Idempotency-Key` with each start, so a retried start never
makes (or bills) a second video.

## Settings

```ts
createMartLLM({
  apiKey: '...', // default: MARTLLM_API_KEY
  baseURL: 'https://api.martllm.com/v1', // default
  appName: 'My App', // sent as X-Title
  appUrl: 'https://example.com', // sent as HTTP-Referer
  headers: { 'X-Custom': '1' },
  supportsStructuredOutputs: true, // default
  fetch: customFetch,
});
```

## Cap what a chat request can cost

```ts
await generateText({
  model: martllm('deepseek/deepseek-v4-flash'),
  prompt: 'Hi',
  providerOptions: {
    martllm: { provider: { max_price: { prompt: 0.2, completion: 0.4 } } }, // USD per 1M tokens
  },
});
```

## List models and prices

```ts
import { listModels } from '@martllm/ai-sdk-provider';

const chat = await listModels(); // chat models
const videos = await listModels({ type: 'video' });
```

Same data as <https://martllm.com/models>.

## Development

```sh
npm install
npm test            # offline unit tests (fake fetch)
npm run typecheck
MARTLLM_API_KEY=ull_... npm run test:live   # live calls, about five US cents
```

## Support

- Docs: <https://martllm.com/docs/ai-sdk>
- Email: contact@martllm.com

MartLLM was called UberLLM until November 2026. `createUberLLM`, `uberllm` and
`UBERLLM_API_KEY` still work.

## License

MIT
