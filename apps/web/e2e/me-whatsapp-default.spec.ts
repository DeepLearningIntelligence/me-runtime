import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";

/**
 * ME-RUN-005 on the real page: the door's verify answer carries the named
 * `whatsapp` state, the flow skips the manual link step for it, and the done
 * screen and account menu show it. Everything behind the page is mocked; the
 * verify route records the request and response bodies this file asserts.
 */

const ME = {
  maxUploadSizeBytes: 10_000_000,
  ticketBoardEnabled: false,
  userId: "u1",
  email: "phone-1@phone.invalid",
  name: "Phone person",
  spaceId: "s1",
  isDeploymentOwner: false,
  needsModel: false,
  defaultProvider: null,
  defaultModel: null,
  hostCredentialProvider: null,
  hostCredentialSource: null,
  computerHost: null,
  canChooseHostComputer: false,
  sandboxProvider: "docker",
  avatarStyle: "robot",
  billingEnabled: false,
  isAdmin: false,
  mcpStdioEnabled: false,
  phoneCallsEnabled: false,
  navLinks: [],
} as const;

const EMPTY_BOOTSTRAP = {
  me: ME,
  bots: [],
  groups: [],
  botSections: [],
  archivedBots: [],
  archivedGroups: [],
  thread: null,
  routines: [],
  spaces: [],
};

const SESSION = {
  session: {
    id: "sess-1",
    userId: "u1",
    token: "token-placeholder",
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    ipAddress: null,
    userAgent: null,
  },
  user: {
    id: "u1",
    name: "Phone person",
    email: "phone-1@phone.invalid",
    emailVerified: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
};

type DoorMocks = {
  verifyRequests: Array<Record<string, unknown>>;
  verifyResponses: Array<Record<string, unknown>>;
};

/** The door: a mocked phone sign-in whose verify answer is captured. */
async function mockDoor(page: Page, whatsappState: string): Promise<DoorMocks> {
  let sessionOpen = false;
  await page.route("**/api/auth/get-session**", (route) =>
    route.fulfill({ json: sessionOpen ? SESSION : null }),
  );
  await page.route("**/api/auth/capabilities", (route) =>
    route.fulfill({
      json: {
        passwordAuth: true,
        sso: null,
        passwordReset: false,
        resetUrl: null,
        phoneSignin: true,
        whatsappChatUrl: "https://wa.me/15550001",
      },
    }),
  );
  await page.route("**/api/auth/phone/start", (route) =>
    route.fulfill({
      json: {
        ok: true,
        nonce: "ME-P14TST",
        waLink: "https://wa.me/15550001?text=ME-P14TST",
        businessNumber: "+1 555 000 1111",
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
        ttlMs: 600_000,
      },
    }),
  );
  const verifyRequests: Array<Record<string, unknown>> = [];
  const verifyResponses: Array<Record<string, unknown>> = [];
  // The name step saves through Better Auth; the door's own endpoints above
  // and this update call are all this test's server.
  await page.route("**/api/auth/update-user", (route) => route.fulfill({ json: {} }));
  await page.route("**/api/auth/phone/verify", async (route) => {
    verifyRequests.push(route.request().postDataJSON() as Record<string, unknown>);
    const response = { ok: true, whatsapp: whatsappState };
    verifyResponses.push(response);
    sessionOpen = true;
    await route.fulfill({ json: response });
  });
  return { verifyRequests, verifyResponses };
}

/** The signed-in app behind the onboarding flow and the account menu. */
async function mockSignedInApp(page: Page, options: { whatsapp?: string } = {}) {
  // Registered first: this Playwright version lets the last matching route
  // win, so every specific mock below answers before this default does.
  await page.route("**/rpc/**", (route) => route.fulfill({ json: {} }));
  await page.route("**/rpc/bootstrap", (route) =>
    route.fulfill({ json: { json: EMPTY_BOOTSTRAP } }),
  );
  await page.route("**/rpc/me", (route) => route.fulfill({ json: { json: ME } }));
  await page.route("**/rpc/messaging/status", (route) =>
    route.fulfill({
      json: {
        json: {
          enabled: true,
          providers: ["whatsapp"],
          openSignup: false,
          identities: options.whatsapp
            ? [
                {
                  id: "i1",
                  provider: "whatsapp",
                  address: "15550001000",
                  botId: "bot1",
                  botName: "Chief",
                },
              ]
            : [],
        },
      },
    }),
  );
  await page.route("**/rpc/bots/list", (route) => route.fulfill({ json: { json: [] } }));
  await page.route("**/rpc/bots/listArchived", (route) => route.fulfill({ json: { json: [] } }));
  await page.route("**/rpc/groups/listArchived", (route) => route.fulfill({ json: { json: [] } }));
  await page.route("**/rpc/spaces/list", (route) => route.fulfill({ json: { json: [] } }));
  await page.route("**/rpc/invites/list", (route) =>
    route.fulfill({
      json: { json: { quota: { allocation: 10, redeemedCount: 0 }, invites: [] } },
    }),
  );
  await page.route("**/rpc/organizations/list", (route) =>
    route.fulfill({ json: { json: [] } }),
  );
}

test("the verify answer says whatsapp linked and the flow skips the manual link step", async ({
  page,
}) => {
  const door = await mockDoor(page, "linked");
  await mockSignedInApp(page);
  await page.goto("/sign-in");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("link", { name: "Open WhatsApp" })).toBeVisible();
  await page.getByRole("textbox", { name: "Code" }).fill("654321");
  // The door auto-verifies the sixth digit; no button click needed.
  await expect.poll(() => door.verifyRequests.length, { timeout: 10_000 }).toBeGreaterThan(0);

  // The door's verify: the request and the response body this packet proves.
  await expect(door.verifyRequests[0]).toEqual({ nonce: "ME-P14TST", code: "654321" });
  await expect(door.verifyResponses[0]).toEqual({ ok: true, whatsapp: "linked" });

  // The shell finds an empty account and opens onboarding; the saved link
  // state skips the manual "Connect WhatsApp" step entirely.
  await expect(page.getByRole("heading", { name: "What should we call you?" })).toBeVisible({
    timeout: 20_000,
  });
  await page.getByLabel("Name").fill("Ada");
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "Skip for now" }).click();
  await expect(page.getByRole("heading", { name: "Where will you use me?" })).toBeVisible();
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { name: "Invite friends" })).toBeVisible();
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { name: "You’re connected" })).toBeVisible();
  // The done screen's primary button goes back to the chat the person came from.
  const back = page.getByRole("link", { name: "Back to WhatsApp" });
  await expect(back).toBeVisible();
  expect(await back.getAttribute("href")).toBe("https://wa.me/15550001");
  expect(await back.getAttribute("target")).toBeNull();
  await expect(page.getByRole("button", { name: "Open the portal" })).toBeVisible();
  // The done screen, at the desktop width and at the phone width.
  await page.screenshot({ path: "../../FORK.d/shots/P14/done-1280.png", fullPage: false });
  await page.setViewportSize({ width: 375, height: 700 });
  await expect(page.getByRole("link", { name: "Back to WhatsApp" })).toBeVisible();
  await page.screenshot({ path: "../../FORK.d/shots/P14/done-375.png", fullPage: false });
});

