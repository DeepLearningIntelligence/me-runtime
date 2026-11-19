import type { JobPublisher, SecretStore } from "@rakazo/adapter-kit";
import { messagingDeliverJob } from "@rakazo/adapter-kit";
import type { Auth } from "@rakazo/auth";
import { PII_TUNNEL_TOKEN_MS } from "@rakazo/auth";
import type { PrismaClient } from "@rakazo/db";
import { runAsSystem } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import type { Context, Hono } from "hono";
import type { AppEnv } from "../../env.js";
import { readBoundedBody } from "../../http-body.js";
import { piiTunnelUrl } from "./url.js";
import { seal } from "./vault.js";

/**
 * The authenticated PII tunnel (QW-12).
 *
 * `GET /api/me/pii-tunnel` mints a signed link for the signed-in person. The
 * link opens an upload page after that person signs in; nothing travels over
 * WhatsApp except the link itself. The token is consumed by the GET that
 * renders the page, so one link opens once, and the POST that stores the
 * upload is authorized by the same session cookie.
 */

const BODY_BYTES = 64 * 1024;
const THANK_YOU_BODY = "PII uploaded via the tunnel - thank you.";

const FIELD_LIMITS = {
  service: 200,
  username: 200,
  password: 1_000,
  notes: 2_000,
} as const;

type PiiUploadInput = {
  service?: string;
  username: string;
  password: string;
  notes?: string;
};

export interface PiiTunnelRouteDeps {
  prisma: PrismaClient;
  auth: Pick<Auth, "api" | "issuePIITunnelToken" | "consumePIITunnelToken">;
  env: AppEnv;
  jobs: Pick<JobPublisher, "enqueue">;
  secretStore: Pick<SecretStore, "put" | "load">;
}

export function mountPiiTunnelRoutes(app: Hono, deps: PiiTunnelRouteDeps): void {
  const session = (c: Context) => deps.auth.api.getSession({ headers: c.req.raw.headers });
  const signIn = () => `${deps.env.webOrigin}/sign-in`;

  app.get("/api/me/pii-tunnel", async (c) => {
    const found = await session(c);
    if (!found) return c.json({ error: "unauthorized" }, 401);
    const token = await deps.auth.issuePIITunnelToken(found.user.id);
    return c.json({
      url: piiTunnelUrl(token),
      expiresAt: new Date(Date.now() + PII_TUNNEL_TOKEN_MS).toISOString(),
    });
  });

  // The signed link and the form post share a path. `/pii/:token` is the public
  // page the link names; `/api/pii/:token` keeps the JSON form reachable under
  // the API prefix every other route uses.
  for (const path of ["/pii/:token", "/api/pii/:token"] as const) {
    app.get(path, async (c) => {
      const found = await session(c);
      if (!found) return c.redirect(signIn(), 303);
      const ownerId = await deps.auth.consumePIITunnelToken(c.req.param("token"));
      // Consuming before the owner check burns a link opened by the wrong
      // session, which is the safe side of a leak.
      if (!ownerId || ownerId !== found.user.id) return refusalPage(c);
      return new Response(uploadPage(), {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "referrer-policy": "no-referrer",
          "x-frame-options": "DENY",
          "content-security-policy":
            "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
        },
      });
    });

    app.post(path, async (c) => {
      const found = await session(c);
      if (!found) return c.redirect(signIn(), 303);
      const raw = await readBoundedBody(c.req.raw, BODY_BYTES);
      if (raw === null) return c.json({ error: "invalid_input" }, 400);
      const input = parseUpload(raw, c.req.header("content-type"));
      if (!input) return c.json({ error: "invalid_input" }, 400);
      const sealed = await seal(deps.secretStore, JSON.stringify(input), found.user.id);
      const upload = await runAsSystem(
        "pii tunnel: store the signed-in person's sealed upload",
        () =>
          deps.prisma.piiUpload.create({
            data: {
              userId: found.user.id,
              secretId: sealed.id,
              ciphertext: sealed.ciphertext,
            },
            select: { id: true },
          }),
      );
      // The receipt is best-effort: the upload already landed, and a chat
      // outage must not turn a stored upload into an error for the person.
      await notifyUploaded(deps, found.user.id, upload.id);
      return c.json({ ok: true });
    });
  }
}

/**
 * Queues the one receipt the person sees. A person without a chat identity
 * gets a named log line instead of a silent miss.
 */
