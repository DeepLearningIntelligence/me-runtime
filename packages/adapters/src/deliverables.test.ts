import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MessageBlock } from "@rakazo/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  deliverableSlug,
  normalizeDeliverableBlocks,
  publishDeliverable,
  publishVisualPack,
  visualPackBlocks,
} from "./deliverables.js";

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "deliverable-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const prose: MessageBlock = { kind: "text", text: "Revenue grew 12 percent." };

describe("deliverableSlug", () => {
  it("turns a title into a stable file name", () => {
    expect(deliverableSlug("Q3 Outlook: Revenue and Risk")).toBe("q3-outlook-revenue-and-risk");
  });
});

describe("publishDeliverable", () => {
  it("writes docs/publications/<slug>.md and returns the page URL", () => {
    const root = tempDir();
    const result = publishDeliverable(
      {
        spaceId: "space-1",
        kind: "report",
        title: "Q3 Outlook",
        owner: "user-7",
        provenance: { runId: "run-1", botId: "bot-1", spaceId: "space-1" },
        blocks: [prose],
      },
      { rootDir: root, now: new Date("2026-11-19T12:00:00.000Z") },
    );

    const filePath = join(root, "docs", "publications", "q3-outlook.md");
    expect(result.filePath).toBe(filePath);
    expect(result.pageUrl).toBe(`file://${filePath}`);
    expect(result.browserPreview).toBe(true);
    expect(existsSync(filePath)).toBe(true);

    const content = readFileSync(filePath, "utf8");
    expect(content).toContain("title: Q3 Outlook");
    expect(content).toContain("kind: report");
    expect(content).toContain("owner: user-7");
    expect(content).toContain("spaceId: space-1");
    expect(content).toContain("runId: run-1");
    expect(content).toContain("botId: bot-1");
    expect(content).toContain("verifiedAt: 2026-11-19T12:00:00.000Z");
    expect(content).toContain("# Q3 Outlook");
    expect(content).toContain("Revenue grew 12 percent.");
  });

  it("writes a page with only frontmatter and a title when there are no blocks", () => {
    const root = tempDir();
    const result = publishDeliverable(
      {
        spaceId: "space-1",
        kind: "white_paper",
        title: "Market Map",
        owner: "user-7",
        provenance: { runId: "run-2", botId: "bot-1", spaceId: "space-1" },
      },
      { rootDir: root },
    );
    const content = readFileSync(result.filePath, "utf8");
    expect(content).toContain("kind: white_paper");
    expect(content).toContain("# Market Map");
    expect(content).toContain("Published from run run-2.");
  });

  it("refuses a title with no letters or digits", () => {
    expect(() =>
      publishDeliverable(
        {
          spaceId: "space-1",
          kind: "report",
          title: "!!!",
          owner: "user-7",
          provenance: { runId: "run-3", botId: "bot-1", spaceId: "space-1" },
        },
        { rootDir: tempDir() },
      ),
    ).toThrow(/at least one letter or digit/);
  });
});

describe("visual pack", () => {
  it("builds one message with the page link and the evidence index", () => {
    const blocks = visualPackBlocks({
      title: "Q3 Outlook",
      pageUrl: "file:///tmp/docs/publications/q3-outlook.md",
      blocks: [prose],
    });
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.kind).toBe("text");
    const text = blocks[0]?.kind === "text" ? blocks[0].text : "";
    expect(text).toContain("Visual Pack: Q3 Outlook");
    expect(text).toContain("file:///tmp/docs/publications/q3-outlook.md");
    expect(text).toContain("- Revenue grew 12 percent.");
  });

  it("publishes through the messaging layer and reports it did", async () => {
    const publish = vi.fn(async (_blocks: MessageBlock[]) => ({ id: "message-1" }));
    const pack = {
      title: "Q3 Outlook",
      pageUrl: "file:///tmp/docs/publications/q3-outlook.md",
      blocks: [prose],
    };
    const result = await publishVisualPack(publish, pack);
    expect(result.published).toBe(true);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish.mock.calls[0]?.[0]).toEqual(visualPackBlocks(pack));
  });

  it("reports not published when the messaging layer declines", async () => {
    const result = await publishVisualPack(async () => null, {
      title: "Q3 Outlook",
      pageUrl: "file:///tmp/docs/publications/q3-outlook.md",
      blocks: [prose],
    });
    expect(result.published).toBe(false);
  });
});

describe("normalizeDeliverableBlocks", () => {
  it("keeps shaped blocks only", () => {
    expect(normalizeDeliverableBlocks([prose, null, "text", { text: "no kind" }, 5])).toEqual([
      prose,
    ]);
  });

  it("caps the blocks a page and a Visual Pack can carry", () => {
    const many = Array.from({ length: 45 }, (_, index) => ({
      kind: "text",
      text: `line ${index}`,
    }));
    expect(normalizeDeliverableBlocks(many)).toHaveLength(40);
  });
});
