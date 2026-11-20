export interface Section {
  name: string;
  start: number;
  end: number;
  titleLine: number;
  body: string;
  pinned: boolean;
}

const PIN_RE = /📌/u;

export function normalizeName(raw: string): string {
  return raw.replace(/\s+/g, " ").trim().replace(/:\s*$/, "");
}

export function parseSections(text: string): Section[] {
  const lines = text.split("\n");
  const headers: { name: string; line: number }[] = [];

  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^#{1,6}\s+(.*)$/);
    if (m) headers.push({ name: normalizeName(m[1].replace(PIN_RE, "")), line: i });
  }

  const sections: Section[] = [];

  if (headers.length === 0 || headers[0].line > 0) {
    const topEnd = headers.length === 0 ? lines.length : headers[0].line;
    const body = lines
      .slice(0, topEnd)
      .join("\n")
      .replace(/^\s+|\s+$/g, "");
    if (body.length > 0) {
      sections.push({ name: "(top)", start: 0, end: topEnd, titleLine: -1, body, pinned: false });
    }
  }

  for (let h = 0; h < headers.length; h++) {
    const endLine = h + 1 < headers.length ? headers[h + 1].line : lines.length;
    const body = lines
      .slice(headers[h].line + 1, endLine)
      .join("\n")
      .replace(/^\n{1,2}/, "")
      .replace(/\s+$/g, "");
    sections.push({
      name: headers[h].name,
      start: headers[h].line,
      end: endLine,
      titleLine: headers[h].line,
      body,
      pinned: PIN_RE.test(lines[headers[h].line]),
    });
  }
  return sections;
}

export function findSection(text: string, name: string): Section | undefined {
  const target = normalizeName(name).toLowerCase();
  return parseSections(text).find((s) => s.name.toLowerCase() === target);
}

export function setSection(text: string, name: string, content: string): string {
  const clean = normalizeName(name);
  const replacement = `## ${clean}\n\n${content.replace(/\s+$/, "")}`;
  const existing = findSection(text, clean);
  if (!existing) {
    const base = text.replace(/\s+$/, "");
    return base.length === 0 ? replacement : base + "\n\n" + replacement + "\n";
  }
  return splice(text, existing.start, existing.end, replacement);
}

export function appendToSection(text: string, name: string, content: string): string {
  const clean = normalizeName(name);
  const addition = content.replace(/^\s+|\s+$/g, "");
  if (addition.length === 0) return text;
  const existing = findSection(text, clean);
  if (!existing) return setSection(text, clean, addition);
  const title = `## ${existing.pinned ? "📌 " : ""}${existing.name}`;
  return splice(text, existing.start, existing.end, `${title}\n\n${existing.body}\n${addition}`);
}

export function deleteSection(text: string, name: string): string {
  const existing = findSection(text, normalizeName(name));
  if (!existing || existing.name === "(top)") return text;
  const out = splice(text, existing.start, existing.end, "____DEL____");
  return out.replace(/____DEL____\n?/g, "").replace(/\n{3,}/g, "\n\n").replace(/^\n+/, "");
}

export function togglePin(text: string, name: string, pin: boolean): string {
  const existing = findSection(text, normalizeName(name));
  if (!existing || existing.name === "(top)") return text;
  const off = lineOffset(text, existing.titleLine);
  const lineEnd = text.indexOf("\n", off);
  const line = lineEnd === -1 ? text.slice(off) : text.slice(off, lineEnd);
  const title = line.replace(PIN_RE, "").replace(/^#{1,6}\s+/, "").trim();
  const out = pin ? `## 📌 ${title}` : `## ${title}`;
  const rest = lineEnd === -1 ? "" : text.slice(lineEnd);
  return text.slice(0, off) + out + rest;
}

export function grepSections(text: string, pattern: string): string[] {
  const clean = normalizeName(pattern).replace(/^[a-z]+[:|]\s*/i, "");
  let re: RegExp;
  try {
    re = new RegExp(clean, "i");
  } catch {
    re = new RegExp(clean.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  }
  const hits: string[] = [];
  for (const s of parseSections(text)) {
    for (const raw of s.body.split("\n")) {
      const line = raw.trim();
      if (line && re.test(line)) hits.push(`[${s.name}] ${line}`);
      if (hits.length >= 24) return hits;
    }
  }
  return hits;
}

export function collapseBlankRuns(text: string): string {
  return text
    .replace(/\n{4,}/g, "\n\n\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/([^\n#])\n(#{1,6} )/g, "$1\n\n$2");
}

export function trimToFit(text: string, maxChars: number): string {
  let current = text;
  const dropOldestUnpinned = (): boolean => {
    const unpinned = parseSections(current).filter((s) => !s.pinned && s.name !== "(top)");
    if (unpinned.length === 0) return false;
    current = deleteSection(current, unpinned[0].name);
    return true;
  };
  while (current.length > maxChars && dropOldestUnpinned()) {
    /* drop until it fits or only pinned content remains */
  }
  if (current.length > maxChars) {
    current = current.slice(Math.max(0, current.length - maxChars));
    current = current.slice(current.indexOf("\n") + 1);
  }
  return collapseBlankRuns(current);
}

function splice(text: string, startLine: number, endLine: number, replacement: string): string {
  const off = lineOffset(text, startLine);
  const offEnd = lineOffset(text, endLine);
  const head = text.slice(0, off);
  const tail = text.slice(offEnd);
  let mid = replacement;
  if (mid.length > 0 && !mid.endsWith("\n")) mid += "\n";
  return head + mid + tail;
}

export function lineOffset(text: string, line: number): number {
  if (line <= 0) return 0;
  let off = 0;
  for (let i = 0; i < line; i++) {
    const next = text.indexOf("\n", off);
    if (next === -1) return text.length;
    off = next + 1;
  }
  return off;
}
