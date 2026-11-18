import { createHash, randomBytes } from "node:crypto";
import type { JobPublisher } from "@rakazo/adapter-kit";
import { messagingDeliverJob } from "@rakazo/adapter-kit";
import type { Auth } from "@rakazo/auth";
import { CLIENT_IP_HEADER } from "@rakazo/auth";
import { BOT_COLOR_LIST } from "@rakazo/contracts";
import type { Prisma, PrismaClient, SignupPolicyEnv } from "@rakazo/db";
import {
  attachMessagingIdentity,
  bootstrapUserSpace,
  createRepos,
  isUniqueViolation,
  runAsSystem,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { redeemInviteByHash } from "../invitations/invitations.js";
import { sha256Hex } from "./codes.js";
import { PhoneSigninError, PROVIDER } from "./service.js";

/** The undeliverable email domain a phone-created person carries until onboarding connects one. */
export const PHONE_EMAIL_DOMAIN = "phone.invalid";

/** The one redemption the door's verified result carries; see `service.ts`. */
export type CodeRedemption = (client: Prisma.TransactionClient | PrismaClient) => Promise<void>;

/**
 * The fork's own person and session, reached from a verified phone.
 *
 * One phone hash is one person: the user id is derived from the hash, so a
 * concurrent first sign-in for the same phone converges on the same row. The
 * person's email is synthetic under an undeliverable domain, because a phone
 * person has no mailbox yet and must never be asserted one; onboarding (packet
 * H) collects a real address later. The workspace is bootstrapped before the
 * session is issued, so the auth session hook finds an admitted member instead
 * of a closed signup, and the session itself is issued through the auth
 * layer's `issueSession`, which runs the same hooks as every sign-in.
 *
 * Admission has one owner: the invitations service. Creating the person through
 * the phone door requires the valid invitation the door was opened with, and
 * its redemption commits or rolls back with the person it admits; a person who
 * already exists signs in again without one.
 */

export type VerifiedPersonSession = {
  userId: string;
  /** The raw session token for the cookie; never logged. */
  token: string;
  expiresAt: Date;
};

/** The person id a phone hash belongs to; stable across processes. */
export function phoneUserId(phoneHash: string): string {
  return `${createHash("sha256")
    .update(JSON.stringify(["me-phone", phoneHash]))
    .digest("hex")}-phone`;
}

/**
 * Finds or creates the person for a verified phone and issues their session.
 * The display name is neutral until onboarding collects the person's name; it
 * carries no phone digits, because the number itself is never stored. The
 * invite hash is the one the pending row carried: null admits only a person
 * who already exists.
 *
 * The phone resolves to one person two ways, one owner each: the hash a
 * linked account carries (`user.phoneHash`, attached by the owner bootstrap or
 * the signed-in link), then the derived id a phone-created person has always
 * carried. Both are pure functions of the hash, so they can never name two
 * people for one phone.
 *
 * The code's redemption runs inside the same transaction as the person it
 * admits, so a refusal (`invite_required`, an invite the invitations service
 * cannot claim) rolls the consume back and the code stays usable; a returning
 * person, or a racer joining a concurrent winner, redeems right before the
 * session, where the conditional update still makes it single use. Of two
 * parallel redemptions exactly one wins; the loser is refused with
 * `code_invalid` before a session is issued.
 *
 * A concurrent first sign-in for the same phone may create the person first.
 * Postgres aborts a transaction whose statement errored, so the loser cannot
 * read inside its own transaction; it retries the whole admission in a fresh
 * one. The winner has committed by the time the unique violation surfaces, so
 * that retry joins its row like a returning person, claims nothing, and does
 * not emit the account-created audit trail a second time.
 */
export async function signInVerifiedPhone(
  prisma: PrismaClient,
  auth: Auth,
  env: SignupPolicyEnv,
  phoneHash: string,
  request: { ipAddress?: string; userAgent?: string } = {},
  inviteTokenHash: string | null,
  redeem: CodeRedemption,
): Promise<VerifiedPersonSession> {
  const userId = phoneUserId(phoneHash);
  let found = await prisma.user.findUnique({ where: { phoneHash } });
  if (!found) found = await prisma.user.findUnique({ where: { id: userId } });
  if (!found && !inviteTokenHash) throw new PhoneSigninError("invite_required");

  let createdHere = false;
  while (!found) {
    try {
      const created = await runAsSystem("phone sign-in: admit the invited person", () =>
        prisma.$transaction(async (tx) => {
          // The code's redemption commits or rolls back with the person it
          // admits: a refused admission leaves the code usable.
          await redeem(tx);
          const created = await tx.user.create({
            data: {
              id: userId,
              name: "Phone person",
              email: `phone-${randomBytes(16).toString("hex")}@${PHONE_EMAIL_DOMAIN}`,
              phoneHash,
            },
          });
          // One invite, one account: the redemption is in the same transaction
          // that creates the person, so a lost claim rolls back with the person.
          await redeemInviteByHash(tx, { tokenHash: inviteTokenHash!, userId });

          // One membership is what the auth session hook requires; create it
          // before the session so a closed signup policy cannot refuse a
          // verified, invited phone.
          const membership = await tx.spaceMember.findFirst({
            where: { userId: created.id, space: { deletingAt: null } },
            select: { id: true },
          });
          if (!membership) await bootstrapUserSpace(tx, created, env);
          return created;
        }),
      );
      found = created;
      createdHere = true;
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      // Another first sign-in won the insert and committed before this
      // statement saw its row. Read the winner outside the aborted
      // transaction; if it is somehow still absent, surface the original
      // failure instead of guessing.
      found = await prisma.user.findUnique({ where: { id: userId } });
      if (!found) throw error;
    }
  }
  // A person the transaction did not create (a returning person, or a racer
  // joining the winner) redeems here: single use, before any session.
  if (!createdHere) await redeem(prisma);
  if (createdHere) await auth.recordUserCreated(found, "phone");

  const headers = new Headers();
  if (request.userAgent) headers.set("user-agent", request.userAgent);
  if (request.ipAddress) headers.set(CLIENT_IP_HEADER, request.ipAddress);
  const issued = await auth.issueSession(found.id, { headers });
  return { userId: found.id, token: issued.token, expiresAt: issued.expiresAt };
}

/**
 * Attaches a verified phone to a signed-in person instead of creating one: the
 * owner bootstrap and the signed-in link both land here, on the same rule. One
 * phone stays one person, so the attach refuses with `already_bound` when the
 * phone is held by someone else (a linked account or a phone-created person
 * whose account predates the hash column), and when the person already carries
 * a different phone. The code's redemption rides in the same transaction, so a
 * refused attach leaves the code usable, and the conditional update makes it
 * single use against a concurrent redemption.
 *
 * `startedFor` is the link intent the pending row recorded at start: when the
 * door was opened as a link by a signed-in person, only that person may redeem
 * it (`session_mismatch`, 403); the row is the authority, never the request.
 */
export async function linkVerifiedPhone(
  prisma: PrismaClient,
  phoneHash: string,
  userId: string,
  startedFor: string | null,
  redeem: CodeRedemption,
): Promise<void> {
  if (startedFor && startedFor !== userId) throw new PhoneSigninError("session_mismatch");
  try {
    await prisma.$transaction(async (tx) => {
      const holder = await tx.user.findUnique({ where: { phoneHash } });
      if (holder && holder.id !== userId) throw new PhoneSigninError("already_bound");
      const legacy = await tx.user.findUnique({ where: { id: phoneUserId(phoneHash) } });
      if (legacy && legacy.id !== userId) throw new PhoneSigninError("already_bound");
      await redeem(tx);
      const attached = await tx.user.updateMany({
        where: { id: userId, phoneHash: null },
        data: { phoneHash },
      });
      if (attached.count !== 1) {
        const person = await tx.user.findUniqueOrThrow({ where: { id: userId } });
        // Their own phone again is a no-op; a different one is already bound.
        if (person.phoneHash === phoneHash) return;
        throw new PhoneSigninError("already_bound");
      }
    });
  } catch (error) {
    // Two people racing to link one phone: the unique constraint is the
    // backstop, and the loser is refused by name.
    if (isUniqueViolation(error)) throw new PhoneSigninError("already_bound");
    throw error;
  }
}

/** What a successful sign-in says about the sender's WhatsApp link. */
export type WhatsappLinkState =
  | "linked"
  | "already_linked"
  | "linked_elsewhere"
  | "agent_has_other_number"
  | "not_attempted";

export type WhatsappLinkDeps = {
  prisma: PrismaClient;
  /** The deliver job for the welcome message runs on the one worker. */
  jobs: Pick<JobPublisher, "enqueue">;
  env: SignupPolicyEnv;
};

/**
 * The first agent's defaults, the same values onboarding's first-bot step
 * creates with: the portal's opening bot, pinned color and idempotent spawn key.
 */
const FIRST_AGENT = {
  name: "Chief",
  description: "",
  instructions: "",
  notifyOnFinish: true,
  color: BOT_COLOR_LIST.find((color) => color.id === "orange")!.hex,
  spawnKey: "onboarding:first",
} as const;

const WELCOME_BODY = "You're connected. Message me here any time.";

/**
 * Makes the number that just signed in the chat address of the person's
 * default agent (ME-RUN-005). The default agent is the oldest non-archived
 * bot they own in their first space, created with the first agent's defaults
 * when they have none. The link never moves an address another person holds
 * and never overwrites an agent that already chats elsewhere; every state is
 * returned by name, nothing here can fail the sign-in itself.
 *
 * Idempotent per door: the welcome message's outbox key carries the nonce's
 * hash, so a replayed delivery or a second verify queues one message at most.
 */
export async function attachWhatsappAfterSignin(
  deps: WhatsappLinkDeps,
  input: { userId: string; address: string; nonce: string },
): Promise<WhatsappLinkState> {
  try {
    return await attachWhatsapp(deps, input);
  } catch (error) {
    getLogger().error("whatsapp auto-link failed; sign-in continues", error, {
      "user.id": input.userId,
    });
    return "not_attempted";
  }
}

async function attachWhatsapp(
  deps: WhatsappLinkDeps,
  input: { userId: string; address: string; nonce: string },
): Promise<WhatsappLinkState> {
  const { prisma } = deps;
  const membership = await prisma.spaceMember.findFirst({
    where: { userId: input.userId, space: { deletingAt: null } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { spaceId: true },
  });
  if (!membership) {
    getLogger().warn("whatsapp auto-link skipped", { reason: "no space", "user.id": input.userId });
    return "not_attempted";
  }
  let bot = await prisma.bot.findFirst({
    where: { spaceId: membership.spaceId, userId: input.userId, archivedAt: null },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { id: true },
  });
  if (!bot) {
    const person = await prisma.user.findUnique({
      where: { id: input.userId },
      select: { email: true },
    });
    if (!person) {
      getLogger().warn("whatsapp auto-link skipped", {
        reason: "person missing",
        "user.id": input.userId,
      });
      return "not_attempted";
    }
    bot = await createRepos(prisma).createBot(
      {
        userId: input.userId,
        spaceId: membership.spaceId,
        email: person.email,
        isDeploymentOwner: false,
      },
      { ...FIRST_AGENT },
    );
  }
  const where = { provider_address: { provider: PROVIDER, address: input.address } } as const;
  // An address this person already linked stays exactly as it is, thread
  // included; only a fresh address reaches the attach below.
  const existing = await prisma.messagingIdentity.findUnique({
    where,
    select: { userId: true },
  });
  if (existing) {
    if (existing.userId !== input.userId) {
      getLogger().warn("whatsapp number already chats with another account", {
        "user.id": input.userId,
      });
      return "linked_elsewhere";
    }
    return "already_linked";
  }
  const welcomeKey = `signin-welcome:${sha256Hex(input.nonce)}`;
  const state = await attachInTransaction(prisma, {
    provider: PROVIDER,
    address: input.address,
    userId: input.userId,
    spaceId: membership.spaceId,
    botId: bot.id,
    welcomeKey,
  });
  // Only a fresh link queued the welcome; the deliver job carries it out.
  if (state === "linked") {
    await deps.jobs.enqueue(messagingDeliverJob()).catch((error) => {
      getLogger().error("whatsapp welcome enqueue error", error);
    });
  }
  return state;
}

/**
 * Runs the attach and its welcome row in one transaction, then settles a lost
 * unique-constraint race outside it: Postgres aborts the transaction on the
 * failed statement, so the winner is re-read fresh. The loser never moves
 * anything: an address another person won is theirs, and a bot that already
 * chats elsewhere keeps its number.
 */
async function attachInTransaction(
  prisma: PrismaClient,
  request: {
    provider: string;
    address: string;
    userId: string;
    spaceId: string;
    botId: string;
    welcomeKey: string;
  },
): Promise<WhatsappLinkState> {
  try {
    const outcome = await prisma.$transaction(async (tx) => {
      const attach = await attachMessagingIdentity(tx, request);
      if (attach.outcome === "created") {
        // In the same transaction as the identity write, so a rolled-back link
        // leaves no welcome behind; the key makes a replay queue nothing more.
        await tx.messagingOutbound.createMany({
          data: [
            {
              idempotencyKey: request.welcomeKey,
              kind: "dm",
              identityId: attach.identityId,
              body: WELCOME_BODY,
            },
          ],
          skipDuplicates: true,
        });
      }
      return attach.outcome;
    });
    return outcome === "created" ? "linked" : "already_linked";
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    const winner = await prisma.messagingIdentity.findUnique({
      where: { provider_address: { provider: request.provider, address: request.address } },
      select: { userId: true, botId: true },
    });
    if (winner && winner.userId !== request.userId) {
      getLogger().warn("whatsapp number already chats with another account", {
        "user.id": request.userId,
      });
      return "linked_elsewhere";
    }
    if (winner && winner.botId === request.botId) return "already_linked";
    // No winner on the address: the bot's one-identity rule refused the write.
    return "agent_has_other_number";
  }
}
