// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { ChatMarkdown } from "./markdown.web";

const readCss = (file: string) => readFileSync(new URL(file, import.meta.url), "utf8");

const mermaid = vi.hoisted(() => ({
  initialize: vi.fn(),
  parse: vi.fn(async (source: string) => !source.includes("BROKEN")),
  render: vi.fn(async (_id: string, source: string) => ({
    svg: `<svg width="100%" viewBox="0 0 120 40"><text>${source}</text></svg>`,
  })),
}));
vi.mock("mermaid", () => ({ default: mermaid }));

async function mount(markdown: string, streaming = false) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const render = async (next: string, nextStreaming = streaming) => {
    await act(async () => {
      root.render(<ChatMarkdown streaming={nextStreaming}>{next}</ChatMarkdown>);
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
  };
  await render(markdown, streaming);
  return {
    container,
    render,
    cleanup: async () => {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    },
  };
}

describe("web markdown callouts", () => {
  it.each(["info", "warning", "success", "tip"])("draws a %s callout", async (variant) => {
    const view = await mount(
      `:::callout{type="${variant}" title="Heads up"}\n\n**Bold** and \`code\`\n\n- one\n- two\n\n:::`,
    );
    const callout = view.container.querySelector(".rk-chat-callout");
    expect(callout?.classList.contains(`rk-chat-callout-${variant}`)).toBe(true);
    expect(callout?.getAttribute("role")).toBe("note");
    expect(callout?.querySelector(".rk-chat-callout-title")?.textContent).toBe("Heads up");
    expect(callout?.querySelector("strong")?.textContent).toBe("Bold");
    expect(callout?.querySelector("code")?.textContent).toBe("code");
    expect([...(callout?.querySelectorAll("li") ?? [])].map((item) => item.textContent)).toEqual([
      "one",
      "two",
    ]);
    await view.cleanup();
  });

  it("never throws on a missing or unknown type", async () => {
    const view = await mount(':::callout{type="bogus"}\n\nBody\n\n:::');
    expect(view.container.querySelector(".rk-chat-callout-info")).not.toBeNull();
    expect(view.container.textContent).toContain("Body");

    await view.render(":::callout\n\nBody two\n\n:::");
    expect(view.container.querySelector(".rk-chat-callout-info")).not.toBeNull();
    expect(view.container.textContent).toContain("Body two");
    await view.cleanup();
  });

  it("keeps the callout colours on the ui-tokens palette", async () => {
    const view = await mount(':::callout{type="tip" title="Tip"}\n\nBody\n\n:::');
    expect(view.container.querySelector(".rk-chat-callout-tip")).not.toBeNull();

    const blocksCss = readCss("./markdown-blocks.css");
    const calloutCss = blocksCss.slice(
      blocksCss.indexOf(".rk-chat-callout"),
      blocksCss.indexOf(".rk-chat-collapsible"),
    );
    expect(calloutCss).not.toMatch(/#[0-9a-f]{3,8}/i);
    for (const match of calloutCss.matchAll(/(?:color|background):\s*([^;]+);/g)) {
      expect(match[1]?.trim()).toMatch(/^var\(--[a-z-]+\)$/);
    }
    const accents = [...calloutCss.matchAll(/--rk-callout-accent:\s*([^;]+);/g)].map((match) =>
      match[1]?.trim(),
    );
    expect(accents).toHaveLength(4);
    for (const accent of accents) expect(accent).toMatch(/^var\(--[a-z-]+\)$/);
    await view.cleanup();
  });
});

describe("web markdown details", () => {
  it("starts closed and stays open across a streamed update", async () => {
    const source = ':::details{title="More"}\n\nBody\n\n:::';
    const view = await mount(source, true);
    const details = () => view.container.querySelector("details");
    const summary = () => view.container.querySelector("summary");

    expect(details()).not.toBeNull();
    expect(details()?.open).toBe(false);
    expect(details()?.hasAttribute("open")).toBe(false);
    expect(summary()?.textContent).toBe("More");

    await act(async () => {
      summary()?.click();
    });
    expect(details()?.open).toBe(true);

    await view.render(':::details{title="More"}\n\nBody and more\n\n:::', true);
    expect(view.container.querySelector("details")?.open).toBe(true);
    expect(view.container.querySelector("details")?.textContent).toContain("Body and more");
    await view.cleanup();
  });

  it("titles an untitled details block from the copy provider", async () => {
    const view = await mount(":::details\n\nBody\n\n:::");
    expect(view.container.querySelector("summary")?.textContent).toBe("Details");
    await view.cleanup();
  });
});

describe("web markdown directive streaming", () => {
  it("renders an unclosed callout as text and never throws", async () => {
    const view = await mount(':::callout{type="info" title="Heads up"}\n\nPartial **text**', true);
    expect(view.container.querySelector(".rk-chat-callout")).toBeNull();
    expect(view.container.querySelector(".rk-chat-directive-literal")).not.toBeNull();
    expect(view.container.textContent).toContain(":::callout");
    expect(view.container.textContent).toContain("Partial");
    expect(view.container.querySelector("strong")?.textContent).toBe("text");

    await view.render(
      ':::callout{type="info" title="Heads up"}\n\nPartial **text**\n\n:::\n\nAfter',
      true,
    );
    expect(view.container.querySelector(".rk-chat-callout")).not.toBeNull();
    expect(view.container.textContent).toContain("After");
    await view.cleanup();
  });

  it("waits for a mermaid fence to close before drawing it", async () => {
    const view = await mount("```mermaid\ngraph LR\n  A --> B", true);
    expect(view.container.querySelector('[data-testid="chat-diagram"]')).toBeNull();
    expect(view.container.querySelector("pre")?.textContent).toContain("graph LR");

    await view.render("```mermaid\ngraph LR\n  A --> B\n```", true);
    expect(view.container.querySelector('[data-testid="chat-diagram"] img')).not.toBeNull();
    await view.cleanup();
  });

  it("draws an unknown directive as its literal source", async () => {
    const view = await mount(':::note{title="Nope"}\n\nBody\n\n:::');
    expect(view.container.querySelector(".rk-chat-callout, details")).toBeNull();
    expect(view.container.textContent).toContain(':::note{title="Nope"}');
    await view.cleanup();
  });
});

describe("web markdown fenced code", () => {
  it("labels a fence and highlights a language it knows", async () => {
    const view = await mount("```ts\nconst a = 1;\n\nconst b = 2;\n```");
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if (view.container.querySelector("pre code span.token")) break;
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
    }
    const code = view.container.querySelector("pre code");
    expect(view.container.querySelector(".rk-chat-markdown-language")?.textContent).toBe("ts");
    expect(code?.textContent).toBe("const a = 1;\n\nconst b = 2;\n");
    expect(code?.querySelectorAll("span.token").length).toBeGreaterThan(0);
    await view.cleanup();
  });

  it("leaves a language Prism does not know as a plain block", async () => {
    const view = await mount("```brainfuck\n+[>+]\n```");
    const code = view.container.querySelector("pre code");
    expect(view.container.querySelector(".rk-chat-markdown-language")?.textContent).toBe(
      "brainfuck",
    );
    expect(code?.querySelectorAll("span.token")).toHaveLength(0);
    expect(code?.textContent).toBe("+[>+]\n");
    await view.cleanup();
  });

  it("still copies the exact source of a highlighted fence", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const source = "const a = 1;\n\n  return a;";
    const view = await mount(`\`\`\`ts\n${source}\n\`\`\``);
    await act(async () => {
      view.container.querySelector("button")?.click();
    });
    expect(writeText).toHaveBeenCalledWith(source);
    await view.cleanup();
    Reflect.deleteProperty(navigator, "clipboard");
  });
});

