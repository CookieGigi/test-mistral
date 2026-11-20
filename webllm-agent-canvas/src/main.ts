import { CreateMLCEngine, prebuiltAppConfig } from "@mlc-ai/web-llm";
import type { MLCEngine, ModelRecord } from "@mlc-ai/web-llm";
import { runAgent, type AgentEvent } from "./agent";
import { computeBudget, countTokens, estimateTokens } from "./tokens";
import { deleteSection, parseSections, togglePin, trimToFit } from "./canvas";
import { MODES } from "./modes";

const DEFAULT_MODEL = "Qwen2.5-0.5B-Instruct-q4f16_1-MLC";
const CURATED = [
  "Qwen2.5-0.5B-Instruct",
  "SmolLM2-360M-Instruct",
  "Llama-3.2-1B-Instruct",
  "Qwen2.5-1.5B-Instruct",
  "SmolLM2-1.7B-Instruct",
  "Phi-3.5-mini-instruct",
];

const LS = {
  canvas: "agent-canvas:text",
  mode: "agent-canvas:mode",
  goal: "agent-canvas:goal",
  theme: "agent-canvas:theme",
  snapshots: "agent-canvas:snapshots",
};

interface Snapshot {
  id: number;
  t: number;
  note: string;
  text: string;
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const canvasEl = $<HTMLTextAreaElement>("canvas");
const goalEl = $<HTMLTextAreaElement>("goal");
const modelSelect = $<HTMLSelectElement>("model");
const modeSelect = $<HTMLSelectElement>("mode");
const loadBtn = $<HTMLButtonElement>("load");
const runBtn = $<HTMLButtonElement>("run");
const stopBtn = $<HTMLButtonElement>("stop");
const trimBtn = $<HTMLButtonElement>("trim");
const statusEl = $<HTMLSpanElement>("status");
const barFill = $<HTMLDivElement>("bar-fill");
const tokenCountEl = $<HTMLSpanElement>("token-count");
const stepsEl = $<HTMLInputElement>("steps");
const maxTokensEl = $<HTMLInputElement>("max-tokens");
const tempEl = $<HTMLInputElement>("temp");
const outlineEl = $<HTMLDivElement>("outline");
const snapshotsEl = $<HTMLDivElement>("snapshots");
const logEl = $<HTMLDivElement>("log");
const statsEl = $<HTMLDivElement>("stats");
const askBox = $<HTMLDivElement>("ask-box");
const askQuestion = $<HTMLDivElement>("ask-question");
const askAnswer = $<HTMLTextAreaElement>("ask-answer");
const askSend = $<HTMLButtonElement>("ask-send");
const snapshotBtn = $<HTMLButtonElement>("snapshot");
const exportBtn = $<HTMLButtonElement>("export");
const importBtn = $<HTMLButtonElement>("import-btn");
const importInput = $<HTMLInputElement>("import");
const themeBtn = $<HTMLButtonElement>("theme");
const helpBtn = $<HTMLButtonElement>("help");
const helpOverlay = $<HTMLDivElement>("help-overlay");
const helpClose = $<HTMLButtonElement>("help-close");
const webgpuWarning = $<HTMLDivElement>("webgpu-warning");

let engine: MLCEngine | null = null;
let contextWindow = 4096;
let running = false;
let stopRequested = false;
let askResolve: ((answer: string | null) => void) | null = null;
let snapshotId = 0;

function setStatus(text: string) {
  statusEl.textContent = text;
}

function persisted<T>(key: string, fallback: T): string {
  return localStorage.getItem(key) ?? (fallback as unknown as string) ?? "";
}

function saveCanvas() {
  localStorage.setItem(LS.canvas, canvasEl.value);
}

function logLine(kind: AgentEvent["type"], text: string) {
  const div = document.createElement("div");
  div.className = `log-line ${kind === "step" ? "sys" : kind}`;
  div.textContent = kind === "step" ? `— step ${text} —` : text;
  logEl.appendChild(div);
  while (logEl.childElementCount > 250) logEl.removeChild(logEl.firstChild as ChildNode);
  logEl.scrollTop = logEl.scrollHeight;
}

/* ---------- outline & meter ---------- */

function renderOutline() {
  const text = canvasEl.value;
  const sections = parseSections(text);
  const totalChars = Math.max(1, text.length);
  const maxTokens = contextWindow;
  outlineEl.textContent = "";

  if (sections.length === 0) {
    const empty = document.createElement("div");
    empty.className = "log-line sys";
    empty.textContent = "empty canvas — no sections";
    outlineEl.appendChild(empty);
    return;
  }

  for (const s of sections) {
    const row = document.createElement("div");
    row.className = `outline-item${s.pinned ? " pinned" : ""}`;
    row.dataset.line = String(s.start);

    const pin = document.createElement("span");
    pin.className = "pin";
    pin.textContent = s.pinned ? "📌" : "○";
    pin.title = s.pinned ? "Unpin (allow auto-trim)" : "Pin (protect from auto-trim)";
    if (s.name !== "(top)") pin.addEventListener("click", () => {
      canvasEl.value = togglePin(canvasEl.value, s.name, !s.pinned);
      saveCanvas();
      refreshAll();
    });

    const nm = document.createElement("span");
    nm.className = "nm";
    nm.textContent = s.name;
    const tk = document.createElement("span");
    tk.className = "tk";
    tk.textContent = `~${estimateTokens(s.body)}t`;

    const bar = document.createElement("div");
    bar.className = "outline-bar";
    bar.style.width = `${Math.min(100, (s.body.length / totalChars) * 100)}%`;

    row.append(pin, nm, tk, bar);
    row.addEventListener("click", (ev) => {
      if (ev.target === pin) return;
      jumpTo(s.start);
    });
    outlineEl.appendChild(row);
  }

  void maxTokens;
}

function jumpTo(line: number) {
  const text = canvasEl.value;
  let off = 0;
  for (let i = 0; i < line && off < text.length; i++) off = text.indexOf("\n", off) + 1;
  canvasEl.focus();
  canvasEl.selectionStart = off;
  canvasEl.selectionEnd = Math.min(text.length, text.indexOf("\n", off) + 1 || off + 1);
  const lineHeight = 22;
  const before = text.slice(0, off).split("\n").length - 1;
  canvasEl.scrollTop = Math.max(0, before * lineHeight - canvasEl.clientHeight / 3);
}

function renderStats() {
  const text = canvasEl.value;
  const words = text.trim() ? text.trim().split(/\s+/).length : 0;
  statsEl.textContent = `${words} words · ${text.length} chars · ${parseSections(text).length} sections`;
}

function budgetOf() {
  return computeBudget(contextWindow, Number(maxTokensEl.value) || 192);
}

let meterDebounce: number | undefined;
async function refreshMeter(immediate = false) {
  window.clearTimeout(meterDebounce);
  const run = async () => {
    const budget = budgetOf();
    const tokens = engine
      ? await countTokens(engine, canvasEl.value)
      : estimateTokens(canvasEl.value);
    const over = tokens > budget.maxPromptTokens;
    tokenCountEl.textContent = engine
      ? `tokens: ${tokens} / ${budget.maxPromptTokens} (window ${contextWindow})`
      : `tokens: ~${tokens} — load a model for exact count`;
    tokenCountEl.classList.toggle("over", over);
    barFill.classList.toggle("over", over);
    const ratio = Math.min(1, tokens / Math.max(1, budget.maxPromptTokens));
    barFill.style.width = `${Math.round(ratio * 100)}%`;
    trimBtn.disabled = running || tokens <= budget.maxPromptTokens;
  };
  if (immediate) await run();
  else meterDebounce = window.setTimeout(run, 250);
}

/* ---------- snapshots ---------- */

function loadSnapshots(): Snapshot[] {
  try {
    const raw = localStorage.getItem(LS.snapshots);
    return raw ? (JSON.parse(raw) as Snapshot[]) : [];
  } catch {
    return [];
  }
}

function saveSnapshots(list: Snapshot[]) {
  try {
    localStorage.setItem(LS.snapshots, JSON.stringify(list));
  } catch {
    if (list.length > 2) saveSnapshots(list.slice(0, Math.floor(list.length / 2)));
  }
}

function takeSnapshot(note: string) {
  const list = loadSnapshots();
  list.unshift({ id: ++snapshotId, t: Date.now(), note, text: canvasEl.value.slice(0, 80_000) });
  saveSnapshots(list.slice(0, 25));
  renderSnapshots();
}

function renderSnapshots() {
  const list = loadSnapshots();
  snapshotsEl.textContent = "";
  for (const snap of list) {
    const row = document.createElement("div");
    row.className = "snap-item";
    const label = document.createElement("span");
    const time = new Date(snap.t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    label.textContent = `${time} · ${snap.note}`;
    const restore = document.createElement("span");
    restore.className = "restore";
    restore.textContent = "↺";
    restore.title = "Restore this snapshot";
    restore.addEventListener("click", (ev) => {
      ev.stopPropagation();
      if (running) return;
      takeSnapshot("before restore");
      canvasEl.value = snap.text;
      saveCanvas();
      refreshAll();
      setStatus(`Restored snapshot from ${time}.`);
    });
    row.append(label, restore);
    row.addEventListener("click", () => {
      canvasEl.focus();
      jumpTo(0);
    });
    snapshotsEl.appendChild(row);
  }
  if (list.length === 0) {
    const empty = document.createElement("div");
    empty.className = "log-line sys";
    empty.textContent = "no snapshots yet";
    snapshotsEl.appendChild(empty);
  }
}

/* ---------- model ---------- */

function populateModels() {
  const config = prebuiltAppConfig.model_list;
  const picked: ModelRecord[] = [];
  for (const fragment of CURATED) {
    const match = config.find((m) => m.model_id.includes(fragment) && !picked.includes(m));
    if (match) picked.push(match);
  }
  if (picked.length === 0) picked.push(...config.slice(0, 12));
  for (const m of picked) {
    const opt = document.createElement("option");
    opt.value = m.model_id;
    opt.textContent = m.model_id;
    modelSelect.appendChild(opt);
  }
  const ids = new Set(picked.map((m) => m.model_id));
  if (ids.has(DEFAULT_MODEL)) modelSelect.value = DEFAULT_MODEL;
}

async function loadModel() {
  const modelId = modelSelect.value;
  loadBtn.disabled = true;
  modelSelect.disabled = true;
  canvasEl.readOnly = true;
  setStatus(`Loading ${modelId} — first run downloads the weights…`);
  try {
    engine = await CreateMLCEngine(modelId, {
      initProgressCallback: (report) => {
        barFill.style.width = `${Math.round(report.progress * 100)}%`;
        setStatus(report.text.slice(0, 140));
      },
    });
    const record = prebuiltAppConfig.model_list.find((m) => m.model_id === modelId);
    contextWindow = record?.overrides?.context_window_size ?? 4096;
    setStatus(`Loaded ${modelId} — window: ${contextWindow} tokens. The agent is ready.`);
    runBtn.disabled = false;
    trimBtn.disabled = false;
    await refreshMeter(true);
  } catch (e) {
    setStatus(`Load failed: ${e instanceof Error ? e.message : String(e)}`);
    engine = null;
    loadBtn.disabled = false;
    modelSelect.disabled = false;
    canvasEl.readOnly = false;
  }
}

/* ---------- run ---------- */

function setRunning(busy: boolean) {
  running = busy;
  if (!engine) {
    runBtn.disabled = true;
    stopBtn.disabled = true;
    canvasEl.readOnly = canvasEl.readOnly && false;
    return;
  }
  runBtn.disabled = busy;
  stopBtn.disabled = !busy;
  canvasEl.readOnly = busy;
  canvasEl.classList.toggle("readonly", busy);
  loadBtn.disabled = busy;
  modelSelect.disabled = busy;
}

async function run() {
  if (!engine || running) return;
  setRunning(true);
  stopRequested = false;
  askBox.classList.add("hidden");
  logEl.textContent = "";
  logLine("sys", `mission: ${goalEl.value.trim() || "(none set — agent will improve the canvas)"}`);
  takeSnapshot("run start");

  const mode = MODES[modeSelect.value] ?? MODES.scribe;
  const event = (e: AgentEvent) => {
    switch (e.type) {
      case "step":
        logLine("step", `${e.n}/${e.total}`);
        setStatus(`Agent working — step ${e.n}/${e.total}…`);
        break;
      case "tool":
        logLine("tool", e.text);
        break;
      case "agent":
        logLine("agent", e.text);
        break;
      case "human":
        logLine("human", e.text);
        break;
      case "sys":
        logLine("sys", e.text);
        break;
      case "error":
        logLine("error", e.message);
        setStatus(`Error: ${e.message}`);
        break;
    }
  };

  try {
    const result = await runAgent({
      engine,
      getCanvas: () => canvasEl.value,
      setCanvas: (text) => {
        canvasEl.value = text;
        saveCanvas();
        renderOutline();
        renderStats();
        void refreshMeter();
      },
      goal: goalEl.value,
      preamble: mode.preamble,
      maxSteps: Math.max(1, Number(stepsEl.value) || 10),
      maxTokens: Math.max(16, Number(maxTokensEl.value) || 192),
      temperature: Number(tempEl.value) || 0.7,
      budget: budgetOf(),
      ask: (question) => promptHuman(question),
      shouldStop: () => stopRequested,
      onEvent: event,
      onSnapshotSave: (note) => takeSnapshot(note),
    });

    try {
      await engine.resetChat();
    } catch {
      /* engine may not need a reset after raw completions */
    }

    const parts = [
      result.declaredDone ? "✔ mission complete ([[done]])" : null,
      result.stoppedByUser ? "stopped" : null,
      !result.declaredDone && !result.stoppedByUser ? "reached the step limit" : null,
      `${result.stepsRun} step(s) run`,
    ].filter(Boolean);
    setStatus(`${parts.join(" · ")}. The canvas is yours — edit it and run again.`);
  } catch (e) {
    setStatus(`Agent error: ${e instanceof Error ? e.message : String(e)}`);
    logLine("error", String(e));
  } finally {
    setRunning(false);
    resolveAsk(null);
    await refreshMeter(true);
  }
}

function promptHuman(question: string): Promise<string | null> {
  return new Promise((resolve) => {
    askQuestion.textContent = question;
    askAnswer.value = "";
    askBox.classList.remove("hidden");
    askAnswer.focus();
    setStatus("The agent paused to ask you something. Answer below, or Stop.");
    askResolve = resolve;
  });
}

function resolveAsk(answer: string | null) {
  askBox.classList.add("hidden");
  const resolve = askResolve;
  askResolve = null;
  resolve?.(answer);
}

askSend.addEventListener("click", () => {
  const answer = askAnswer.value.trim() || "(no answer — keep going and decide yourself)";
  resolveAsk(answer);
});

/* ---------- misc UI ---------- */

function applyTheme(theme: string) {
  document.documentElement.dataset.theme = theme === "light" ? "light" : "dark";
  themeBtn.textContent = theme === "light" ? "☀" : "☾";
  localStorage.setItem(LS.theme, theme);
}

modeSelect.addEventListener("change", () => {
  localStorage.setItem(LS.mode, modeSelect.value);
  setStatus(`Mode set to ${modeSelect.selectedOptions[0]?.textContent ?? modeSelect.value}. Re-run to apply the new protocol.`);
});

canvasEl.addEventListener("input", () => {
  saveCanvas();
  renderOutline();
  renderStats();
  void refreshMeter();
});

goalEl.addEventListener("input", () => localStorage.setItem(LS.goal, goalEl.value));
maxTokensEl.addEventListener("change", () => void refreshMeter(true));

trimBtn.addEventListener("click", () => {
  if (running) return;
  const budget = budgetOf();
  canvasEl.value = trimToFit(canvasEl.value, Math.max(400, budget.contextWindow - (Number(maxTokensEl.value) || 192)));
  saveCanvas();
  refreshAll();
  setStatus("Trimmed unpinned sections to fit the context budget.");
});

runBtn.addEventListener("click", run);
stopBtn.addEventListener("click", () => {
  stopRequested = true;
  resolveAsk(null);
  setStatus("Stopping after this generation…");
});
loadBtn.addEventListener("click", loadModel);
snapshotBtn.addEventListener("click", () => {
  takeSnapshot("manual");
  setStatus("Snapshot saved (Ctrl+S).");
});
exportBtn.addEventListener("click", () => {
  const stamp = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 16);
  const blob = new Blob([canvasEl.value], { type: "text/markdown" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `canvas-${stamp}.md`;
  a.click();
  URL.revokeObjectURL(a.href);
});
importBtn.addEventListener("click", () => importInput.click());
importInput.addEventListener("change", async () => {
  const file = importInput.files?.[0];
  importInput.value = "";
  if (!file || running) return;
  const text = await file.text();
  takeSnapshot("before import");
  canvasEl.value = text;
  saveCanvas();
  refreshAll();
  setStatus(`Imported ${file.name}.`);
});

themeBtn.addEventListener("click", () => {
  applyTheme(document.documentElement.dataset.theme === "light" ? "dark" : "light");
});
helpBtn.addEventListener("click", () => helpOverlay.classList.remove("hidden"));
helpClose.addEventListener("click", () => helpOverlay.classList.add("hidden"));
helpOverlay.addEventListener("click", (e) => {
  if (e.target === helpOverlay) helpOverlay.classList.add("hidden");
});

function refreshAll() {
  renderOutline();
  renderStats();
  void refreshMeter(true);
}

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    if (!helpOverlay.classList.contains("hidden")) {
      helpOverlay.classList.add("hidden");
      return;
    }
    if (running) {
      stopRequested = true;
      resolveAsk(null);
    }
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
    e.preventDefault();
    if (!running && engine) run();
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
    e.preventDefault();
    takeSnapshot("manual");
    setStatus("Snapshot saved (Ctrl+S).");
    return;
  }
  if (e.key === "?" && document.activeElement !== canvasEl && document.activeElement !== goalEl) {
    helpOverlay.classList.toggle("hidden");
    return;
  }
  if (e.altKey && e.key >= "1" && e.key <= "9") {
    const idx = Number(e.key) - 1;
    const item = outlineEl.children[idx] as HTMLElement | undefined;
    item?.click();
  }
});

if (!("gpu" in navigator)) {
  webgpuWarning.textContent =
    "This browser does not expose WebGPU (navigator.gpu). Use Chrome/Edge 113+ (or a recent Firefox/Safari) to run the agent.";
  webgpuWarning.classList.remove("hidden");
}

/* ---------- boot ---------- */

canvasEl.value = persisted(LS.canvas, MODES.scribe.seed);
modeSelect.value = persisted(LS.mode, "scribe") || "scribe";
if (!MODES[modeSelect.value]) modeSelect.value = "scribe";
goalEl.value = persisted(LS.goal, "");
applyTheme(persisted(LS.theme, "dark") || "dark");

populateModels();
setRunning(false);
refreshAll();
renderSnapshots();
setStatus("Model not loaded. Pick a model and press ⚡ Load model.");
