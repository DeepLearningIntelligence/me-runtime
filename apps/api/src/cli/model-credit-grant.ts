// Operator control: model-credit-grant.js grant <email> <amount-usd> [--cap <total-usd>]
//
// Funds one person's organization with hosted model credits without a billing provider
// (ME_HOUSE_CREDITS=true), and optionally sets their spending ceiling. The ceiling itself is
// enforced by the existing per-user cap: see setModelCreditCap and model-credit-cap.js.
import { randomUUID } from "node:crypto";
import { contentKeyProviderFromEnv, unwrapEnvFromKeyManager } from "@rakazo/adapters";
import {
  createDb,
  creditAccount,
  modelCreditCapStatus,
  organizationForMember,
  reconcileCreditPurchase,
  runAsSystem,
  setModelCreditCap,
} from "@rakazo/db";
import { loadEnv } from "../env.js";

const validAmount = (dollars: string | undefined) =>
  dollars !== undefined && /^(?:0|[1-9]\d{0,4})(?:\.\d{1,6})?$/.test(dollars);
const toCents = (dollars: string) => {
  const [whole = "0", fraction = ""] = dollars.split(".");
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
};
const toMicros = (dollars: string) => toCents(dollars) * 10_000n;

const [action, address, amount, ...flags] = process.argv.slice(2);
const capAt = flags.indexOf("--cap");
const capDollars = capAt >= 0 ? flags[capAt + 1] : undefined;
const stray = flags.filter((flag, index) => flag !== "--cap" && flags[index - 1] !== "--cap");
if (
  action !== "grant" ||
  !address ||
  !validAmount(amount) ||
  (capAt >= 0 && !validAmount(capDollars)) ||
  stray.length
) {
  process.stderr.write(
    "Usage: model-credit-grant.js grant <email> <amount-usd> [--cap <total-usd>]\n",
  );
  process.exit(2);
}

await unwrapEnvFromKeyManager();
const env = loadEnv();
const { prisma, pool } = createDb(env.databaseUrl, { keyProvider: contentKeyProviderFromEnv() });
try {
  await runAsSystem("fund an account's hosted model credits", async () => {
    const email = address.trim().toLowerCase();
    const exact = await prisma.user.findUnique({ where: { email }, select: { id: true } });
    const matches = exact
      ? [exact]
      : await prisma.user.findMany({
          where: { email: { equals: email, mode: "insensitive" } },
          select: { id: true },
          take: 2,
        });
    const user = matches.length === 1 ? matches[0] : null;
    if (!user) throw new Error("No single account has that email");
    const space = await prisma.spaceMember.findFirst({
      where: { userId: user.id },
      select: { spaceId: true },
    });
    if (!space) throw new Error("That account has no space yet");
    const membership = await organizationForMember(prisma, {
      userId: user.id,
      spaceId: space.spaceId,
    });
    if (!membership) throw new Error("That account belongs to no organization");
    await creditAccount(prisma, membership.organizationId);
    const amountCents = toCents(amount!);
    if (amountCents > 0n)
      await reconcileCreditPurchase(prisma, membership.organizationId, {
        id: `operator:${randomUUID()}`,
        amountCents: Number(amountCents),
      });
    if (capDollars !== undefined)
      await setModelCreditCap(prisma, user.id, capAt >= 0 ? toMicros(capDollars) : null);
    const account = await prisma.modelCreditAccount.findUniqueOrThrow({
      where: { organizationId: membership.organizationId },
      select: { balanceMicros: true },
    });
    const cap = await modelCreditCapStatus(prisma, user.id);
    const usd = (micros: bigint) => `$${(Number(micros) / 1_000_000).toFixed(6)}`;
    process.stdout.write(
      `Granted: ${usd(BigInt(amountCents) * 10_000n)}\nBalance: ${usd(account.balanceMicros)}\nCap: ${cap.capMicros === null ? "none" : usd(cap.capMicros)}\n`,
    );
  });
} finally {
  await prisma.$disconnect();
  await pool.end();
}
