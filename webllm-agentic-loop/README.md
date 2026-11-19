# webllm-agentic-loop

A minimal in-browser agentic loop where the "memory" is not a chat message list
but a single editable text area.

## How it works

1. Pick a model (default: `Qwen2.5-0.5B-Instruct-q4f16_1-MLC`) and press
   **Load model**. The model runs fully in the browser via WebLLM/WebGPU
   (Chrome/Edge 113+ recommended); first load downloads the weights.
2. Edit the text area freely — this text is the entire context.
3. Configure `max tokens` (generation budget per iteration) and
   `max iterations`, then press **Run**.
4. The whole text-area content is sent as the prompt to
   `engine.completions.create()`. The model's output is streamed back and
   appended into the same text area, so each iteration feeds on the previous
   context. If `max iterations > 1`, the loop repeats until the model stops,
   the iteration cap is reached, or you press **Stop**.
5. Between runs you can edit the context again, trim it, or reset it.

## Context size limit

The text area is capped by the loaded model's max context size minus the
per-iteration generation budget:

```
max prompt tokens = context_window_size - max_tokens
```

The active token count is shown live (counted with the model's own tokenizer via
`engine.tokenize()`) with a usage bar, and Run is refused if the budget is
exceeded. The context window is read from the model record's
`overrides.context_window_size` (4 096 fallback) and the generation uses raw
completions (no chat template), since the context is plain text, not messages.

## Dev

```bash
npm install
npm run dev     # serve locally
npm run build   # typecheck + production build
```

Requires a WebGPU-capable browser; WebLLM will throw on load otherwise.
