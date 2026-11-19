import type { MarkdownIt } from "@ronradtke/react-native-markdown-display";
import { calloutVariant, directiveCloseLine, directiveOpen } from "../directives";

type DirectiveToken = {
  attrs?: [string, string][];
  block?: boolean;
};

type BlockState = {
  src: string;
  bMarks: number[];
  eMarks: number[];
  tShift: number[];
  sCount: number[];
  blkIndent: number;
  parentType: string;
  line: number;
  lineMax: number;
  push(type: string, tag: string, nesting: number): DirectiveToken;
  md: { block: { tokenize(state: BlockState, startLine: number, endLine: number): void } };
};

function lineAt(state: BlockState, line: number): string {
  return state.src.slice(state.bMarks[line]! + state.tShift[line]!, state.eMarks[line]);
}

/** The line that closes the directive opened at `from`, or -1 when it is still being written. */
function closingLine(state: BlockState, from: number, endLine: number): number {
  const lines: string[] = [];
  for (let line = from; line < endLine; line += 1) lines.push(lineAt(state, line));
  const close = directiveCloseLine(lines, 0);
  return close === -1 ? -1 : from + close;
}

function directiveTitle(name: string, attributes: Record<string, string>): string {
  if (attributes.title?.trim()) return attributes.title;
  if (name === "callout") {
    const variant = calloutVariant(attributes.type);
    return variant[0]!.toUpperCase() + variant.slice(1);
  }
  return "Details";
}

function directiveRule(
  state: BlockState,
  startLine: number,
  endLine: number,
  silent: boolean,
): boolean {
  if (state.sCount[startLine]! - state.blkIndent >= 4) return false;
  const open = directiveOpen(lineAt(state, startLine));
  if (!open || (open.name !== "callout" && open.name !== "details")) return false;
  if (silent) return true;
  const close = closingLine(state, startLine + 1, endLine);
  if (close === -1) return false;

  const previousLineMax = state.lineMax;
  const previousParentType = state.parentType;
  state.parentType = "chat_directive";
  const token = state.push(`chat_${open.name}_open`, open.name, 1);
  token.attrs = [
    ["title", directiveTitle(open.name, open.attributes)],
    ...(open.name === "callout"
      ? ([["variant", calloutVariant(open.attributes.type)]] as [string, string][])
      : []),
  ];
  token.block = true;
  state.lineMax = close;
  state.md.block.tokenize(state, startLine + 1, close);
  state.lineMax = previousLineMax;
  const closing = state.push(`chat_${open.name}_close`, open.name, -1);
  closing.block = true;
  state.parentType = previousParentType;
  state.line = close + 1;
  return true;
}

/** Draws `:::callout` and `:::details` blocks; every other directive stays literal text. */
export function chatDirectivePlugin(md: MarkdownIt): void {
  md.block.ruler.before("blockquote", "chat_directive", directiveRule, {
    alt: ["paragraph", "reference", "blockquote", "list"],
  });
}