test("linked_elsewhere reaches the done screen with the number's story", async ({ page }) => {
  const door = await mockDoor(page, "linked_elsewhere");
  await mockSignedInApp(page);
  await page.goto("/sign-in");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("link", { name: "Open WhatsApp" })).toBeVisible();
  await page.getByRole("textbox", { name: "Code" }).fill("654321");
  await expect.poll(() => door.verifyRequests.length, { timeout: 10_000 }).toBeGreaterThan(0);
  await expect(door.verifyResponses[0]).toEqual({ ok: true, whatsapp: "linked_elsewhere" });
  await expect(page.getByRole("heading", { name: "What should we call you?" })).toBeVisible({
    timeout: 20_000,
  });
  await page.getByLabel("Name").fill("Ada");
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "Skip for now" }).click();
  await page.getByRole("button", { name: "Continue" }).click();
  // The manual link step is still there for a number that cannot link itself.
  await expect(page.getByRole("heading", { name: "Connect WhatsApp" })).toBeVisible();
});

test("the account menu shows the WhatsApp row, connected or connectable", async ({ page }) => {
  await page.route("**/api/auth/get-session**", (route) =>
    route.fulfill({ json: SESSION }),
  );
  await page.route("**/api/auth/capabilities", (route) =>
    route.fulfill({
      json: {
        passwordAuth: true,
        sso: null,
        passwordReset: false,
        resetUrl: null,
        phoneSignin: true,
        whatsappChatUrl: "https://wa.me/15550001",
      },
    }),
  );
  // The shell answers nothing real here; only the account menu's status is set.
  await page.route("**/rpc/**", (route) => route.fulfill({ json: {} }));
  await page.route("**/rpc/messaging/status", (route) =>
    route.fulfill({
      json: {
        json: {
          enabled: true,
          providers: ["whatsapp"],
          openSignup: false,
          identities: [
            {
              id: "i1",
              provider: "whatsapp",
              address: "15550001000",
              botId: "bot1",
              botName: "Chief",
            },
          ],
        },
      },
    }),
  );
  await page.goto("/app");
  await expect(page.getByTestId("user-menu-trigger")).toBeVisible({ timeout: 20_000 });
  await page.getByTestId("user-menu-trigger").click();
  const row = page.getByTestId("whatsapp-menu-row");
  await expect(row).toBeVisible();
  await expect(row).toContainText("Connected · Chief");
  await page.screenshot({ path: "../../FORK.d/shots/P14/account-menu-1280.png", fullPage: false });

  await page.setViewportSize({ width: 375, height: 700 });
  // The narrow shell keeps the account behind its navigation drawer.
  const navigation = page.getByRole("button", { name: "Open navigation" });
  if (await navigation.isVisible().catch(() => false)) {
    await navigation.click();
  }
  await page.getByTestId("user-menu-trigger").click();
  await expect(page.getByTestId("whatsapp-menu-row")).toBeVisible();
  await page.screenshot({ path: "../../FORK.d/shots/P14/account-menu-375.png", fullPage: false });
});
