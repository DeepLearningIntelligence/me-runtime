import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { MessageBlock } from "@rakazo/contracts";

/**
 * Deliverables: a white paper or report written as a markdown page under
 * docs/publications, plus an optional Visual Pack message carrying the research
 * blocks through the chat messaging layer. The page is the source of truth; the
 * Visual Pack is a notification with the same evidence, never a second copy.
 */
export type DeliverableKind = "white_paper" | "report";

export const DELIVERABLE_KINDS: readonly DeliverableKind[] = ["white_paper", "report"];

export type DeliverableProvenance = {
  runId: string;
  botId: string;
  spaceId: string;
};

export type PublishDeliverableInput = {
  spaceId: string;
  kind: DeliverableKind;
  title: string;
  /** The person who owns the page. */
  owner: string;
  provenance: DeliverableProvenance;
  /** Research blocks that also become the Visual Pack message. */
  blocks?: readonly MessageBlock[];
};

export type PublishDeliverableResult = {
  /** Where the page lives. No public route exists yet, so this is the file URL. */
  pageUrl: string;
  browserPreview: true;
  /** Absolute path of the written markdown, for callers that need the file itself. */
  filePath: string;
};

export function deliverableSlug(title: string): string {
  return title
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

/** Blocks whose text is meant to be read; the page body keeps them in order. */
function blockMarkdown(block: MessageBlock): string | undefined {
  switch (block.kind) {
    case "text":
      return block.text.trim();
    case "chart":
      return `[Chart: ${block.name}]`;
    case "image":
      return `[Image: ${block.name}]`;
    case "file":
      return `[File: ${block.name}]`;
    case "page":
      return `[Page: ${block.title}]`;
    default:
      return undefined;
  }
}

/** The page body: prose blocks as markdown, other evidence named, never invented. */
export function deliverableBody(input: PublishDeliverableInput): string {
  const parts = (input.blocks ?? [])
    .map((block) => blockMarkdown(block))
    .filter((part): part is string => Boolean(part));
  if (parts.length === 0) {
    return `# ${input.title}\n\nPublished from run ${input.provenance.runId}.\n`;
  }
  return `# ${input.title}\n\n${parts.join("\n\n")}\n`;
}

function frontmatterValue(value: string): string {
  return /[#{}[\],&*?|>!%@`]/.test(value) || value !== value.trim() ? JSON.stringify(value) : value;
}

export function publishDeliverable(
  input: PublishDeliverableInput,
  options: { rootDir?: string; now?: Date } = {},
): PublishDeliverableResult {
  const slug = deliverableSlug(input.title);
  if (!slug) throw new Error("title must contain at least one letter or digit");
  const rootDir = options.rootDir ?? process.cwd();
  const now = options.now ?? new Date();
  const filePath = join(rootDir, "docs", "publications", `${slug}.md`);
  const frontmatter = [
    "---",
    `title: ${frontmatterValue(input.title.trim())}`,
    `kind: ${input.kind}`,
    `owner: ${frontmatterValue(input.owner)}`,
    `spaceId: ${frontmatterValue(input.spaceId)}`,
    "provenance:",
    `  runId: ${frontmatterValue(input.provenance.runId)}`,
    `  botId: ${frontmatterValue(input.provenance.botId)}`,
    `  spaceId: ${frontmatterValue(input.provenance.spaceId)}`,
    `verifiedAt: ${now.toISOString()}`,
    "---",
  ].join("\n");
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${frontmatter}\n\n${deliverableBody(input)}`, "utf8");
  return {
    pageUrl: `file://${filePath}`,
    browserPreview: true,
    filePath,
  };
}

export type VisualPack = {
  title: string;
  pageUrl: string;
  blocks: readonly MessageBlock[];
};

const MAX_DELIVERABLE_BLOCKS = 40;

/** Research blocks arrive as plain JSON over the tool wire; keep only shaped blocks. */
export function normalizeDeliverableBlocks(raw: unknown): MessageBlock[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(
      (block): block is { kind: string; [key: string]: unknown } =>
        Boolean(block) &&
        typeof block === "object" &&
        typeof (block as Record<string, unknown>).kind === "string",
    )
    .slice(0, MAX_DELIVERABLE_BLOCKS) as unknown as MessageBlock[];
}

/** The Visual Pack message: the page link plus a one-line index of the evidence. */
export function visualPackBlocks(pack: VisualPack): MessageBlock[] {
  const evidence = pack.blocks
    .map((block) => blockMarkdown(block))
    .filter((part): part is string => Boolean(part))
    .slice(0, 20);
  const index = evidence.length
    ? `\n\n${evidence.map((line) => `- ${line.split("\n")[0]}`).join("\n")}`
    : "";
  return [
    {
      kind: "text",
      text: `Visual Pack: ${pack.title}\n${pack.pageUrl}${index}`,
    },
  ];
}

/**
 * Send the Visual Pack through the messaging layer (the thread's own publish
 * path). The caller supplies how to publish, so this module never reaches into
 * the executor and stays testable.
 */
export async function publishVisualPack(
  publish: (blocks: MessageBlock[]) => Promise<unknown>,
  pack: VisualPack,
): Promise<{ published: boolean; blocks: MessageBlock[] }> {
  const blocks = visualPackBlocks(pack);
  const result = await publish(blocks);
  // The chat's publish path returns null when it declines to write anything.
  return { published: result !== null && result !== undefined, blocks };
}
