import type { MLCEngine } from "@mlc-ai/web-llm";
import { parseDirectiveLine, stripFence } from "./protocol";
import {
  appendToSection,
  collapseBlankRuns,
  deleteSection,
  grepSections,
  setSection,
  togglePin,
  trimToFit,
} from "./canvas";
import { countTokens, type ContextBudget } from "./tokens";

export type AgentEvent =
  | { type: "step"; n: number; total: number }
  | { type: "tool"; text: string }
  | { type: "agent"; text: string }
  | { type: "human"; text: string }
  | { type: "sys"; text: string }
  | { type: "error"; message: string };

export interface AgentOptions {
  engine: MLCEngine;
  getCanvas: () => string;
  setCanvas: (text: string) => void;
  goal: string;
  preamble: string;
  maxSteps: number;
  maxTokens: number;
  temperature: number;
  budget: ContextBudget;
  ask: (question: string) => Promise<string | null>;
  shouldStop: () => boolean;
  onEvent: (e: AgentEvent) => void;
  onSnapshotSave?: (note: string) => void;
}

export interface AgentResult {
  stepsRun: number;
  stoppedByUser: boolean;
  declaredDone: boolean;
  pausedForAsk: boolean;
  degenerate: boolean;
  aborted: string | null;
}

interface BlockState {
  mode: "write" | "append";
  target: string;
  first: boolean;
  lines: number;
}

const DEFAULT_SINK = "Notes";
const FINDINGS = "Findings";

