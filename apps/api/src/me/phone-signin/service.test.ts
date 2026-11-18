import { randomBytes } from "node:crypto";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it } from "vitest";
import { hashIdentifier } from "./identity.js";
import { handleInbound, EXPIRED_CODE_REPLY, PhoneSigninError, start, verify } from "./service.js";

/**
 * The door's guards, against an in-memory store that follows the same update
 * predicates the Prisma client would run. No database is needed: every guard
 * here is conditional-update logic the fake mirrors exactly.
 */

const BASE = Date.parse("2026-11-16T12:00:00Z");
const key = randomBytes(16).toString("hex");

type SigninRow = {
  id: string;
  nonceHash: string;
  phoneHash: string | null;
  inviteTokenHash: string | null;
  codeHash: string | null;
  boundAt: Date | null;
  consumedAt: Date | null;
  expiresAt: Date;
  attempts: number;
  ipAddress: string | null;
  createdAt: Date;
};

function fakePrisma() {
  const signins: SigninRow[] = [];
  const claimedMessages: Array<{ provider: string; providerMessageId: string }> = [];
  let nextId = 1;

  const matches = (row: SigninRow, where: Record<string, unknown>): boolean =>
    Object.entries(where).every(([field, condition]) => {
      const value = row[field as keyof SigninRow];
      if (condition !== null && typeof condition === "object" && !(condition instanceof Date)) {
        const bound = condition as { gt?: Date; lt?: number };
        if (bound.gt !== undefined)
          return value instanceof Date && value.getTime() > bound.gt.getTime();
        // The attempt charge's conditional update.
        if (bound.lt !== undefined) return typeof value === "number" && value < bound.lt;
        return false;
      }
      return value === condition;
    });

  const applyData = (row: SigninRow, data: Record<string, unknown>): void => {
    for (const [field, value] of Object.entries(data)) {
      const increment = (value as { increment?: number } | null)?.increment;
      if (typeof increment === "number") {
        (row[field as keyof SigninRow] as number) += increment;
      } else {
        (row as Record<string, unknown>)[field] = value;
      }
    }
  };

  const mePhoneSignin = {
    create: async ({
      data,
    }: {
      data: { nonceHash: string; expiresAt: Date } & Partial<SigninRow>;
    }) => {
      if (signins.some((row) => row.nonceHash === data.nonceHash)) throw { code: "P2002" };
      const row: SigninRow = {
        id: `row-${nextId++}`,
        phoneHash: null,
        inviteTokenHash: null,
        codeHash: null,
        boundAt: null,
        consumedAt: null,
        attempts: 0,
        ipAddress: null,
        createdAt: new Date(BASE),
        ...data,
      };
      signins.push(row);
      return row;
    },
    // A read returns a snapshot, as a database read would: later writes are not
    // visible to a row another call already read.
    findUnique: async ({ where }: { where: { nonceHash: string } }) => {
      const row = signins.find((candidate) => candidate.nonceHash === where.nonceHash);
      return row ? { ...row } : null;
    },
    update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      const row = signins.find((candidate) => candidate.id === where.id);
      if (!row) throw { code: "P2025" };
      applyData(row, data);
      return row;
    },
    updateMany: async ({
      where,
      data,
    }: {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    }) => {
      let count = 0;
      for (const row of signins) {
        if (!matches(row, where)) continue;
        applyData(row, data);
        count += 1;
      }
      return { count };
    },
    count: async ({ where }: { where: Record<string, unknown> }) =>
      signins.filter((row) => matches(row, where)).length,
  };

  const mePhoneSigninMessage = {
    create: async ({ data }: { data: { provider: string; providerMessageId: string } }) => {
      if (
        claimedMessages.some(
          (message) =>
            message.provider === data.provider &&
            message.providerMessageId === data.providerMessageId,
        )
      )
        throw { code: "P2002" };
      claimedMessages.push({ ...data });
      return data;
    },
  };

  const prisma = {
    mePhoneSignin,
    mePhoneSigninMessage,
    $transaction: async <T>(
      work: (tx: {
        mePhoneSignin: typeof mePhoneSignin;
        mePhoneSigninMessage: typeof mePhoneSigninMessage;
      }) => Promise<T>,
    ) => work({ mePhoneSignin, mePhoneSigninMessage }),
  } as unknown as PrismaClient;

  return { prisma, signins, claimedMessages };
}

