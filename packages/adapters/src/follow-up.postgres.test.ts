import { randomUUID } from "node:crypto";
import {
  appendEvent,
  asSystem,
  createDb,
  provisionMessagingIdentity,
  runAsSystem,
} from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { followUpState, wakeFollowUp } from "./follow-up.js";

const url = process.env.DATABASE_URL;
const describePostgres = process.env.VERIFY_DATABASE === "1" && url ? describe : describe.skip;

describePostgres("follow-up daily cap (PostgreSQL)", () => {
  it("queues one run when two different routines wake concurrently for the same user", async () => {
    if (!url) throw new Error("DATABASE_URL is required");
    const db = createDb(url);
    const system = asSystem(db.prisma);
    const address = `follow-up-${randomUUID()}@rakazo.test`;
    try {
      const { userId, spaceId, botId, threadId } = await runAsSystem("follow-up cap fixture", () =>
        provisionMessagingIdentity(
          db.prisma,
          { provider: "email", address },
          { signupsEnabled: undefined, signupAllowlist: undefined },
        ),
      );
      try {
        const now = new Date();
        now.setUTCHours(12, 0, 0, 0);
        const previous = new Date(now.getTime() - 60_000);
        const target = { userId, spaceId, botId };
        await system.user.update({ where: { id: userId }, data: { timezone: "UTC" } });
        const routines = await Promise.all(
          ["first", "second"].map(async (name) => {
            const item = await system.scratchpadItem.create({
              data: { ...target, title: name, updatedAt: now },
            });
            return system.routine.create({
              data: {
                ...target,
                name,
                threadId,
                prompt: name,
                crons: [],
                active: true,
                nextRunAt: now,
                followUp: followUpState({
                  item: { id: item.id, updatedAt: previous },
                  agreedAt: previous,
                }),
              },
            });
          }),
        );
        const enqueue = vi.fn(async () => undefined);
        const deps = {
          prisma: system,
          jobs: { enqueue, cancel: async () => undefined, close: async () => undefined },
          events: {
            append: (input: Parameters<typeof appendEvent>[1]) => appendEvent(system, input),
            notify: async () => undefined,
          },
        };
        await Promise.all(
          routines.map((routine) =>
            wakeFollowUp(deps, routine, {
              scheduledAt: now,
              threadId,
              now,
            }),
          ),
        );
        const routineIds = routines.map(({ id }) => id);
        expect(await system.run.count({ where: { routineId: { in: routineIds } } })).toBe(1);
        expect(
          await system.routine.count({ where: { id: { in: routineIds }, active: true } }),
        ).toBe(0);
        expect(enqueue).toHaveBeenCalledTimes(1);
      } finally {
        await system.messagingIdentity.deleteMany({ where: { address } });
        await system.organization.deleteMany({ where: { id: spaceId } });
        await system.user.deleteMany({ where: { id: userId } });
      }
    } finally {
      await db.prisma.$disconnect();
      await db.pool.end();
    }
  });
});
