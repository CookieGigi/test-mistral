# webllm-agent-canvas — “The Canvas”

A 100% in-browser agentic app where the **single editable textarea is the agent's entire
world**: it reads the canvas, physically edits it through a tiny directive protocol,
snapshots every step, and can pause mid-mission to ask the human a question.

Built with [WebLLM](https://github.com/mlc-ai/web-llm) (WebGPU), raw completion
streaming, zero UI frameworks. Sibling of `webllm-agentic-loop` — same core idea
(“context = one textarea”), taken to a full agent experience.

## How the agent works

Each step the agent receives the **whole canvas** plus its mission and emits raw text.
Lines are parsed live as they stream in:

| Directive | Effect on the canvas |
| --- | --- |
| `[[write: Name]] … [[end]]` | section «Name» body becomes the emitted lines (created on demand) |
| `[[append: Name]] … [[end]]` | lines added at the end of section «Name» |
| `[[note: one line]]` | quick note into «Notes» |
| `[[delete: Name]]` | removes the section |
| `[[find: pattern]]` | greps the canvas, writes results into «Findings» |
| `[[pin: Name]]` / `[[unpin: Name]]` | protects a section from auto-trim |
| `[[ask: question]]` | **pauses the loop**, waits for your answer, resumes |
| `[[done]]` | declares the mission complete |

Plain (non-directive) output streams into the «Notes» section, so the loop degrades
gracefully with small models. `## Title` lines delimit sections; the outline pane
shows them with live token weight, and clicking one jumps the cursor there.

## Features

- **4 mode preambles** — Scribe (incremental writing), Planner (checklists it ticks off),
  Researcher (findings/contradictions/open threads), Cartographer (turns text into a
  linked concept map).
- **Live token budget** — real tokenizer counts, usage bar, `Run` refuses to overflow,
  and **auto-trim** drops the oldest unpinned sections when the context fills.
- **Snapshots timeline** — one before each agent step (plus manual `Ctrl+S`);
  restore any of them in one click.
- **Ask-the-human** flow — the agent can stop mid-run, ask a question, your reply is
  written into a «Dialogue» section and the mission resumes.
- **Agent activity log** — every tool call, note and step echoed in the right pane.
- **Import / Export** the canvas as Markdown, autosave to `localStorage`,
  dark/light theme, keyboard shortcuts (`Ctrl+Enter` run, `Esc` stop, `Alt+1..9` jump).

## Dev

```bash
npm install
npm run dev      # vite dev server
npm run build    # tsc + production build
npm run preview  # serve dist/
```

Requires a WebGPU-capable browser (Chrome/Edge 113+); the page shows a banner if
`navigator.gpu` is missing. First model load downloads the weights (default
`Qwen2.5-0.5B-Instruct-q4f16_1-MLC`; try `Qwen2.5-1.5B` or `Llama-3.2-1B-Instruct`
for noticeably better directive discipline).

## Tips for good missions

“Update the **Draft** section until it has exactly 3 paragraphs, then use
`[[find:` to verify every keyword from **Brief** appears, then `[[done]]`.”
— the more the mission names sections, the more the agent acts like an editor with
hands, not a chatbot.
