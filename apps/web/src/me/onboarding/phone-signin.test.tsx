// @vitest-environment jsdom
import type { ComponentProps, ReactElement, ReactNode } from "react";
import { act, cloneElement, isValidElement } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DoorError, type StartedDoor } from "./door";
import { PhoneDoorPanel } from "./phone-signin";

const { startPhoneDoor, verifyPhoneDoor, notify } = vi.hoisted(() => ({
  startPhoneDoor: vi.fn(),
  verifyPhoneDoor: vi.fn(),
  notify: vi.fn(),
}));

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
  useLingui: () => ({ t: (message: { message: string }) => message.message }),
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
  InputOTP: ({ value, onChange, children: _children, ...props }: ComponentProps<"input">) => (
    <input
      {...props}
      value={value}
      onChange={(event) => onChange?.(event.target.value)}
    />
  ),
  InputOTPGroup: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  InputOTPSlot: () => null,
}));
vi.mock("../../lib/auth", () => ({
  authClient: { $store: { notify } },
}));
// Only the network half is replaced; doorRefusal and the copy stay real, so
// the component test exercises the sticky refusal as it ships.
vi.mock("./door", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./door")>();
  return { ...actual, startPhoneDoor, verifyPhoneDoor };
});

const DOOR: StartedDoor = {
  nonce: "ME-TESTNONCE1",
  waLink: "https://wa.me/15550001111?text=ME-TESTNONCE1",
  expiresAt: new Date(Date.now() + 600_000).toISOString(),
  ttlMs: 600_000,
};

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

async function render(entry = "/sign-in") {
  await act(async () =>
    root.render(
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route path="/sign-in" element={<PhoneDoorPanel onSignedIn={() => {}} />} />
        </Routes>
      </MemoryRouter>,
    ),
  );
}

async function click(text: string) {
  const button = [...host.querySelectorAll("button")].find(
    (candidate) => candidate.textContent === text,
  );
  await act(async () => button!.click());
}

async function typeCode(code: string) {
  await act(async () => {
    const input = host.querySelector<HTMLInputElement>("input")!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, code);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

it("keeps an invite refusal on screen when a later code fails on the same door", async () => {
  startPhoneDoor.mockResolvedValue(DOOR);
  verifyPhoneDoor
    .mockRejectedValueOnce(new DoorError("invite_required"))
    .mockRejectedValueOnce(new DoorError("code_invalid"));

  await render();
  await click("Continue");
  await typeCode("654321");
  await click("Verify");
  expect(host.querySelector("[role=alert]")!.textContent).toContain("invite-only");

  // The wrong-code message must not replace the invite refusal.
  await typeCode("654321");
  await click("Verify");
  expect(host.querySelector("[role=alert]")!.textContent).toContain("invite-only");
  expect(host.querySelector("[role=alert]")!.textContent).not.toContain("not right");

  // A fresh door clears it.
  await click("Start over");
  expect(host.querySelector("[role=alert]")).toBeNull();
});