async function notifyUploaded(
  deps: PiiTunnelRouteDeps,
  userId: string,
  uploadId: string,
): Promise<void> {
  try {
    const identity = await runAsSystem("pii tunnel: find the person's chat identity", () =>
      deps.prisma.messagingIdentity.findFirst({
        where: { userId },
        orderBy: { createdAt: "desc" },
        select: { id: true },
      }),
    );
    if (!identity) {
      getLogger().warn("pii tunnel upload has no messaging identity to notify", {
        "user.id": userId,
      });
      return;
    }
    await runAsSystem("pii tunnel: queue the upload receipt", () =>
      deps.prisma.messagingOutbound.createMany({
        data: [
          {
            idempotencyKey: `pii-upload:${uploadId}`,
            kind: "dm",
            identityId: identity.id,
            body: THANK_YOU_BODY,
          },
        ],
        skipDuplicates: true,
      }),
    );
    await deps.jobs.enqueue(messagingDeliverJob()).catch((error) => {
      getLogger().error("pii tunnel receipt enqueue error", error);
    });
  } catch (error) {
    getLogger().error("pii tunnel receipt failed; upload was stored", error, {
      "user.id": userId,
    });
  }
}

function parseUpload(raw: string, contentType: string | undefined): PiiUploadInput | null {
  let fields: Record<string, unknown>;
  if (contentType?.includes("application/x-www-form-urlencoded")) {
    fields = Object.fromEntries(new URLSearchParams(raw).entries());
  } else {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
      fields = parsed as Record<string, unknown>;
    } catch {
      return null;
    }
  }
  const exact = (name: keyof typeof FIELD_LIMITS): string | undefined => {
    const value = fields[name];
    if (typeof value !== "string" || value.length === 0 || value.length > FIELD_LIMITS[name]) {
      return undefined;
    }
    return value;
  };
  const username = exact("username");
  const password = exact("password");
  if (!username?.trim() || !password) return null;
  const trimmed = (name: "service" | "notes"): string | undefined => {
    const value = exact(name);
    return value?.trim() || undefined;
  };
  const service = trimmed("service");
  const notes = trimmed("notes");
  return {
    ...(service ? { service } : {}),
    username,
    password,
    ...(notes ? { notes } : {}),
  };
}

function refusalPage(c: Context) {
  return c.html(
    `<!doctype html>
<html lang="en">
<head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /><title>Link not available</title></head>
<body style="font-family: system-ui, sans-serif; margin: 0; padding: 2rem; color: #1f2937;">
<main style="max-width: 34rem; margin: 0 auto;">
<h1 style="font-size: 1.35rem;">This link is not available</h1>
<p>It has expired or was already opened. Ask for a new link and open it in the same browser where you sign in.</p>
</main>
</body>
</html>`,
    400,
    { "cache-control": "no-store", "referrer-policy": "no-referrer" },
  );
}

function uploadPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Upload your credentials</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: system-ui, sans-serif; margin: 0; padding: 2rem; color: #1f2937; background: #f8fafc; }
  main { max-width: 34rem; margin: 0 auto; background: #fff; border: 1px solid #e2e8f0; border-radius: 12px; padding: 1.5rem 1.75rem 1.75rem; }
  h1 { font-size: 1.35rem; margin: 0 0 0.5rem; }
  p { line-height: 1.5; }
  label { display: block; margin: 0.9rem 0 0; font-weight: 600; }
  input, textarea { width: 100%; box-sizing: border-box; margin-top: 0.35rem; padding: 0.55rem 0.65rem; font: inherit; border: 1px solid #cbd5e1; border-radius: 8px; background: #fff; color: #0f172a; }
  button { margin-top: 1.25rem; padding: 0.6rem 1rem; font: inherit; font-weight: 600; color: #fff; background: #0f172a; border: 0; border-radius: 8px; cursor: pointer; }
  button:disabled { opacity: 0.6; cursor: default; }
  #status { margin-top: 1rem; min-height: 1.5rem; }
</style>
</head>
<body>
<main>
  <h1>Upload your credentials</h1>
  <p>This link is tied to your account, opens once, and expires in 15 minutes. Everything you enter is encrypted before it is stored.</p>
  <form id="upload" method="post">
    <label for="service">Service</label>
    <input id="service" name="service" autocomplete="off" maxlength="200" placeholder="For example: Go Fund It Now" />
    <label for="username">Username or email</label>
    <input id="username" name="username" autocomplete="off" maxlength="200" required />
    <label for="password">Password</label>
    <input id="password" name="password" type="password" autocomplete="new-password" maxlength="1000" required />
    <label for="notes">Notes</label>
    <textarea id="notes" name="notes" rows="3" maxlength="2000" placeholder="Anything else needed to use this login"></textarea>
    <button type="submit">Upload</button>
  </form>
  <p id="status" role="status"></p>
</main>
<script>
  const form = document.getElementById("upload");
  const status = document.getElementById("status");
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = form.querySelector("button");
    button.disabled = true;
    status.textContent = "Uploading...";
    try {
      const response = await fetch(location.href, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(Object.fromEntries(new FormData(form).entries())),
      });
      if (!response.ok) {
        status.textContent = "The upload did not go through. Ask for a new link.";
        button.disabled = false;
        return;
      }
      form.hidden = true;
      status.textContent = "Thank you. Your credentials arrived.";
    } catch {
      status.textContent = "The upload did not go through. Check your connection and try again.";
      button.disabled = false;
    }
  });
</script>
</body>
</html>`;
}
