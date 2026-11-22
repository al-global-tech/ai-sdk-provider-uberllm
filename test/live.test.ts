// Live tests against https://api.martllm.com. Skipped without MARTLLM_API_KEY.
// A few small requests plus one low-cost image (about two US cents in all).
import { generateImage, generateText, Output, stepCountIs, streamText, tool } from 'ai';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { listModels, martllm } from '../src/index';

const MODEL = process.env.MARTLLM_TEST_MODEL ?? 'deepseek/deepseek-v4-flash';
const live = describe.skipIf(!process.env.MARTLLM_API_KEY);

live('MartLLM live', () => {
  it('generateText', async () => {
    const { text, usage } = await generateText({
      model: martllm(MODEL),
      prompt: 'Reply with exactly the word: pong',
    });
    expect(text.toLowerCase()).toContain('pong');
    expect(usage.totalTokens).toBeGreaterThan(0);
  }, 60_000);

  it('streamText with usage', async () => {
    const result = streamText({ model: martllm(MODEL), prompt: 'Count from 1 to 5.' });
    let text = '';
    for await (const d of result.textStream) text += d;
    expect(text).toContain('5');
    expect((await result.usage).outputTokens).toBeGreaterThan(0);
  }, 60_000);

  it('tool calls', async () => {
    const { text, steps } = await generateText({
      model: martllm(MODEL),
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
    expect(steps.some((s) => s.toolCalls.length > 0)).toBe(true);
    expect(text).toContain('21');
  }, 90_000);

  it('structured output', async () => {
    const { output } = await generateText({
      model: martllm(MODEL),
      output: Output.object({ schema: z.object({ name: z.string(), age: z.number() }) }),
      prompt: 'Ada is 36 years old. Extract the person.',
    });
    expect(output.name.toLowerCase()).toContain('ada');
    expect(output.age).toBe(36);
  }, 60_000);

  it('generateImage', async () => {
    const { image } = await generateImage({
      model: martllm.imageModel('black-forest-labs/flux.2-klein-4b'),
      prompt: 'A red bicycle on a white background',
      size: '1024x1024',
    });
    expect(image.uint8Array.byteLength).toBeGreaterThan(1000);
  }, 180_000);

  it('listModels', async () => {
    const models = await listModels();
    expect(models.some((m) => m.id === MODEL)).toBe(true);
  }, 30_000);
});
