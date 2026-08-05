export type Citation = { doc: string; section: string };

export type Segment =
  | { type: "text"; value: string }
  | { type: "citation"; citation: Citation };

const CITATION_RE = /\[([^\[\]]+?)\s*::\s*([^\[\]]+)\]/g;

export function parseCitations(text: string): Segment[] {
  const segments: Segment[] = [];
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = CITATION_RE.exec(text)) !== null) {
    if (match.index > last) {
      segments.push({ type: "text", value: text.slice(last, match.index) });
    }
    segments.push({
      type: "citation",
      citation: { doc: match[1].trim(), section: match[2].trim() },
    });
    last = match.index + match[0].length;
  }
  if (last < text.length) {
    segments.push({ type: "text", value: text.slice(last) });
  }
  return segments;
}
