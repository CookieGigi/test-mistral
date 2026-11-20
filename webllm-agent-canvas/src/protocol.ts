export type Directive =
  | { kind: "write" | "append" | "delete" | "pin" | "unpin"; target: string }
  | { kind: "note"; text: string }
  | { kind: "find"; pattern: string }
  | { kind: "ask"; text: string }
  | { kind: "done" }
  | { kind: "end" };

const HEAD_RE = /^\s*\[\[\s*([a-zA-Z]+)\s*[:|]?\s*(.*?)\s*\]\]\s*$/;

export function parseDirectiveLine(line: string): Directive | null {
  const m = line.match(HEAD_RE);
  if (!m) return null;
  const verb = m[1].toLowerCase();
  const arg = (m[2] ?? "").replace(/^["'«]|["'»]$/g, "").trim();
  switch (verb) {
    case "write":
    case "append":
    case "delete":
    case "pin":
    case "unpin":
      if (arg.length === 0) return null;
      return { kind: verb, target: arg };
    case "note":
      if (arg.length === 0) return null;
      return { kind: "note", text: arg };
    case "find":
    case "search":
      if (arg.length === 0) return null;
      return { kind: "find", pattern: arg };
    case "ask":
    case "question":
      return { kind: "ask", text: arg.length > 0 ? arg : "…?" };
    case "done":
    case "finish":
      return { kind: "done" };
    case "end":
      return { kind: "end" };
    default:
      return { kind: "note", text: line.trim() };
  }
}

export function stripFence(line: string): string {
  return line.replace(/^\s*```[a-z]*\s*$/i, "");
}