function makeConfig(now: () => number) {
  return { identityHashKey: key, now };
}

async function bind(
  fake: ReturnType<typeof fakePrisma>,
  config: ReturnType<typeof makeConfig>,
  nonce: string,
  from: string,
  providerMessageId: string,
) {
  return handleInbound(fake.prisma, config, { from, body: nonce, providerMessageId });
}

describe("phone sign-in", () => {
  it("binds a valid nonce once and replies with six digits", async () => {
    const now = BASE;
    const fake = fakePrisma();
    const config = makeConfig(() => now);
    const started = await start(fake.prisma, config, { ipAddress: "10.0.0.9" });

    const outcome = await bind(fake, config, started.nonce, "15550001000", "wamid.first");
    expect(outcome).toMatchObject({ reply: expect.stringMatching(/^\d{6}$/) });
    const code = (outcome as { reply: string }).reply;

    // Bound: the same nonce in a later message mints nothing more.
    await expect(
      bind(fake, config, started.nonce, "15550001000", "wamid.second"),
    ).resolves.toMatchObject({ reply: null, reason: "already_bound" });
    expect(fake.signins[0]!.codeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(fake.signins[0]!.codeHash).not.toBe(code);

    const verified = await verify(fake.prisma, config, { nonce: started.nonce, code });
    expect(verified.phoneHash).toBe(hashIdentifier("phone", key, "15550001000"));
  });

  it("never mints a second code for a replayed provider message id", async () => {
    const now = BASE;
    const fake = fakePrisma();
    const config = makeConfig(() => now);

    // The claim outlives a delivery that did nothing: this door is unknown, and
    // the unknown door gets the one dead-code answer.
    await expect(
      bind(fake, config, "ME-UNKNOWN1", "15550001000", "wamid.reuse"),
    ).resolves.toMatchObject({ reply: EXPIRED_CODE_REPLY });

    const started = await start(fake.prisma, config, {});
    const minted = await bind(fake, config, started.nonce, "15550001000", "wamid.fresh");
    expect(minted).toMatchObject({ reply: expect.any(String) });
    const codeHash = fake.signins[0]!.codeHash;

    // Meta retries the same message id: claimed, no second code, hash unchanged.
    await expect(
      bind(fake, config, started.nonce, "15550001000", "wamid.fresh"),
    ).resolves.toMatchObject({ reply: null, reason: "replayed" });
    // The claimed id also cannot mint a code for a different, unbound door.
    const other = await start(fake.prisma, config, {});
    await expect(
      bind(fake, config, other.nonce, "15550001000", "wamid.fresh"),
    ).resolves.toMatchObject({ reply: null, reason: "replayed" });
    expect(fake.signins[0]!.codeHash).toBe(codeHash);
  });

  it("answers a dead door once and never on a replay", async () => {
    let now = BASE;
    const fake = fakePrisma();
    const config = makeConfig(() => now);

    // An expired door: one answer, worded like the unknown door's.
    const started = await start(fake.prisma, config, {});
    now = BASE + 10 * 60_000 + 1;
    await expect(
      bind(fake, config, started.nonce, "15550001000", "wamid.late"),
    ).resolves.toMatchObject({ reply: EXPIRED_CODE_REPLY });
    await expect(
      verify(fake.prisma, config, { nonce: started.nonce, code: "123456" }),
    ).rejects.toMatchObject({ reason: "code_expired" });

    // Meta's retry of the same message id is silent: the claim stands.
    await expect(
      bind(fake, config, started.nonce, "15550001000", "wamid.late"),
    ).resolves.toMatchObject({ reply: null, reason: "replayed" });
  });

  it("never verifies a code minted for phone A against phone B", async () => {
    const now = BASE;
    const fake = fakePrisma();
    const config = makeConfig(() => now);
    const started = await start(fake.prisma, config, { phone: "+15550001000" });

    // A different sender is refused before any code exists, and the door is not
    // poisoned: the right phone can still open it.
    await expect(
      bind(fake, config, started.nonce, "15550002000", "wamid.stranger"),
    ).resolves.toMatchObject({ reply: null, reason: "phone_mismatch" });
    expect(fake.signins[0]!.codeHash).toBeNull();
    await expect(
      verify(fake.prisma, config, { nonce: started.nonce, code: "123456" }),
    ).rejects.toMatchObject({ reason: "code_invalid" });

    const outcome = await bind(fake, config, started.nonce, "15550001000", "wamid.owner");
    expect(outcome).toMatchObject({ reply: expect.stringMatching(/^\d{6}$/) });
    const verified = await verify(fake.prisma, config, {
      nonce: started.nonce,
      code: (outcome as { reply: string }).reply,
    });
    expect(verified.phoneHash).toBe(hashIdentifier("phone", key, "15550001000"));
  });

  it("refuses the sixth attempt with a lockout name", async () => {
    const now = BASE;
    const fake = fakePrisma();
    const config = makeConfig(() => now);
    const started = await start(fake.prisma, config, {});
    const outcome = await bind(fake, config, started.nonce, "15550001000", "wamid.first");
    const code = (outcome as { reply: string }).reply;

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      await expect(
        verify(fake.prisma, config, { nonce: started.nonce, code: "000000" }),
      ).rejects.toMatchObject({ reason: "code_invalid" });
    }
    // Even the correct code is refused once the row is charged out.
    await expect(verify(fake.prisma, config, { nonce: started.nonce, code })).rejects.toMatchObject(
      { reason: "too_many_attempts" },
    );
    expect(fake.signins[0]!.attempts).toBe(5);
    expect(fake.signins[0]!.consumedAt).toBeNull();
  });

  it("never reaches this module for a body that is not ME-<nonce>", async () => {
    const now = BASE;
    const fake = fakePrisma();
    const config = makeConfig(() => now);
    for (const body of [
      "hello",
      "ME-",
      "ME-ABC12 extra words",
      "me-abcdef",
      "me-ABCDEF",
      "ME-ABC12!",
      "ME-ABCDE",
      "",
    ]) {
      await expect(
        handleInbound(fake.prisma, config, {
          from: "15550001000",
          body,
          providerMessageId: "wamid.x",
        }),
      ).resolves.toBeNull();
    }
    expect(fake.claimedMessages).toHaveLength(0);
    expect(fake.signins).toHaveLength(0);
  });

  it("redeems a code once, through the admission's redemption", async () => {
    const now = BASE;
    const fake = fakePrisma();
    const config = makeConfig(() => now);
    const started = await start(fake.prisma, config, {});
    const outcome = await bind(fake, config, started.nonce, "15550001000", "wamid.first");
    const code = (outcome as { reply: string }).reply;

    const first = await verify(fake.prisma, config, { nonce: started.nonce, code });
    await first.redeem(fake.prisma);
    const second = await verify(fake.prisma, config, { nonce: started.nonce, code });
    await expect(second.redeem(fake.prisma)).rejects.toMatchObject({ reason: "code_invalid" });
  });

  it("leaves the code unconsumed until the admission redeems it", async () => {
    const now = BASE;
    const fake = fakePrisma();
    const config = makeConfig(() => now);
    const started = await start(fake.prisma, config, {});
    const outcome = await bind(fake, config, started.nonce, "15550001000", "wamid.first");
    const code = (outcome as { reply: string }).reply;

    await verify(fake.prisma, config, { nonce: started.nonce, code });
    expect(fake.signins[0]!.consumedAt).toBeNull();
  });

  it("caps the doors one address can open", async () => {
    const now = BASE;
    const fake = fakePrisma();
    const config = makeConfig(() => now);
    for (let i = 0; i < 10; i += 1) {
      await start(fake.prisma, config, { ipAddress: "10.0.0.9" });
    }
    await expect(start(fake.prisma, config, { ipAddress: "10.0.0.9" })).rejects.toMatchObject({
      reason: "rate_limited",
    });
    // Another address is untouched.
    await expect(start(fake.prisma, config, { ipAddress: "10.0.0.8" })).resolves.toMatchObject({
      nonce: expect.stringMatching(/^ME-[A-Z0-9]{6,}$/),
    });
  });

  it("fails closed without an identity key and refuses an invalid phone", async () => {
    const now = BASE;
    const fake = fakePrisma();
    await expect(
      start(fake.prisma, { identityHashKey: undefined, now: () => now }, {}),
    ).rejects.toMatchObject({ reason: "identity_key_missing" });
    await expect(
      handleInbound(
        fake.prisma,
        { identityHashKey: undefined, now: () => now },
        { from: "15550001000", body: "ME-ABC123", providerMessageId: "wamid.x" },
      ),
    ).rejects.toMatchObject({ reason: "identity_key_missing" });

    const config = makeConfig(() => now);
    await expect(start(fake.prisma, config, { phone: "not-a-number" })).rejects.toBeInstanceOf(
      PhoneSigninError,
    );
  });

  it("binds a door opened for +15551234567 when the webhook sends 15551234567", async () => {
    const now = BASE;
    const fake = fakePrisma();
    const config = makeConfig(() => now);
    // The browser supplies E.164 with a plus; the webhook sender is the wa_id.
    const started = await start(fake.prisma, config, { phone: "+15551234567" });

    const outcome = await bind(fake, config, started.nonce, "15551234567", "wamid.plus");
    expect(outcome).toMatchObject({ reply: expect.stringMatching(/^\d{6}$/) });
    const code = (outcome as { reply: string }).reply;
    const verified = await verify(fake.prisma, config, { nonce: started.nonce, code });
    expect(verified.phoneHash).toBe(hashIdentifier("phone", key, "15551234567"));
    expect(verified.phoneHash).toBe(hashIdentifier("phone", key, "+15551234567"));
  });

  it("evaluates at most one of two concurrent guesses after the fourth attempt", async () => {
    const now = BASE;
    const fake = fakePrisma();
    const config = makeConfig(() => now);
    const started = await start(fake.prisma, config, {});
    const outcome = await bind(fake, config, started.nonce, "15550001000", "wamid.first");
    const code = (outcome as { reply: string }).reply;

    for (let attempt = 1; attempt <= 4; attempt += 1) {
      await expect(
        verify(fake.prisma, config, { nonce: started.nonce, code: "000000" }),
      ).rejects.toMatchObject({ reason: "code_invalid" });
    }
    expect(fake.signins[0]!.attempts).toBe(4);

    // Both land after the fourth charge: the conditional update charges one,
    // so exactly one guess is evaluated and the lockout holds for the other.
    const [first, second] = await Promise.allSettled([
      verify(fake.prisma, config, { nonce: started.nonce, code: "111111" }),
      verify(fake.prisma, config, { nonce: started.nonce, code: "222222" }),
    ]);
    const reasons = [first, second].map((settled) =>
      settled.status === "rejected" && settled.reason instanceof PhoneSigninError
        ? settled.reason.reason
        : "resolved",
    );
    expect(reasons.sort()).toEqual(["code_invalid", "too_many_attempts"]);
    expect(fake.signins[0]!.attempts).toBe(5);

    // Charged out: even the correct code is refused now.
    await expect(verify(fake.prisma, config, { nonce: started.nonce, code })).rejects.toMatchObject(
      {
        reason: "too_many_attempts",
      },
    );
    expect(fake.signins[0]!.consumedAt).toBeNull();
  });
});
