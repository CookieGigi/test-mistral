interface GpuLike {
  requestAdapter(options?: { powerPreference?: string }): Promise<AdapterLike | null>;
}

interface AdapterLike {
  limits?: { maxComputeWorkgroupStorageSize?: number };
}

export interface GpuCheck {
  ok: boolean;
  kind: "ok" | "no-webgpu" | "no-adapter" | "low-limit";
  message: string;
}

function firefoxHint(): string {
  return "Firefox's WebGPU caps compute shared memory at 16 KB and cannot run WebLLM today — use Chrome or Edge 113+.";
}

function chromiumAdapterHint(): string {
  return [
    "WebGPU is present but no GPU adapter is available. Try, in order:",
    "• Chrome/Edge: Settings → System → turn on “Use graphics acceleration”, then restart.",
    "• Check chrome://gpu — WebGPU should not say “Disabled”.",
    "• A VM or remote desktop needs GPU pass-through; software rendering is not enough.",
    "• On Linux, install up-to-date GPU drivers (many Chromium builds require Vulkan).",
  ].join("\n");
}

export async function checkWebGPU(): Promise<GpuCheck> {
  const gpu = (navigator as { gpu?: GpuLike }).gpu;
  if (!gpu) {
    const ua = navigator.userAgent;
    const extra = /Firefox\//i.test(ua)
      ? firefoxHint()
      : /Safari\//i.test(ua) && !/Chrome|Chromium|Edg/i.test(ua)
        ? "Safari: enable WebGPU via Safari → Settings → Advanced → Feature Flags (macOS 13+); Chrome/Edge work out of the box."
        : "Use Chrome or Edge 113+, or another browser with WebGPU enabled.";
    return { ok: false, kind: "no-webgpu", message: `WebGPU is not available in this browser. ${extra}` };
  }

  let adapter: AdapterLike | null = null;
  try {
    adapter = await gpu.requestAdapter();
  } catch {
    adapter = null;
  }
  if (!adapter) {
    return { ok: false, kind: "no-adapter", message: chromiumAdapterHint() };
  }

  const limit = adapter.limits?.maxComputeWorkgroupStorageSize ?? 0;
  if (limit > 0 && limit < 32768) {
    return {
      ok: false,
      kind: "low-limit",
      message: `This GPU adapter caps compute shared memory at ${limit} bytes; WebLLM's runtime requires 32768. ${
        /Firefox\//i.test(navigator.userAgent) ? firefoxHint() : "Try Chrome or Edge 113+ with hardware acceleration."
      }`,
    };
  }
  return { ok: true, kind: "ok", message: "" };
}
