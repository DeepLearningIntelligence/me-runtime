export const CALLOUT_VARIANTS = ["info", "warning", "success", "tip"] as const;

export type CalloutVariant = (typeof CALLOUT_VARIANTS)[number];

/** The variant a callout names, or `info` for any value the message does not define. */
export function calloutVariant(value: unknown): CalloutVariant {
  return typeof value === "string" && (CALLOUT_VARIANTS as readonly string[]).includes(value)
    ? (value as CalloutVariant)
    : "info";
}

const DIRECTIVE_OPEN = /^ {0,3}:::([A-Za-z][\w-]*)(\{[^}]*\})?[ \t]*$/;
const DIRECTIVE_CLOSE = /^ {0,3}:{3,}[ \t]*$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const ATTRIBUTE = /([A-Za-z][\w-]*)=(?:"([^"]*)"|'([^']*)'|([^\s}]+))/g;

function directiveAttributes(text: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  for (const match of text.matchAll(ATTRIBUTE)) {
    const value = match[2] ?? match[3] ?? match[4];
    if (match[1] && value !== undefined) attributes[match[1]] = value;
  }
  return attributes;
}

/** A container directive's name and attributes, or undefined for any other line. */
export function directiveOpen(
  line: string,
): { name: string; attributes: Record<string, string> } | undefined {
  const match = DIRECTIVE_OPEN.exec(line);
  if (!match?.[1]) return undefined;
  return { name: match[1].toLowerCase(), attributes: directiveAttributes(match[2] ?? "") };
}

export function isDirectiveClose(line: string): boolean {
  return DIRECTIVE_CLOSE.test(line);
}

/** The marker of a line that opens or closes a code fence. */
export function fenceMarker(line: string): string | undefined {
  return FENCE.exec(line)?.[1]?.[0];
}

/**
 * The index of the line that closes the directive whose body starts at `from`, or -1 while it is
 * unclosed. Fenced code and nested directives do not close it.
 */
export function directiveCloseLine(lines: readonly string[], from: number): number {
  let fence: string | undefined;
  let depth = 0;
  for (let line = from; line < lines.length; line += 1) {
    const text = lines[line]!;
    const marker = fenceMarker(text);
    if (marker) {
      if (fence === undefined) fence = marker;
      else if (marker === fence) fence = undefined;
      continue;
    }
    if (fence !== undefined) continue;
    if (directiveOpen(text)) depth += 1;
    else if (isDirectiveClose(text)) {
      if (depth === 0) return line;
      depth -= 1;
    }
  }
  return -1;
}
