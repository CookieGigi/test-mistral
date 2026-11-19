import type { MLCEngine } from "@mlc-ai/web-llm";

export interface LoopOptions {
  engine: MLCEngine;
  getContext: () => string;
  appendOutput: (delta: string) => void;
  onIterationStart?: (iteration: number) => void;
  onIterationEnd?: (iteration: number, finishReason: string | null) => void;
  maxIterations: number;
  maxTokens: number;
  stopSequences: string[];
  shouldStop: () => boolean;
}

export interface LoopResult {
  iterationsRun: number;
  stoppedByUser: boolean;
}

export async function runLoop(opts: LoopOptions): Promise<LoopResult> {
  const { engine, getContext, appendOutput, maxIterations, maxTokens } = opts;
  let stoppedByUser = false;
  let iterationsRun = 0;

  for (let i = 0; i < maxIterations; i++) {
    if (opts.shouldStop()) {
      stoppedByUser = true;
      break;
    }

    opts.onIterationStart?.(i);

    const stream = (await engine.completions.create({
      prompt: getContext(),
      stream: true,
      max_tokens: maxTokens,
      stop: opts.stopSequences.length ? opts.stopSequences : undefined,
      temperature: 0.7,
    })) as AsyncIterable<import("@mlc-ai/web-llm").Completion>;

    let finishReason: string | null = null;
    for await (const chunk of stream) {
      if (opts.shouldStop()) {
        stoppedByUser = true;
        await engine.interruptGenerate();
        break;
      }
      const choice = chunk.choices[0];
      if (choice?.text) appendOutput(choice.text);
      if (choice?.finish_reason) finishReason = choice.finish_reason;
    }

    iterationsRun++;
    opts.onIterationEnd?.(i, finishReason);

    if (stoppedByUser) break;
    if (finishReason === "stop") break;
  }

  return { iterationsRun, stoppedByUser };
}
