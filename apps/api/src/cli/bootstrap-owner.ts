import { randomUUID } from "node:crypto";
import { contentKeyProviderFromEnv, unwrapEnvFromKeyManager } from "@rakazo/adapters";
import { createAuth } from "@rakazo/auth";
import { bootstrapUserSpace, createDb, isUniqueViolation, runAsSystem } from "@rakazo/db";
import { hashIdentifier } from "../me/phone-signin/identity.js";
import { requirePhoneValue } from "../me/phone-signin/service.js";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

await unwrapEnvFromKeyManager();
const { prisma, pool } = createDb(required("DATABASE_URL"), {
  keyProvider: contentKeyProviderFromEnv(),
});
try {
  await runAsSystem("private account bootstrap", bootstrap);
} finally {
  await prisma.$disconnect();
  await pool.end();
}

/**
 * The owner's phone, attached the way phone sign-in knows a person: the door's
 * HMAC (`hashIdentifier` under `ME_IDENTITY_HASH_KEY`), never the number. Only
 * hashes are written, so phone sign-in and the signed-in link resolve to this
 * same account. The phone is validated before any write, so a malformed
 * `OWNER_PHONE` changes nothing.
 */
function ownerPhoneHash(): string | undefined {
  const phone = process.env.OWNER_PHONE?.trim();
  if (!phone) return undefined;
  try {
    requirePhoneValue(phone);
  } catch {
    throw new Error("OWNER_PHONE is not a valid phone number (E.164 digits)");
  }
  const key = required("ME_IDENTITY_HASH_KEY");
  return hashIdentifier("phone", key, phone);
}

async function bootstrap() {
  const phoneHash = ownerPhoneHash();
  const email = required("OWNER_EMAIL").trim().toLowerCase();
  const existing = await prisma.user.findUnique({ where: { email } });
  if (!existing?.emailVerified) {
    const password = required("OWNER_PASSWORD");
    if (password.length < 16) throw new Error("OWNER_PASSWORD must contain at least 16 characters");
    const baseURL = required("BETTER_AUTH_URL");
    const auth = createAuth(prisma, {
      secret: required("BETTER_AUTH_SECRET"),
      baseURL,
      webOrigin: baseURL,
      signupsEnabled: "false",
      signupAllowlist: "",
    });
    const context = await auth.$context;
    if (existing) {
      // Never verify a public signup just because its email matches the operator's input.
      const account = await prisma.account.findFirst({
        where: { userId: existing.id, providerId: "credential" },
      });
      if (
        !account?.password ||
        !(await context.password.verify({ hash: account.password, password }))
      ) {
        throw new Error("Existing account password does not match; account was not verified");
      }
      await prisma.user.update({ where: { id: existing.id }, data: { emailVerified: true } });
    } else {
      const hash = await context.password.hash(password);
      const userId = randomUUID();
      await prisma.user.create({
        data: {
          id: userId,
          name: "Account",
          email,
          emailVerified: true,
          accounts: {
            create: {
              id: randomUUID(),
              accountId: userId,
              providerId: "credential",
              password: hash,
            },
          },
        },
      });
    }
    process.stdout.write("Account verified\n");
  }
  const user = await prisma.user.findUniqueOrThrow({ where: { email } });
  if (phoneHash) {
    const holder = await prisma.user.findUnique({ where: { phoneHash }, select: { id: true } });
    if (holder && holder.id !== user.id)
      throw new Error("OWNER_PHONE already belongs to another account");
    if (user.phoneHash && user.phoneHash !== phoneHash)
      throw new Error("OWNER_PHONE does not match the phone already linked to this account");
    try {
      await prisma.user.update({ where: { id: user.id }, data: { phoneHash } });
    } catch (error) {
      if (isUniqueViolation(error))
        throw new Error("OWNER_PHONE already belongs to another account");
      throw error;
    }
    process.stdout.write("Owner phone linked\n");
  }
  await bootstrapUserSpace(prisma, user, { signupsEnabled: "false", signupAllowlist: "" });
  await prisma.deploymentSettings.update({
    where: { id: "default" },
    data: { signupsEnabled: false, signupPolicyInitialized: true },
  });
}
