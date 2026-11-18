import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { createAuth } from "@rakazo/auth";
import { createDb, createPool } from "@rakazo/db";
import { expect, it } from "vitest";
import { hashIdentifier } from "../me/phone-signin/identity.js";
import { signInVerifiedPhone } from "../me/phone-signin/session.js";

const run = promisify(execFile);
const testDatabase = process.env.VERIFY_DATABASE === "1" ? process.env.DATABASE_URL : undefined;
// Creating and migrating a database takes the owner; the runtime login may not.
const ownerDatabase = process.env.DATABASE_MIGRATION_URL || testDatabase;

/** Synthetic values only; nothing here names a real number, key or password. */
const OWNER_PHONE = "+15550001234";
const IDENTITY_KEY = "p11-test-identity-key";

it.skipIf(!testDatabase)(
  "bootstraps privately, closes signup and preserves the password on restart",
  async () => {
    if (!testDatabase || !ownerDatabase) throw new Error("DATABASE_URL is required");
    const name = `railway_bootstrap_${randomUUID().replaceAll("-", "")}`;
    const admin = createPool(ownerDatabase);
    const at = (base: string) => {
      const url = new URL(base);
      url.pathname = `/${name}`;
      return url.href;
    };
    await admin.query(`CREATE DATABASE "${name}"`);
    const { prisma, pool } = createDb(at(ownerDatabase));
    // As in deployment: migrate as the owner, then bootstrap as the runtime login.
    const env = {
      ...process.env,
      DATABASE_URL: at(testDatabase),
      OWNER_EMAIL: "owner@example.test",
      OWNER_PASSWORD: "bootstrap-test-password-12345",
      BETTER_AUTH_URL: "http://127.0.0.1:5173",
      BETTER_AUTH_SECRET: "bootstrap-test-secret-with-over-32-characters",
    };
    try {
      await run("pnpm", ["--filter", "@rakazo/api", "db:migrate"], {
        env: { ...env, DATABASE_MIGRATION_URL: at(ownerDatabase) },
      });
      const boot = (password: string) =>
        run("pnpm", ["--filter", "@rakazo/api", "exec", "tsx", "src/cli/bootstrap-owner.ts"], {
          env: { ...env, DATABASE_MIGRATION_URL: undefined, OWNER_PASSWORD: password },
        });
      await boot(env.OWNER_PASSWORD);
      const owner = await prisma.user.findUniqueOrThrow({ where: { email: env.OWNER_EMAIL } });
      expect(
        await prisma.deploymentSettings.findUnique({ where: { id: "default" } }),
      ).toMatchObject({ ownerUserId: null, signupsEnabled: false });
      expect(await prisma.session.count()).toBe(0);
      expect(owner.emailVerified).toBe(true);
      const memberships = await prisma.spaceMember.count({ where: { userId: owner.id } });
      expect(memberships).toBeGreaterThan(0);
      await prisma.user.update({ where: { id: owner.id }, data: { emailVerified: false } });
      await expect(boot("wrong-recovery-password")).rejects.toThrow();
      expect(
        await prisma.deploymentSettings.findUnique({ where: { id: "default" } }),
      ).toMatchObject({ ownerUserId: null });
      await boot(env.OWNER_PASSWORD);
      expect(
        await prisma.deploymentSettings.findUnique({ where: { id: "default" } }),
      ).toMatchObject({ ownerUserId: null, signupsEnabled: false });
      expect(await prisma.spaceMember.count({ where: { userId: owner.id } })).toBe(memberships);
      await boot("a-different-password-on-restart");
      expect(await prisma.user.count()).toBe(1);
      const auth = createAuth(prisma, {
        secret: env.BETTER_AUTH_SECRET,
        baseURL: env.BETTER_AUTH_URL,
        webOrigin: env.BETTER_AUTH_URL,
        signupsEnabled: "false",
        signupAllowlist: "",
      });
      const request = (path: string, body: object) =>
        auth.handler(
          new Request(`${env.BETTER_AUTH_URL}/api/auth/${path}/email`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Origin: env.BETTER_AUTH_URL },
            body: JSON.stringify(body),
          }),
        );
      expect(
        (await request("sign-in", { email: env.OWNER_EMAIL, password: env.OWNER_PASSWORD })).status,
      ).toBe(200);
      expect(
        (
          await request("sign-in", {
            email: env.OWNER_EMAIL,
            password: "a-different-password-on-restart",
          })
        ).status,
      ).toBe(401);
      expect(
        (
          await request("sign-up", {
            name: "Stranger",
            email: "stranger@example.test",
            password: env.OWNER_PASSWORD,
          })
        ).status,
      ).toBe(400);
      expect(await prisma.user.count()).toBe(1);
    } finally {
      await prisma.$disconnect();
      await pool.end();
      await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
      await admin.end();
    }
  },
  // A fresh migration and four CLI cold starts take up to a minute on a busy CI shard.
  180_000,
);