describe("web markdown wide tables", () => {
  it("keeps a wide table inside its own scroll region", async () => {
    const columns = Array.from({ length: 12 }, (_, index) => `Column ${index + 1}`);
    const values = Array.from({ length: 12 }, (_, index) => `value-${index + 1} padded`);
    const view = await mount(
      `| ${columns.join(" | ")} |\n| ${"--- | ".repeat(12)}\n| ${values.join(" | ")} |`,
    );
    const scroll = view.container.querySelector(".rk-table-scroll");
    expect(scroll).not.toBeNull();
    expect(scroll?.querySelector("table")).not.toBeNull();
    expect(view.container.querySelector(".rk-chat-markdown")?.contains(scroll ?? null)).toBe(true);
    expect(view.container.querySelector(".rk-chat-markdown")?.getAttribute("style")).toBeNull();

    const tableCss = readCss("./markdown-table.css");
    const scrollRule = /\.rk-table-scroll\s*\{([^}]*)\}/.exec(tableCss)?.[1] ?? "";
    expect(scrollRule).toMatch(/overflow(?:-x)?: auto/);
    const markdownCss = readCss("./markdown.web.css");
    expect(/\.rk-chat-markdown\s*\{([^}]*)\}/.exec(markdownCss)?.[1]).toContain("min-width: 0");
    await view.cleanup();
  });
});