export async function runAgent(opts: AgentOptions): Promise<AgentResult> {
  const result: AgentResult = {
    stepsRun: 0,
    stoppedByUser: false,
    declaredDone: false,
    pausedForAsk: false,
    degenerate: false,
    aborted: null,
  };

  let block: BlockState | null = null;
  let stopSignal: "ask" | "done" | null = null;
  let pendingQuestion: string | null = null;

  const applyText = (text: string) => {
    opts.setCanvas(collapseBlankRuns(text));
  };

  const insertLine = (target: string, mode: "write" | "append", line: string, first: boolean) => {
    const canvas = opts.getCanvas();
    if (mode === "write" && first) {
      applyText(setSection(canvas, target, line));
    } else {
      applyText(appendToSection(canvas, target, line));
    }
  };

  const handleLine = (rawLine: string): boolean => {
    const line = stripFence(rawLine);
    if (line.trim() === "") {
      if (block) insertLine(block.target, block.mode, "", false);
      return false;
    }

    const directive = parseDirectiveLine(line);
    if (directive) {
      switch (directive.kind) {
        case "write":
        case "append":
          block = { mode: directive.kind, target: directive.target, first: true, lines: 0 };
          opts.onEvent({
            type: "tool",
            text:
              directive.kind === "write"
                ? `✎ writing section «${directive.target}»`
                : `↓ appending to «${directive.target}»`,
          });
          return false;
        case "end":
          if (block) opts.onEvent({ type: "tool", text: `✔ wrote ${block.lines} line(s) into «${block.target}»` });
          block = null;
          return false;
        case "note":
          applyText(appendToSection(opts.getCanvas(), DEFAULT_SINK, directive.text));
          opts.onEvent({ type: "agent", text: directive.text });
          return false;
        case "delete":
          applyText(deleteSection(opts.getCanvas(), directive.target));
          opts.onEvent({ type: "tool", text: `🗑 deleted section «${directive.target}»` });
          return false;
        case "pin":
        case "unpin":
          applyText(togglePin(opts.getCanvas(), directive.target, directive.kind === "pin"));
          opts.onEvent({
            type: "tool",
            text: `${directive.kind === "pin" ? "📌 pinned" : "📎 unpinned"} «${directive.target}»`,
          });
          return false;
        case "find": {
          const hits = grepSections(opts.getCanvas(), directive.pattern);
          const body =
            hits.length > 0
              ? hits.map((h) => `- ${h}`).join("\n")
              : `- (no canvas line matches "${directive.pattern}")`;
          applyText(appendToSection(opts.getCanvas(), FINDINGS, `? ${directive.pattern}\n${body}`));
          opts.onEvent({
            type: "tool",
            text: `🔍 find "${directive.pattern}" → ${hits.length} hit(s) → «${FINDINGS}»`,
          });
          return false;
        }
        case "ask":
          pendingQuestion = directive.text;
          stopSignal = "ask";
          opts.onEvent({ type: "agent", text: `❓ ${directive.text}` });
          return true;
        case "done":
          result.declaredDone = true;
          stopSignal = "done";
          opts.onEvent({ type: "tool", text: "✔ [[done]] — mission complete" });
          return true;
      }
    }

    if (block) {
      insertLine(block.target, block.mode, line, block.first);
      block = { mode: block.mode, target: block.target, first: false, lines: block.lines + 1 };
      return false;
    }

    applyText(appendToSection(opts.getCanvas(), DEFAULT_SINK, line));
    opts.onEvent({ type: "agent", text: line });
    return false;
  };

  async function ensureBudget(): Promise<boolean> {
    let promptTokens = await countTokens(opts.engine, buildPrompt(opts, opts.getCanvas()));
    if (promptTokens <= opts.budget.maxPromptTokens) return true;
    opts.onEvent({ type: "sys", text: "context over budget — auto-trimming unpinned sections" });
    applyText(trimToFit(opts.getCanvas(), Math.max(400, opts.budget.contextWindow - opts.maxTokens)));
    promptTokens = await countTokens(opts.engine, buildPrompt(opts, opts.getCanvas()));
    if (promptTokens > opts.budget.maxPromptTokens) {
      result.aborted = `canvas still too big after auto-trim (${promptTokens} > ${opts.budget.maxPromptTokens} tokens). Trim or pin less.`;
      opts.onEvent({ type: "error", message: result.aborted });
      return false;
    }
    return true;
  }

  for (let step = 0; step < opts.maxSteps; step++) {
    if (opts.shouldStop()) {
      result.stoppedByUser = true;
      break;
    }

    opts.onEvent({ type: "step", n: step + 1, total: opts.maxSteps });
    if (!(await ensureBudget())) break;
    opts.onSnapshotSave?.(`step ${step + 1}`);

    let produced = 0;
    let interrupted = false;

    try {
      const stream = (await opts.engine.completions.create({
        prompt: buildPrompt(opts, opts.getCanvas()),
        stream: true,
        max_tokens: opts.maxTokens,
        temperature: opts.temperature,
        repetition_penalty: 1.1,
        stop: ["[[done]"],
      })) as AsyncIterable<{ choices: { text?: string; finish_reason?: string }[] }>;

      let lineBuf = "";
      let outBuf = "";
      for await (const chunk of stream) {
        if (opts.shouldStop()) {
          result.stoppedByUser = true;
          await opts.engine.interruptGenerate();
          interrupted = true;
          break;
        }
        const delta = chunk.choices[0]?.text ?? "";
        produced += delta.length;
        lineBuf += delta;
        outBuf += delta;

        if (isDegenerate(outBuf)) {
          result.degenerate = true;
          opts.onEvent({ type: "sys", text: "repetition loop detected — stopping this step before it floods the canvas" });
          await opts.engine.interruptGenerate();
          interrupted = true;
          break;
        }

        let nl: number;
        let halted = false;
        while ((nl = lineBuf.indexOf("\n")) !== -1) {
          const line = lineBuf.slice(0, nl);
          lineBuf = lineBuf.slice(nl + 1);
          if (handleLine(line)) {
            halted = true;
            break;
          }
        }
        if (halted) {
          await opts.engine.interruptGenerate();
          interrupted = true;
          break;
        }
      }

      if (!interrupted && lineBuf.trim().length > 0) handleLine(lineBuf);
    } catch (e) {
      result.aborted = e instanceof Error ? e.message : String(e);
      opts.onEvent({ type: "error", message: result.aborted });
      break;
    }

    result.stepsRun = step + 1;
    block = null;

    if (stopSignal === "ask") {
      stopSignal = null;
      const question = pendingQuestion ?? "…?";
      const answer = await opts.ask(question);
      pendingQuestion = null;
      if (opts.shouldStop()) {
        result.stoppedByUser = true;
        break;
      }
      if (answer === null) {
        result.pausedForAsk = true;
        break;
      }
      applyText(appendToSection(opts.getCanvas(), "Dialogue", `Agent asked: ${question}
Human replied: ${answer}`));
      opts.onEvent({ type: "human", text: answer });
      continue;
    }
    if (stopSignal === "done") break;
    if (result.stoppedByUser) break;
    if (result.degenerate) {
      opts.onEvent({ type: "sys", text: "step degenerated into repetition — aborting mission; trim «Notes» and re-run" });
      break;
    }
    if (produced === 0) {
      opts.onEvent({ type: "sys", text: "empty step — stopping early" });
      break;
    }
  }

  applyText(opts.getCanvas());
  return result;
}

function isDegenerate(out: string): boolean {
  if (out.length < 60) return false;
  const tail = out.slice(-600);
  for (let k = 2; k <= 40; k++) {
    const unit = tail.slice(-k);
    if (unit.trim().length === 0 || unit.trim().length !== k) continue;
    let count = 0;
    let i = tail.length;
    while (i - k >= 0 && tail.slice(i - k, i) === unit) {
      count++;
      i -= k;
    }
    if (count >= 6) return true;
  }
  return false;
}

function buildPrompt(opts: AgentOptions, canvas: string): string {
  return [
    opts.preamble,
    "",
    "===== MISSION =====",
    opts.goal.trim().length > 0 ? opts.goal.trim() : "(no explicit mission: improve the canvas)",
    "",
    "===== CANVAS — your entire memory =====",
    canvas.trim().length > 0 ? canvas : "(the canvas is empty)",
    "",
    "===== END CANVAS =====",
    "AGENT (one small step now, plain notes or directives; [[done]] when complete):",
  ].join("\n");
}
