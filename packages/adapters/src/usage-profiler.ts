/**
 * Me.io cost profiler: ranks recorded provider spend by model.
 *
 * The source of truth is the `UsageRecord` table (`usage_records`), written by
 * `recordUsage` in `@rakazo/db` (see packages/db/src/usage.ts) from the runtime's
 * `type: "usage"` events. Nothing is recomputed from provider catalogs here: a row
 * shows what was recorded, and a call whose record carries no cost is counted as
 * unpriced instead of being invented as free.
 *
 * Run: `pnpm profiler:usage --top 5`
 */
import { pathToFileURL } from "node:url";
import type { PrismaClient } from "@rakazo/db";

/** One recorded model call, reduced to the fields spend aggregation needs. */
export interface UsageEvent {
  provider: string;
  model: string;
  inputTokens?: number | null;
  outputTokens?: number | null;
  totalTokens?: number | null;
  costUsd?: number | null;
  /** Attribution the record carries, when it has one (the record's cost source). */
  source?: string | null;
  /** File the event came from, when the record carries one. */
  file?: string | null;
}

/** One aggregated group, already ranked by spend. */
export interface UsageSummaryRow {
  rank: number;
  provider: string;
  model: string;
  source?: string;
  file?: string;
  calls: number;
  tokens: number;
  spendUsd: number;
  /** Calls in this group whose record reported no cost; they add $0 to spendUsd. */
  unpricedCalls: number;
}

function tokensOf(event: UsageEvent): number {
  if (event.totalTokens != null) return event.totalTokens;
  return (event.inputTokens ?? 0) + (event.outputTokens ?? 0);
}

function spendOf(event: UsageEvent): { usd: number; priced: boolean } {
  return typeof event.costUsd === "number" && Number.isFinite(event.costUsd) && event.costUsd >= 0
    ? { usd: event.costUsd, priced: true }
    : { usd: 0, priced: false };
}

/**
 * Aggregate calls by provider/model, split further by source and file when the event
 * carries them, then keep the top N by spend. Ties order by provider, model, source
 * and file so the top N is deterministic across runs.
 */
export function summarizeUsage(events: readonly UsageEvent[], top = 10): UsageSummaryRow[] {
  const groups = new Map<string, Omit<UsageSummaryRow, "rank">>();
  for (const event of events) {
    const source = event.source || undefined;
    const file = event.file || undefined;
    const key = JSON.stringify([event.provider, event.model, source ?? null, file ?? null]);
    let row = groups.get(key);
    if (!row) {
      row = {
        provider: event.provider,
        model: event.model,
        ...(source ? { source } : {}),
        ...(file ? { file } : {}),
        calls: 0,
        tokens: 0,
        spendUsd: 0,
        unpricedCalls: 0,
      };
      groups.set(key, row);
    }
    const spend = spendOf(event);
    row.calls += 1;
    row.tokens += tokensOf(event);
    row.spendUsd += spend.usd;
    if (!spend.priced) row.unpricedCalls += 1;
  }
  const ranked = [...groups.values()]
    .sort(
      (a, b) =>
        b.spendUsd - a.spendUsd ||
        a.provider.localeCompare(b.provider) ||
        a.model.localeCompare(b.model) ||
        (a.source ?? "").localeCompare(b.source ?? "") ||
        (a.file ?? "").localeCompare(b.file ?? ""),
    )
    .slice(0, Math.max(0, Math.floor(top)))
    .map((row, index) => ({ rank: index + 1, ...row }));
  return ranked;
}

/** Read every recorded call. Each row is one model call, so aggregation counts them. */
export async function readUsageEvents(
  prisma: Pick<PrismaClient, "usageRecord">,
): Promise<UsageEvent[]> {
  const rows = await prisma.usageRecord.findMany({
    select: {
      provider: true,
      model: true,
      inputTokens: true,
      outputTokens: true,
      totalTokens: true,
      costUsd: true,
      costSource: true,
      usageSource: true,
    },
  });
  return rows.map((row) => ({
    provider: row.provider,
    model: row.model,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    totalTokens: row.totalTokens,
    costUsd: row.costUsd,
    source: row.costSource ?? row.usageSource ?? null,
  }));
}

function parseTop(argv: readonly string[]): number {
  const inline = argv.find((argument) => argument.startsWith("--top="));
  const index = argv.indexOf("--top");
  const raw = inline ? inline.slice("--top=".length) : index >= 0 ? argv[index + 1] : undefined;
  if (raw === undefined) return 10;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error("--top needs a positive integer, for example --top 5");
  }
  return value;
}

function modelLabel(row: UsageSummaryRow): string {
  const parts = [`${row.provider}/${row.model}`];
  if (row.source) parts.push(`[${row.source}]`);
  if (row.file) parts.push(`(${row.file})`);
  return parts.join(" ");
}

function printTable(rows: readonly UsageSummaryRow[]): void {
  const header = ["rank", "model", "calls", "tokens", "spendUSD"];
  const body = rows.map((row) => [
    String(row.rank),
    modelLabel(row),
    String(row.calls),
    String(row.tokens),
    `$${row.spendUsd.toFixed(4)}`,
  ]);
  const widths = header.map((title, column) =>
    Math.max(title.length, ...body.map((cells) => cells[column]!.length)),
  );
  const line = (cells: readonly string[]) =>
    cells
      .map((cell, column) => cell.padEnd(widths[column]!))
      .join(" | ")
      .trimEnd();
  process.stdout.write(`${line(header)}\n`);
  for (const cells of body) process.stdout.write(`${line(cells)}\n`);
  const unpriced = rows.reduce((sum, row) => sum + row.unpricedCalls, 0);
  if (unpriced > 0) {
    process.stdout.write(`note: ${unpriced} call(s) reported no cost and add $0 to spendUSD\n`);
  }
}

async function main(argv: readonly string[]): Promise<void> {
  const top = parseTop(argv);
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is not set; the profiler reads the app's own database");
  }
  // Loaded only when the CLI runs, so importing summarizeUsage never opens a pool.
  const { createDb, runAsSystem } = await import("@rakazo/db");
  const { prisma, pool } = createDb(databaseUrl, { applicationName: "me-usage-profiler" });
  try {
    // Spend spans every Space, so this read is a named row-level-security bypass.
    const events = await runAsSystem(
      "usage profiler ranks recorded spend across the deployment",
      () => readUsageEvents(prisma),
    );
    if (events.length === 0) {
      process.stderr.write("no usage events locally (me_io telemetry not present in this env)\n");
      process.exitCode = 1;
      return;
    }
    printTable(summarizeUsage(events, top));
  } finally {
    await pool.end();
  }
}

function isCliEntry(): boolean {
  const entry = process.argv[1];
  return Boolean(entry) && import.meta.url === pathToFileURL(entry!).href;
}

if (isCliEntry()) {
  await main(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(
      `usage profiler failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
