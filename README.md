# ai-sdk-provider-martllm

> MartLLM was called UberLLM until November 2026; this package was `@uberllm/ai-sdk-provider` (never published to npm). `createUberLLM`, `uberllm` and `UBERLLM_API_KEY` still work.

[MartLLM](https://martllm.com) provider for the [Vercel AI SDK](https://ai-sdk.dev).
One OpenAI-compatible API key for hundreds of chat models (GPT, Claude, Gemini,
DeepSeek, Qwen, GLM, Kimi and others) and image models, usually below list price.

- Models and live prices: <https://martllm.com/models>
- Docs: <https://martllm.com/docs/ai-sdk>
- Get a key: <https://martllm.com/signup> (prepaid credit; failed requests are not billed)

Built on the official `@ai-sdk/openai-compatible` provider, with MartLLM's base
URL, the `MARTLLM_API_KEY` environment variable, token usage on streamed replies,
JSON-schema structured output and image generation set up for you.

## Install

```sh
npm i ai-sdk-provider-martllm ai zod
```

Until the package is on npm, install it from GitHub (it builds on install):

```sh
npm i github:PSA-Team-source/ai-sdk-provider-martllm ai zod
```

Requires `ai` 7 and Node.js 22 or later (ESM).

## Set your key

```sh
export MARTLLM_API_KEY="ull_..."
```

Create the key in **Dashboard → Keys** on <https://martllm.com>. The key is read
when a request is made, so importing the provider never throws.

## Generate text

```ts
import { martllm } from 'ai-sdk-provider-martllm';
import { generateText } from 'ai';

const { text, usage } = await generateText({
  model: martllm('deepseek/deepseek-v4-flash'),
  prompt: 'Say hello in five words.',
});
```

Any chat model id from <https://martllm.com/models> works, for example
`anthropic/claude-sonnet-5.5`, `openai/gpt-5.5` or `google/gemini-3.5-flash`.

## Stream

```ts
import { streamText } from 'ai';

const result = streamText({
  model: martllm('deepseek/deepseek-v4-flash'),
  prompt: 'Count from 1 to 5.',
});
for await (const delta of result.textStream) process.stdout.write(delta);
console.log(await result.usage);
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

```ts
import { generateText, Output } from 'ai';

const { output } = await generateText({
  model: martllm('deepseek/deepseek-v4-flash'),
  output: Output.object({ schema: z.object({ name: z.string(), age: z.number() }) }),
  prompt: 'Ada is 36 years old. Extract the person.',
});
// { name: 'Ada', age: 36 }
```

The provider sends `response_format: { type: "json_schema" }`. For a model that
only takes `json_object`, use `createMartLLM({ supportsStructuredOutputs: false })`.

## Images

```ts
import { generateImage } from 'ai';

const { image } = await generateImage({
  model: martllm.imageModel('black-forest-labs/flux.2-klein-4b'),
  prompt: 'A red bicycle on a white background',
  size: '1024x1024',
});
// image.uint8Array holds the picture
```

Image ids are listed under Images on <https://martllm.com/models>. Picture edits,
video and music are jobs on other routes; see <https://martllm.com/docs/media>.

## Settings

```ts
import { createMartLLM } from 'ai-sdk-provider-martllm';

const martllm = createMartLLM({
  apiKey: process.env.MY_MARTLLM_KEY, // default: MARTLLM_API_KEY; may be an async function
  baseURL: 'https://api.martllm.com/v1', // default
  appName: 'My App', // sent as X-Title; apps can be listed on https://martllm.com/apps
  appUrl: 'https://myapp.example', // sent as HTTP-Referer
  headers: {}, // extra headers on every request
  supportsStructuredOutputs: true, // default
});
```

## Cap what a request can cost

MartLLM's routing options go in `providerOptions.martllm`. `provider.max_price`
(USD per 1M tokens) skips any seller priced above it:

```ts
await generateText({
  model: martllm('deepseek/deepseek-v4-flash'),
  prompt: 'Hi',
  providerOptions: {
    martllm: { provider: { max_price: { prompt: 0.2, completion: 0.4 } } },
  },
});
```

Every request, with its cost, is listed in **Dashboard → Activity**.

## List models and prices

```ts
import { listModels } from 'ai-sdk-provider-martllm';

for (const m of await listModels()) {
  // chat models; { type: 'image' | 'video' | 'music' | 'audio' | 'all' } for others
  console.log(m.id, m.pricing?.input_usd, m.pricing?.output_usd, m.context_length);
}
```

Prices are USD per 1M tokens; `list_input_usd` / `list_output_usd`, when present,
are the official list price for the same model.

MartLLM has no embeddings endpoint, so `embeddingModel()` throws.

## Development

```sh
npm install
npm run typecheck
npm test                                    # offline, fake fetch
MARTLLM_API_KEY=ull_... npm run test:live   # live, about two US cents
npm run build
```

## Support

support@uberllm.dev · [Docs](https://martllm.com/docs/ai-sdk) · [Terms](https://martllm.com/terms)

MartLLM is operated by AL Global LLC and is not affiliated with Uber Technologies, Inc.

## License

MIT
