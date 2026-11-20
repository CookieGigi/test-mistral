import type { MLCEngine } from "@mlc-ai/web-llm";

export interface ContextBudget {
  contextWindow: number;
  reserveForGeneration: number;
  maxPromptTokens: number;
}

export function computeBudget(contextWindow: number, maxTokens: number): ContextBudget {
  const reserveForGeneration = Math.max(1, Math.min(maxTokens, contextWindow - 1));
  return {
    contextWindow,
    reserveForGeneration,
    maxPromptTokens: Math.max(0, contextWindow - reserveForGeneration),
  };
}

export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

export async function countTokens(engine: MLCEngine, text: string): Promise<number> {
  if (text.length === 0) return 0;
  try {
    return (await engine.tokenize(text)).length;
  } catch {
    return estimateTokens(text);
  }
}
