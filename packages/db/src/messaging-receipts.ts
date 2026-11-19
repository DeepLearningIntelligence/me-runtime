import type { PrismaClient } from "./client.js";

/** A location a platform reported on an inbound message. */
export interface InboundLocation {
  latitude: number;
  longitude: number;
  label?: string;
}

export interface InboundReceiptInput {
  provider: string;
  handle: string;
  spaceId: string;
  botId: string;
  userId: string;
  threadId: string;
  medium: string;
  location?: InboundLocation;
}

/**
 * Record one inbound message's receipt. A replay (same provider message id)
 * leaves the first row alone, so a redelivery changes nothing. A receipt write
 * never gates delivery: the caller decides whether to await it.
 */
export async function recordInboundReceipt(
  prisma: PrismaClient,
  input: InboundReceiptInput,
): Promise<void> {
  await prisma.messagingReceipt.createMany({
    data: [
      {
        provider: input.provider,
        handle: input.handle,
        spaceId: input.spaceId,
        botId: input.botId,
        userId: input.userId,
        threadId: input.threadId,
        medium: input.medium,
        latitude: input.location?.latitude,
        longitude: input.location?.longitude,
        label: input.location?.label,
      },
    ],
    skipDuplicates: true,
  });
}

/** The newest location receipt in a Space, or null when nobody shared one yet. */
export async function latestLocationReceipt(
  prisma: PrismaClient,
  spaceId: string,
): Promise<{ latitude: number; longitude: number; label: string | null; capturedAt: Date } | null> {
  const row = await prisma.messagingReceipt.findFirst({
    where: { spaceId, latitude: { not: null }, longitude: { not: null } },
    orderBy: { capturedAt: "desc" },
    select: { latitude: true, longitude: true, label: true, capturedAt: true },
  });
  if (!row || row.latitude === null || row.longitude === null) return null;
  return {
    latitude: row.latitude,
    longitude: row.longitude,
    label: row.label,
    capturedAt: row.capturedAt,
  };
}
