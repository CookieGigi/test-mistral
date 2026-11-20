import { CreateMLCEngine, prebuiltAppConfig } from "@mlc-ai/web-llm";
import type { MLCEngine, ModelRecord } from "@mlc-ai/web-llm";
import { computeBudget, countTokens } from "./tokens";
import { runLoop } from "./loop";
import { checkWebGPU } from "./gpu";

const DEFAULT_MODEL = "Qwen2.5-0.5B-Instruct-q4f16_1-MLC";

const modelSelect = document.getElementById("model") as HTMLSelectElement;
const loadBtn = document.getElementById("load") as HTMLButtonElement;
const barFill = document.getElementById("bar-fill") as HTMLDivElement;
const statusEl = document.getElementById("status") as HTMLSpanElement;
const contextArea = document.getElementById("context") as HTMLTextAreaElement;
const tokenCountEl = document.getElementById("token-count") as HTMLSpanElement;
const maxTokensInput = document.getElementById("max-tokens") as HTMLInputElement;
const maxItersInput = document.getElementById("max-iters") as HTMLInputElement;
const runBtn = document.getElementById("run") as HTMLButtonElement;
const stopBtn = document.getElementById("stop") as HTMLButtonElement;
const resetBtn = document.getElementById("reset") as HTMLButtonElement;

let engine: MLCEngine | null = null;
let contextWindow = 4096;
let currentTokens = 0;
let running = false;
let stopRequested = false;

function setStatus(text: string) {
  statusEl.textContent = text;
}

function populateModels() {
  const models: ModelRecord[] = prebuiltAppConfig.model_list.filter((m) =>
    m.model_id.includes(DEFAULT_MODEL.slice(0, 12)),
  );
  const list = models.length ? models : prebuiltAppConfig.model_list.slice(0, 25);
  const ids = new Set<string>();
  for (const m of prebuiltAppConfig.model_list) ids.add(m.model_id);
  for (const m of list) {
    const opt = document.createElement("option");
    opt.value = m.model_id;
    opt.textContent = m.model_id;
    modelSelect.appendChild(opt);
  }
  if (ids.has(DEFAULT_MODEL)) modelSelect.value = DEFAULT_MODEL;
}

async function refreshTokenCount() {
  if (!engine) {
    tokenCountEl.textContent = "tokens: 0 / ? (load a model)";
    return;
  }
  currentTokens = await countTokens(engine, contextArea.value);
  const budget = computeBudget(contextWindow, Number(maxTokensInput.value) || 256);
  tokenCountEl.textContent = `tokens: ${currentTokens} / ${budget.maxPromptTokens} (window ${contextWindow}, ${budget.reserveForGeneration} reserved)`;
  tokenCountEl.classList.toggle("over", currentTokens > budget.maxPromptTokens);
  const ratio = budget.maxPromptTokens
    ? Math.min(1, currentTokens / budget.maxPromptTokens)
    : 1;
  barFill.style.width = `${Math.round(ratio * 100)}%`;
}

function setBusyState(busy: boolean) {
  running = busy;
  if (engine) {
    runBtn.disabled = busy || currentTokens === 0;
    stopBtn.disabled = !busy;
    contextArea.readOnly = busy;
    contextArea.classList.toggle("readonly", busy);
    resetBtn.disabled = busy;
  } else {
    runBtn.disabled = true;
    stopBtn.disabled = true;
    resetBtn.disabled = true;
  }
}