it.skipIf(!testDatabase)(
  "links the owner's phone the way phone sign-in resolves a person, and writes nothing for a malformed one",
  async () => {
    if (!testDatabase || !ownerDatabase) throw new Error("DATABASE_URL is required");
    const name = `railway_bootstrap_${randomUUID().replaceAll("-", "")}`;
    const admin = createPool(ownerDatabase);
    const at = (base: string) => {
      const url = new URL(base);
      url.pathname = `/${name}`;
      return url.href;
    };
    await admin.query(`CREATE DATABASE "${name}"`);
    const { prisma, pool } = createDb(at(ownerDatabase));
    const env = {
      ...process.env,
      DATABASE_URL: at(testDatabase),
      OWNER_EMAIL: "owner@example.test",
      OWNER_PASSWORD: "bootstrap-test-password-12345",
      BETTER_AUTH_URL: "http://127.0.0.1:5173",
      BETTER_AUTH_SECRET: "bootstrap-test-secret-with-over-32-characters",
      ME_IDENTITY_HASH_KEY: IDENTITY_KEY,
      OWNER_PHONE,
    };
    const phoneHash = hashIdentifier("phone", IDENTITY_KEY, OWNER_PHONE);
    try {
      await run("pnpm", ["--filter", "@rakazo/api", "db:migrate"], {
        env: { ...env, DATABASE_MIGRATION_URL: at(ownerDatabase) },
      });
      const boot = (overrides: Record<string, string | undefined>) =>
        run("pnpm", ["--filter", "@rakazo/api", "exec", "tsx", "src/cli/bootstrap-owner.ts"], {
          // OWNER_PHONE rides only in overrides; the base clears it.
          env: { ...env, DATABASE_MIGRATION_URL: undefined, OWNER_PHONE: undefined, ...overrides },
        });

      // A malformed phone is refused by name before anything is written.
      await expect(boot({ OWNER_PHONE: "not-a-phone" })).rejects.toThrow();
      expect(await prisma.user.count()).toBe(0);
      await boot({});
      await boot({ OWNER_PHONE });

      // The phone reached the owner's account, and phone sign-in with no
      // invite resolves to that same user.
      const owner = await prisma.user.findUniqueOrThrow({ where: { email: env.OWNER_EMAIL } });
      expect(owner.phoneHash).toBe(phoneHash);
      const auth = createAuth(prisma, {
        secret: env.BETTER_AUTH_SECRET,
        baseURL: env.BETTER_AUTH_URL,
        webOrigin: env.BETTER_AUTH_URL,
        signupsEnabled: "false",
        signupAllowlist: "",
      });
      const session = await signInVerifiedPhone(prisma, auth, {
        signupsEnabled: "false",
        signupAllowlist: "",
      }, phoneHash, {}, null, async () => {});
      expect(session.userId).toBe(owner.id);

      // The same phone again is idempotent.
      await boot({ OWNER_PHONE });
      const again = await prisma.user.findUniqueOrThrow({ where: { email: env.OWNER_EMAIL } });
      expect(again.phoneHash).toBe(phoneHash);
    } finally {
      await prisma.$disconnect();
      await pool.end();
      await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
      await admin.end();
    }
  },
  180_000,
);
