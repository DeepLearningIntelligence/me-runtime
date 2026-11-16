import * as z from "zod";
import { Id, IsoDate } from "./ids.js";

/** Why a link refused to open. The welcome page names it; never a bare refusal. */
export const InviteFailure = z.enum([
  /** Unknown token: never issued, mistyped, or already spent by someone else. */
  "invalid",
  /** The link was already claimed by an account. */
  "already_redeemed",
  "expired",
  "revoked",
  /** The inviter has no allowance left. */
  "quota_exceeded",
]);
export type InviteFailure = z.infer<typeof InviteFailure>;

export const InviteIssuedSchema = z.object({
  id: Id,
  /** Shown once, when the link is minted; only the token's SHA-256 is stored. */
  token: z.string().min(1),
  expiresAt: IsoDate,
});
export type InviteIssued = z.infer<typeof InviteIssuedSchema>;

/** What the welcome page shows before anyone signs in: who invited them. */
export const InviteInspectionSchema = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    inviterName: z.string(),
    expiresAt: IsoDate,
  }),
  z.object({
    ok: z.literal(false),
    reason: InviteFailure,
  }),
]);
export type InviteInspection = z.infer<typeof InviteInspectionSchema>;

export const InviteListItemSchema = z.object({
  id: Id,
  status: z.enum(["issued", "redeemed", "revoked"]),
  createdAt: IsoDate,
  expiresAt: IsoDate,
  redeemedAt: IsoDate.nullable(),
});
export type InviteListItem = z.infer<typeof InviteListItemSchema>;

export const InviteQuotaSchema = z.object({
  allocation: z.number().int(),
  grantedCount: z.number().int(),
  redeemedCount: z.number().int(),
});
export type InviteQuota = z.infer<typeof InviteQuotaSchema>;

export const InviteListSchema = z.object({
  quota: InviteQuotaSchema,
  invites: z.array(InviteListItemSchema),
});
export type InviteList = z.infer<typeof InviteListSchema>;
