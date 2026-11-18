// @vitest-environment jsdom
import type { ComponentProps, ReactElement, ReactNode } from "react";
import { act, cloneElement, isValidElement } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MeOnboardingPage } from "./flow";

const {
  me,
  messagingStatus,
  botsList,
  linkStart,
  invitesList,
  updateUser,
  notify,
  ensureFirstBot,
  fetchAuthCapabilities,
} = vi.hoisted(() => ({
  me: vi.fn(),
  messagingStatus: vi.fn(),
  botsList: vi.fn(),
  linkStart: vi.fn(),
  invitesList: vi.fn(),
  updateUser: vi.fn(),
  notify: vi.fn(),
  ensureFirstBot: vi.fn(),
  fetchAuthCapabilities: vi.fn(),
}));

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@lingui/core/macro", () => ({
  t: (message: TemplateStringsArray | { message: string }, ...values: unknown[]) =>
    "message" in message
      ? message.message
      : message.reduce((text, part, index) => text + part + (values[index] ?? ""), ""),
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
  Input: (props: ComponentProps<"input">) => <input {...props} />,
  Label: ({ children, htmlFor, ...props }: ComponentProps<"label">) => (
    <label htmlFor={htmlFor} {...props}>
      {children}
    </label>
  ),
}));
vi.mock("../../lib/rpc", () => ({
  rpc: {
    me,
    messaging: { status: messagingStatus, link: { start: linkStart } },
    bots: { list: botsList },
    invites: { list: invitesList },
  },
}));
vi.mock("../../lib/auth", () => ({
  authClient: { updateUser, $store: { notify } },
}));
vi.mock("../../lib/auth-capabilities", () => ({ fetchAuthCapabilities }));
vi.mock("../../pages/onboarding/first-bot", () => ({ ensureFirstBot }));
vi.mock("../../pages/Auth", () => ({ submitClass: "" }));
vi.mock("../../lib/user-error", () => ({
  errorText: (error: unknown) => String(error),
}));

function readyOverrides() {
  fetchAuthCapabilities.mockResolvedValue({
    passwordAuth: true,
    sso: null,
    passwordReset: false,
    resetUrl: null,
    whatsappChatUrl: "https://wa.me/15550001",
  });
  messagingStatus.mockResolvedValue({
    enabled: true,
    providers: ["whatsapp"],
    identities: [],
  });
  botsList.mockResolvedValue([]);
  linkStart.mockResolvedValue({ code: "123-456", expiresAt: "2026-11-17T00:30:00Z" });
  invitesList.mockResolvedValue({
    quota: { allocation: 10, grantedCount: 3, redeemedCount: 0 },
    invites: [],
  });
}

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  vi.clearAllMocks();
  window.sessionStorage.clear();
  readyOverrides();
  me.mockResolvedValue({
    userId: "u1",
    name: "Phone person",
    email: "phone-x@phone.invalid",
    spaceId: "s1",
  });
  ensureFirstBot.mockResolvedValue({ id: "bot1" });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

async function render(entry = "/onboarding") {
  await act(async () =>
    root.render(
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route path="/onboarding/:step?" element={<MeOnboardingPage />} />
          <Route path="/app" element={<p>Portal</p>} />
        </Routes>
      </MemoryRouter>,
    ),
  );
}

function button(text: string) {
  return [...host.querySelectorAll("button")].find((button) => button.textContent === text);
}

async function click(text: string) {
  await act(async () => button(text)!.click());
}

it("sends a person who is already set up straight to the portal", async () => {
  me.mockResolvedValue({ userId: "u1", name: "Ada", email: "a@x.test", spaceId: "s1" });
  messagingStatus.mockResolvedValue({
    enabled: true,
    providers: ["whatsapp"],
    identities: [
      { id: "i1", provider: "whatsapp", address: "1555", botId: "bot1", botName: "Chief" },
    ],
  });
  botsList.mockResolvedValue([{ id: "bot1" }]);
  await render();
  expect(host.textContent).toContain("Portal");
  expect(host.textContent).not.toContain("What should we call you?");
});

it("walks name, email, WhatsApp, invites and ends on Back to WhatsApp after an invite", async () => {
  window.sessionStorage.setItem("me.started-from", "invite");
  await render();
  expect(host.querySelector("h1")!.textContent).toBe("What should we call you?");
  await act(async () => {
    const input = host.querySelector<HTMLInputElement>("input[name=name]")!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "Ada");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  updateUser.mockResolvedValue({ error: null });
  await click("Continue");
  expect(updateUser).toHaveBeenCalledWith({ name: "Ada" });
  expect(host.querySelector("h1")!.textContent).toBe("Add your email");
  await click("Skip for now");
  expect(host.querySelector("h1")!.textContent).toBe("Where will you use me?");
  await click("Continue");
  expect(host.querySelector("h1")!.textContent).toBe("Connect WhatsApp");
  expect(host.textContent).toContain("Send the pre-filled message");
  await click("Skip for now");
  expect(host.textContent).toContain("0 of 10 invites used");
  expect(host.textContent).toContain("Each friend who joins can connect their agents to yours.");
  await click("Continue");
  expect(host.querySelector("h1")!.textContent).toBe("You’re connected");
  const back = host.querySelector('a[href="https://wa.me/15550001"]')!;
  expect(back.textContent).toBe("Back to WhatsApp");
  // The wa.me links navigate in the same tab (F6); no new-tab navigation to drop.
  expect(back.getAttribute("target")).toBeNull();
});

it("ends in the portal with WhatsApp offered when the person started on the web", async () => {
  // An account that already gave its name and linked WhatsApp, but has no bot.
  me.mockResolvedValue({ userId: "u1", name: "Ada", email: "a@x.test", spaceId: "s1" });
  messagingStatus.mockResolvedValue({
    enabled: true,
    providers: ["whatsapp"],
    identities: [
      { id: "i1", provider: "whatsapp", address: "1555", botId: "bot1", botName: "Chief" },
    ],
  });
  await render();
  // The missing bot sends the person through the link step, which the poll
  // completes on its own because their WhatsApp is already linked.
  expect(host.querySelector("h1")!.textContent).toBe("Invite friends");
  await click("Continue");
  expect(host.querySelector("h1")!.textContent).toBe("You’re connected");
  const portal = [...host.querySelectorAll("button")].find(
    (button) => button.textContent === "Open the portal",
  )!;
  await act(async () => portal.click());
  expect(host.textContent).toContain("Portal");
});
