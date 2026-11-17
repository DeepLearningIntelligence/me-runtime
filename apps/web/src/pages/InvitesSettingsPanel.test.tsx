// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const invites = vi.hoisted(() => ({
  list: vi.fn(),
  issue: vi.fn(),
  revoke: vi.fn(),
}));

vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((text, part, index) => `${text}${index > 0 ? values[index - 1] : ""}${part}`, "");
  return {
    useLingui: () => ({ t, i18n: { locale: "en" } }),
    Trans: ({ children }: { children: ReactNode }) => children,
  };
});
vi.mock("@rakazo/ui-web", () => {
  const toast = vi.fn();
  return {
    Button: (props: Record<string, unknown>) => <button type="button" {...props} />,
    toast,
  };
});
vi.mock("../lib/rpc", () => ({ rpc: { invites } }));

import { InvitesSettingsPanel, inviteLinkUrl } from "./InvitesSettingsPanel";

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

const listResponse = {
  quota: { allocation: 10, grantedCount: 2, redeemedCount: 1 },
  invites: [
    {
      id: "inv_1",
      status: "issued" as const,
      createdAt: "2026-11-16T00:00:00.000Z",
      expiresAt: "2999-12-01T00:00:00.000Z",
      redeemedAt: null,
    },
    {
      id: "inv_2",
      status: "redeemed" as const,
      createdAt: "2026-11-01T00:00:00.000Z",
      expiresAt: "2026-11-15T00:00:00.000Z",
      redeemedAt: "2026-11-10T00:00:00.000Z",
    },
  ],
};

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  invites.list.mockReset().mockResolvedValue(listResponse);
  invites.issue.mockReset();
  invites.revoke.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

function byTestId(testId: string): HTMLElement {
  const found = document.querySelector(`[data-testid="${testId}"]`);
  if (!found) throw new Error(`Missing element: ${testId}`);
  return found as HTMLElement;
}

it("shows the meter as links minted of the allowance", async () => {
  await act(async () => root.render(<InvitesSettingsPanel />));
  await flush();
  expect(byTestId("invites-meter").textContent).toBe("2 of 10 used");
  expect(document.body.textContent).toContain("8 left");
});

it("mints a link, shows it once beside copy and share, and reloads the meter", async () => {
  invites.issue.mockResolvedValue({
    id: "inv_3",
    token: "raw-token-once",
    expiresAt: "2026-11-30T00:00:00.000Z",
  });
  await act(async () => root.render(<InvitesSettingsPanel />));
  await flush();
  const mint = [...document.querySelectorAll("button")].find(
    (button) => button.textContent === "New link",
  )!;
  await act(async () => mint.click());
  await flush();
  expect(invites.issue).toHaveBeenCalledOnce();
  expect(invites.list.mock.calls.length).toBeGreaterThanOrEqual(2);
  const link = byTestId("invites-issued-url");
  expect(link.textContent).toBe(inviteLinkUrl("raw-token-once"));
  expect(link.textContent).toContain("/welcome?invite=raw-token-once");
});

it("lists minted links with their state and withdraws an unused one", async () => {
  invites.revoke.mockResolvedValue({ ok: true });
  await act(async () => root.render(<InvitesSettingsPanel />));
  await flush();
  const list = byTestId("invites-list");
  expect(list.textContent).toContain("Active");
  expect(list.textContent).toContain("Used");
  const withdraw = [...list.querySelectorAll("button")].find(
    (button) => button.textContent === "Withdraw",
  )!;
  await act(async () => withdraw.click());
  await flush();
  expect(invites.revoke).toHaveBeenCalledWith({ id: "inv_1" });
});

it("offers no minting once the allowance is spent", async () => {
  invites.list.mockResolvedValue({
    quota: { allocation: 10, grantedCount: 10, redeemedCount: 7 },
    invites: [],
  });
  await act(async () => root.render(<InvitesSettingsPanel />));
  await flush();
  const mint = [...document.querySelectorAll("button")].find(
    (button) => button.textContent === "New link",
  )!;
  expect((mint as HTMLButtonElement).disabled).toBe(true);
});
