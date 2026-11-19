import type { CalloutVariant } from "./directives";
import { calloutVariant, directiveCloseLine } from "./directives";

type DirectiveNode = {
  type: string;
  name?: string;
  attributes?: Record<string, string | null | undefined>;
  value?: string;
  children?: DirectiveNode[];
  data?: { hName?: string; hProperties?: Record<string, unknown> };
  position?: { start?: { offset?: number }; end?: { offset?: number } };
};

function nodeSource(node: DirectiveNode, source: string): string | undefined {
  const start = node.position?.start?.offset;
  const end = node.position?.end?.offset;
  return start === undefined || end === undefined ? undefined : source.slice(start, end);
}

function literalNode(node: DirectiveNode, source: string): DirectiveNode {
  return {
    type: "paragraph",
    data: { hName: "p", hProperties: { className: "rk-chat-directive-literal" } },
    children: [{ type: "text", value: nodeSource(node, source) ?? "" }],
  };
}

/** A directive still being written: its opening line as text, its body drawn as usual. */
function pendingNode(node: DirectiveNode, source: string): DirectiveNode {
  const opening = (nodeSource(node, source) ?? "").split("\n")[0] ?? "";
  node.children = [
    { type: "paragraph", children: [{ type: "text", value: opening }] },
    ...(node.children ?? []),
  ];
  node.data = { hName: "div", hProperties: { className: "rk-chat-directive-literal" } };
  return node;
}

function directiveTitle(node: DirectiveNode): string | undefined {
  const title = node.attributes?.title;
  return typeof title === "string" && title.trim() ? title : undefined;
}

function styleCallout(node: DirectiveNode): void {
  const variant: CalloutVariant = calloutVariant(node.attributes?.type);
  const title = directiveTitle(node);
  node.data = {
    hName: "div",
    hProperties: {
      className: `rk-chat-callout rk-chat-callout-${variant}`,
      dataCallout: variant,
      ...(title ? { dataTitle: title } : {}),
    },
  };
}

function styleDetails(node: DirectiveNode): void {
  const title = directiveTitle(node);
  node.data = {
    hName: "details",
    hProperties: {
      className: "rk-chat-collapsible",
      ...(title ? { dataTitle: title } : {}),
    },
  };
}

function transformBlock(node: DirectiveNode, source: string): DirectiveNode {
  if (node.type === "containerDirective") {
    const name = node.name?.toLowerCase();
    const closed = directiveCloseLine((nodeSource(node, source) ?? "").split("\n"), 1) !== -1;
    if (name !== "callout" && name !== "details") return literalNode(node, source);
    if (!closed) return pendingNode(node, source);
    if (name === "callout") styleCallout(node);
    else styleDetails(node);
  }
  if (node.children) node.children = node.children.map((child) => transformBlock(child, source));
  return node;
}

/**
 * Draws callout and details directives as blocks, and every other container directive, or one
 * still being written, as its literal source.
 */
export function remarkChatBlocks() {
  return (tree: unknown, file: { value?: unknown }) => {
    const root = tree as DirectiveNode | undefined;
    if (!root?.children) return;
    const source = typeof file.value === "string" ? file.value : "";
    root.children = root.children.map((child) => transformBlock(child, source));
  };
}
