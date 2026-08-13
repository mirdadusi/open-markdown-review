export interface LocatedQuote {
  start: number;
  end: number;
  confidence: "context" | "quote";
}

export interface TextPoint {
  line: number;
  character: number;
}

export function pointAtOffset(text: string, offset: number): TextPoint {
  const safe = Math.min(Math.max(0, offset), text.length);
  const before = text.slice(0, safe);
  const lines = before.split("\n");
  return { line: lines.length - 1, character: lines.at(-1)?.length ?? 0 };
}

export function offsetAtLine(text: string, line: number): number {
  if (line <= 0) return 0;
  let offset = 0;
  for (let current = 0; current < line; current++) {
    const newline = text.indexOf("\n", offset);
    if (newline < 0) return text.length;
    offset = newline + 1;
  }
  return offset;
}

/** Finds a quote after edits using prefix/suffix context and offset proximity. */
export function locateQuote(
  documentText: string,
  exact: string,
  prefix = "",
  suffix = "",
  preferredOffset = 0,
): LocatedQuote | undefined {
  if (!exact) return undefined;

  const candidates: Array<LocatedQuote & { score: number; distance: number }> = [];
  let from = 0;
  while (from <= documentText.length) {
    const start = documentText.indexOf(exact, from);
    if (start < 0) break;
    const before = documentText.slice(0, start);
    const after = documentText.slice(start + exact.length);
    const prefixMatch = !prefix || before.endsWith(prefix);
    const suffixMatch = !suffix || after.startsWith(suffix);
    candidates.push({
      start,
      end: start + exact.length,
      confidence: prefixMatch && suffixMatch ? "context" : "quote",
      score: Number(prefixMatch) + Number(suffixMatch),
      distance: Math.abs(start - preferredOffset),
    });
    from = start + Math.max(1, exact.length);
  }

  candidates.sort((a, b) => b.score - a.score || a.distance - b.distance || a.start - b.start);
  const best = candidates[0];
  return best && { start: best.start, end: best.end, confidence: best.confidence };
}
