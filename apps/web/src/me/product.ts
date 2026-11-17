import type { VaultKind } from "@rakazo/contracts";
import { VAULT_KINDS } from "@rakazo/contracts";

/**
 * What this product offers in the vault. A kind left out is absent, not stubbed:
 * no surface offers it. Cards stay out because payments stay out of the product
 * (ME-RUN-001 D-RUN-12).
 */
export const OFFERED_VAULT_KINDS: readonly VaultKind[] = VAULT_KINDS.filter(
  (kind) => kind !== "card",
);
