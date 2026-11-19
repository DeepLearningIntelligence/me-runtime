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
  InputOTP: ({
    value,
    onChange,
    children: _children,
    ...props
  }: Omit<ComponentProps<"input">, "onChange"> & {
    value: string;
    onChange?: (value: string) => void;
  }) => (
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
  businessNumber: "+1 555 000 1111",
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

it("shows the code to send by hand, with a labelled copy button, and the business number", async () => {
  startPhoneDoor.mockResolvedValue(DOOR);
  const writeText = vi.fn(async () => {});
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });

  await render();
  await click("Continue");
  expect(host.textContent).toContain(DOOR.nonce);
  // The number cannot break mid-number at a narrow width (jsdom lays out
  // nothing; the markup contract is the nowrap span, the screenshot proves it).
  const numberSpan = host.querySelector("span.whitespace-nowrap")!;
  expect(numberSpan).not.toBeNull();
  expect(numberSpan.textContent).toBe(DOOR.businessNumber);
  expect(host.textContent).toContain("Or send this code on WhatsApp to +1 555 000 1111");

  const copy = host.querySelector<HTMLButtonElement>('button[aria-label="Copy sign-in code"]')!;
  expect(copy).not.toBeNull();
  await act(async () => copy.click());
  expect(writeText).toHaveBeenCalledWith(DOOR.nonce);
  expect(copy.textContent).toBe("Copied");
});

it("opens WhatsApp in the same tab, so no navigation is silently dropped", async () => {
  startPhoneDoor.mockResolvedValue(DOOR);

  await render();
  await click("Continue");
  const link = host.querySelector<HTMLAnchorElement>(`a[href="${DOOR.waLink}"]`)!;
  expect(link).not.toBeNull();
  expect(link.getAttribute("target")).toBeNull();
  expect(link.getAttribute("rel")).toBeNull();
});

it("keeps the door across a page reload, and the restored door still verifies", async () => {
  startPhoneDoor.mockResolvedValue(DOOR);
  verifyPhoneDoor.mockResolvedValue({ whatsapp: "linked" });

  await render();
  await click("Continue");
  expect(startPhoneDoor).toHaveBeenCalledTimes(1);

  // The same-tab round trip through WhatsApp lands on a reload: a fresh mount
  // with the browser's own storage intact.
  await act(async () => root.unmount());
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await render();

  expect(startPhoneDoor).toHaveBeenCalledTimes(1);
  expect(host.textContent).toContain(DOOR.nonce);
  await typeCode("654321");
  await click("Verify");
  expect(verifyPhoneDoor).toHaveBeenCalledWith({ nonce: DOOR.nonce, code: "654321" });
  // The verify answer's link state rides with the journey to the flow.
  expect(window.sessionStorage.getItem("me.whatsapp-link")).toBe("linked");
  expect(window.sessionStorage.getItem("me.phone-door")).toBeNull();
});

it("stores no WhatsApp state when the verify refuses", async () => {
  startPhoneDoor.mockResolvedValue(DOOR);
  verifyPhoneDoor.mockRejectedValue(new DoorError("code_invalid"));

  await render();
  await click("Continue");
  await typeCode("654321");
  await click("Verify");
  // A refused verify never claims a link state.
  expect(window.sessionStorage.getItem("me.whatsapp-link")).toBeNull();
});

it("opens no restored door whose code has expired", async () => {
  startPhoneDoor.mockResolvedValue({
    ...DOOR,
    expiresAt: new Date(Date.now() - 1000).toISOString(),
  });

  await render();
  await click("Continue");
  await act(async () => root.unmount());
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await render();

  expect(host.textContent).toContain("We send a sign-in code");
  await click("Continue");
  expect(startPhoneDoor).toHaveBeenCalledTimes(2);
});