async function loadModel() {
  const modelId = modelSelect.value;
  loadBtn.disabled = true;
  modelSelect.disabled = true;
  setStatus("Checking WebGPU availability...");
  const gpuCheck = await checkWebGPU();
  if (!gpuCheck.ok) {
    const bannerEl = document.getElementById("webgpu-warning");
    if (bannerEl) {
      bannerEl.textContent = gpuCheck.message;
      bannerEl.classList.remove("hidden");
    }
    setStatus(`Cannot load (${gpuCheck.kind}). ${gpuCheck.message.split("\n")[0]}`);
    loadBtn.disabled = false;
    modelSelect.disabled = false;
    return;
  }
  setStatus("Loading model (first run downloads weights)...");
  contextArea.readOnly = true;
  try {
    engine = await CreateMLCEngine(modelId, {
      initProgressCallback: (report) => {
        barFill.style.width = `${Math.round(report.progress * 100)}%`;
        setStatus(report.text.slice(0, 120));
      },
    });
    const record = prebuiltAppConfig.model_list.find((m) => m.model_id === modelId);
    contextWindow = record?.overrides?.context_window_size ?? 4096;
    setStatus(`Loaded ${modelId} (window: ${contextWindow} tokens)`);
    await refreshTokenCount();
    setBusyState(false);
    resetBtn.disabled = false;
  } catch (e) {
    const raw = e instanceof Error ? e.message : String(e);
    if (/maxComputeWorkgroupStorageSize/i.test(raw)) {
      const limit = /limit=(\d+)/.exec(raw)?.[1];
      setStatus(`Load failed: this browser caps WebGPU compute shared memory at ${limit ?? "16"}K bytes but WebLLM needs 32K. Firefox cannot run WebLLM today — use Chrome or Edge 113+.`);
    } else if (/compatible GPU/i.test(raw)) {
      setStatus("Load failed: no compatible GPU. Enable hardware acceleration (Chrome Settings → System), check chrome://gpu, and in VMs/remote desktop you need GPU pass-through.");
    } else {
      setStatus(`Load failed: ${raw}`);
    }
    loadBtn.disabled = false;
    modelSelect.disabled = false;
    contextArea.readOnly = false;
  }
}

async function runOnce() {
  if (!engine) return;
  const budget = computeBudget(contextWindow, Number(maxTokensInput.value) || 256);
  if (currentTokens > budget.maxPromptTokens) {
    setStatus(`Context exceeds budget (${currentTokens} > ${budget.maxPromptTokens} tokens). Trim it.`);
    return;
  }
  setBusyState(true);
  stopRequested = false;
  let baseLength = contextArea.value.length;
  if (contextArea.value && !contextArea.value.endsWith("\n\n")) {
    contextArea.value += "\n\n";
    baseLength = contextArea.value.length;
  }
  try {
    const result = await runLoop({
      engine,
      getContext: () => contextArea.value,
      appendOutput: (delta) => {
        const atEnd = contextArea.selectionStart >= baseLength;
        contextArea.value += delta;
        if (atEnd) {
          contextArea.selectionStart = contextArea.selectionEnd = contextArea.value.length;
        }
        contextArea.scrollTop = contextArea.scrollHeight;
      },
      onIterationStart: (i) => setStatus(`Iteration ${i + 1}...`),
      onIterationEnd: (i, fr) => setStatus(`Iteration ${i + 1} done (${fr ?? "stopped"})`),
      maxIterations: Number(maxItersInput.value) || 1,
      maxTokens: Number(maxTokensInput.value) || 256,
      stopSequences: [],
      shouldStop: () => stopRequested,
    });
    await engine.resetChat();
    setStatus(
      result.stoppedByUser ? "Stopped by user." : "Done. Edit the context and run again.",
    );
  } catch (e) {
    setStatus(`Error: ${e instanceof Error ? e.message : String(e)}`);
    try {
      await engine.resetChat();
    } catch {
      /* engine may be in an unusable state */
    }
  } finally {
    setBusyState(false);
    await refreshTokenCount();
  }
}

loadBtn.addEventListener("click", loadModel);
runBtn.addEventListener("click", runOnce);
stopBtn.addEventListener("click", () => {
  stopRequested = true;
});
resetBtn.addEventListener("click", () => {
  contextArea.value = "";
  refreshTokenCount();
  runBtn.disabled = true;
});
contextArea.addEventListener("input", () => {
  refreshTokenCount();
  if (engine) runBtn.disabled = contextArea.value.length === 0;
});
maxTokensInput.addEventListener("change", refreshTokenCount);

populateModels();
setBusyState(false);
refreshTokenCount().catch(() => undefined);

void (async () => {
  const bootCheck = await checkWebGPU();
  if (!bootCheck.ok) {
    const bannerEl = document.getElementById("webgpu-warning");
    if (bannerEl) {
      bannerEl.textContent = bootCheck.message;
      bannerEl.classList.remove("hidden");
    }
    loadBtn.disabled = true;
    setStatus(`WebGPU unavailable (${bootCheck.kind}) — see the banner at the top.`);
  }
})();
