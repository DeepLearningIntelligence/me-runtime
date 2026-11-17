// @vitest-environment jsdom
import type { ComponentProps, ReactElement, ReactNode } from "react";
import { act, cloneElement, isValidElement } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WelcomePage } from "./welcome";

const { inspect, errorText } = vi.hoisted(() => ({
  inspect: vi.fn(),
  errorText: vi.fn((error: unknown) => String(error)),
}));

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
  useLingui: () => ({
    t: (message: { message: string } | TemplateStringsArray) =>
      "message" in message ? message.message : message[0],
  }),
}));
vi.mock("@rakazo/ui-web", () => ({
  Button: ({ render, children, ...props }: ComponentProps<"button"> & { render?: ReactElement }) =>
    isValidElement(render) ? (
      cloneElement(
        render as ReactElement<{ [key: string]: unknown }>,
        props as { [key: string]: unknown },
        children,
      )
    ) : (
      <button {...props}>{children}</button>
    ),
}));
vi.mock("../../lib/rpc", () => ({
  rpc: { invites: { inspect } },
}));
vi.mock("../../lib/user-error", () => ({ errorText }));
vi.mock("../../pages/Auth", () => ({
  submitClass: "",
  AuthFrame: ({ title, children }: { title: ReactNode; children: ReactNode }) => (
    <div>
      <h1>{title}</h1>
      {children}
    </div>
  ),
}));

const entryKey = "me.started-from";

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  vi.clearAllMocks();
  window.sessionStorage.clear();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

async function render(entry = "/welcome?invite=tok-1") {
  await act(async () =>
    root.render(
      <MemoryRouter initialEntries={[entry]}>
        <WelcomePage />
      </MemoryRouter>,
    ),
  );
}

it("names the inviter, says what the product is, and hands the token to sign-in", async () => {
  inspect.mockResolvedValue({ ok: true, inviterName: "Ada", expiresAt: "2026-11-30T00:00:00Z" });
  await render();
  expect(host.textContent).toContain("Ada invited you to me.io");
  expect(host.textContent).toContain("agents");
  const link = host.querySelector('a[href="/sign-in?invite=tok-1"]')!;
  expect(link.textContent).toBe("Continue");
  // Opening an invite link is arriving from WhatsApp, so the flow ends there.
  expect(window.sessionStorage.getItem(entryKey)).toBe("invite");
});

it("shows the refusal's own words and no continue", async () => {
  inspect.mockResolvedValue({
    ok: false,
    reason: "expired",
    message: "That invite link has expired.",
  });
  await render();
  expect(inspect).toHaveBeenCalledWith({ token: "tok-1" });
  expect(host.textContent).toContain("That invite link has expired.");
  expect(host.querySelector('a[href^="/sign-in?invite"]')).toBeNull();
  expect(window.sessionStorage.getItem(entryKey)).toBeNull();
});

it("refuses a link with no token instead of asking the server", async () => {
  inspect.mockResolvedValue({ ok: true, inviterName: "Ada", expiresAt: "" });
  await render("/welcome");
  expect(inspect).not.toHaveBeenCalled();
  expect(host.textContent).toContain("not valid");
});
