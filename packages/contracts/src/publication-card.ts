import * as z from "zod";

/**
 * The Visual Pack card a run posts after a public action completes (Packet D, QW-1),
 * answering "who applied, who was denied?" from evidence read back after the action:
 * the Space's GFIN connection readiness from local rows, and the applied and denied
 * lists from the GFIN connection itself.
 *
 * `validated` is true only when the evidence came from a ready connection. When it did
 * not, `reason` names why and the lists stay empty, so a card never claims evidence it
 * could not read.
 */
export const PublicationCard = z.object({
  validated: z.boolean(),
  applied_by: z.array(z.string()),
  denied_by: z.array(z.string()),
  reason: z.string().optional(),
  gfinLink: z.string(),
});
export type PublicationCard = z.infer<typeof PublicationCard>;

/** The message block a run posts: the publication card plus the block's kind. */
export const PublicationCardBlock = PublicationCard.extend({
  kind: z.literal("visual_pack"),
});
export type PublicationCardBlock = z.infer<typeof PublicationCardBlock>;
