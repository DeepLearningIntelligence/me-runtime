import { randomUUID } from "node:crypto";
import type { SecretStore } from "@rakazo/adapter-kit";

export type SealedPii = { id: string; ciphertext: string };

/**
 * Seals one tunnel upload with the deployment's encrypted secret store. The
 * fresh record id is the ciphertext's authenticated data, so a value copied
 * onto another upload cannot be opened there; the row stores the id beside the
 * ciphertext so the one caller that needs the value can open it.
 */
export async function seal(
  secretStore: Pick<SecretStore, "put">,
  plaintext: string,
  userId: string,
): Promise<SealedPii> {
  const recordId = randomUUID();
  const stored = await secretStore.put(
    plaintext,
    {
      operationId: `pii-upload-${recordId}`,
      traceId: recordId,
      userId,
      // A tunnel upload belongs to the person, not to a Space; the store keeps no Space path.
      spaceId: "",
      signal: new AbortController().signal,
    },
    { recordId },
  );
  return { id: recordId, ciphertext: stored.ciphertext };
}

/** Opens a sealed upload for the one caller that uses it. Values are never logged. */
export async function unseal(
  secretStore: Pick<SecretStore, "load">,
  row: { id: string; ciphertext: string },
): Promise<string> {
  return secretStore.load(row.ciphertext, { recordId: row.id });
}
