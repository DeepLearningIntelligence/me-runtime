import type { Auth } from "@rakazo/auth";
import type { PrismaClient } from "@rakazo/db";
import type { Context, Hono } from "hono";
import { setSignedCookie } from "hono/cookie";
import type { AppEnv } from "../../env.js";
import { readBoundedBody } from "../../http-body.js";
import { InviteError } from "../invitations/invitations.js";
import { whatsAppDeepLink } from "../whatsapp-router.js";
import { CODE_TTL_MS } from "./codes.js";
import { PhoneSigninError, start, verify } from "./service.js";
import { signInVerifiedPhone } from "./session.js";

/**
 * The phone door's HTTP half, mounted beside the auth routes so a person signs
 * in the same way every other method does. The browser keeps the nonce itself
 * (page state, packet H); the server stores only its hash, so a stolen
 * database copy cannot open a door.
 */

const BODY_BYTES = 4 * 1024;

type Status = 400 | 401 | 403 | 409 | 410 | 429 | 503;

const REFUSAL_STATUS: Record<string, { status: Status }> = {
  identity_key_missing: { status: 503 },
  invalid_phone: { status: 400 },
  rate_limited: { status: 429 },
  nonce_unknown: { status: 410 },
  code_expired: { status: 410 },
  already_bound: { status: 409 },
  phone_mismatch: { status: 403 },
  code_invalid: { status: 400 },
  too_many_attempts: { status: 429 },
  // Account creation through the phone door is invite-only; the named reasons
  // are the invitations service's own (see INVITE_FAILURE_MESSAGE).
  invite_required: { status: 403 },
  invite_invalid: { status: 403 },
};

export function mountPhoneSigninRoutes(
  app: Hono,
  deps: {
    prisma: PrismaClient;
    auth: Auth;
    env: AppEnv;
    clientIp: (c: Context) => string | undefined;
  },
) {
  const config = { identityHashKey: deps.env.meIdentityHashKey };

  app.post("/api/auth/phone/start", async (c) => {
    // The link must be deliverable before any row exists.
    if (!deps.env.whatsappBusinessNumber) {
      return refusal(c, "whatsapp_not_configured", 503);
    }
    const parsed = await parseBody(c);
    if (!parsed) return refusal(c, "invalid_input", 400);
    const phone =
      typeof parsed.phone === "string" && parsed.phone.trim() ? parsed.phone.trim() : undefined;
    const inviteToken =
      typeof parsed.inviteToken === "string" && parsed.inviteToken.trim()
        ? parsed.inviteToken.trim()
        : undefined;
    try {
      const started = await start(deps.prisma, config, {
        phone,
        inviteToken,
        ipAddress: deps.clientIp(c),
      });
      return c.json({
        ok: true,
        nonce: started.nonce,
        waLink: whatsAppDeepLink(deps.env, started.nonce),
        expiresAt: started.expiresAt.toISOString(),
        ttlMs: CODE_TTL_MS,
      });
    } catch (error) {
      return refused(c, error);
    }
  });

  app.post("/api/auth/phone/verify", async (c) => {
    const parsed = await parseBody(c);
    if (!parsed) return refusal(c, "invalid_input", 400);
    const nonce = typeof parsed.nonce === "string" ? parsed.nonce : undefined;
    const code = typeof parsed.code === "string" ? parsed.code : undefined;
    if (!nonce || !code) return refusal(c, "invalid_input", 400);
    try {
      const { phoneHash, inviteTokenHash } = await verify(deps.prisma, config, { nonce, code });
      const person = await signInVerifiedPhone(
        deps.prisma,
        deps.auth,
        deps.env,
        phoneHash,
        {
          ipAddress: deps.clientIp(c),
          userAgent: c.req.header("user-agent"),
        },
        inviteTokenHash,
      );
      await setSessionCookie(c, deps.auth, person.token, person.expiresAt);
      return c.json({ ok: true });
    } catch (error) {
      return refused(c, error);
    }
  });
}

async function parseBody(c: Context): Promise<Record<string, unknown> | null> {
  const raw = await readBoundedBody(c.req.raw, BODY_BYTES);
  if (raw === null) return null;
  if (raw === "") return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function refusal(c: Context, reason: string, status: Status) {
  return c.json({ error: reason }, status);
}

function refused(c: Context, error: unknown) {
  if (error instanceof PhoneSigninError) {
    return refusal(c, error.reason, (REFUSAL_STATUS[error.reason] ?? { status: 400 }).status);
  }
  // A redemption refused at person-creation time carries the invitations
  // service's own named reason; no user row was written.
  if (error instanceof InviteError) return refusal(c, error.reason, 403);
  throw error;
}

/** The same signed cookie Better Auth issues, read back by the same auth layer. */
async function setSessionCookie(
  c: Context,
  auth: Auth,
  token: string,
  expiresAt: Date,
): Promise<void> {
  const context = await auth.$context;
  const cookie = context.authCookies.sessionToken;
  await setSignedCookie(c, cookie.name, token, context.secret, {
    ...cookie.attributes,
    maxAge: Math.max(1, Math.floor((expiresAt.getTime() - Date.now()) / 1000)),
  });
}
