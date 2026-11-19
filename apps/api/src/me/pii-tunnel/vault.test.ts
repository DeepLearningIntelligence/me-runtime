import { EncryptedSecretStore } from "@rakazo/adapters";
import { describe, expect, it } from "vitest";
import { seal, unseal } from "./vault.js";

const key = "pii-tunnel-test-encryption-key";

describe("PII vault", () => {
  it("seals an upload and opens the same value", async () => {
    const store = new EncryptedSecretStore(key);
    const plaintext = JSON.stringify({ username: "damu", password: "correct horse" });
    const sealed = await seal(store, plaintext, "user-1");
    expect(sealed.ciphertext.startsWith("v2:")).toBe(true);
    expect(sealed.ciphertext).not.toContain("correct horse");
    await expect(unseal(store, { id: sealed.id, ciphertext: sealed.ciphertext })).resolves.toBe(
      plaintext,
    );
  });

  it("refuses the ciphertext under another record id", async () => {
    const store = new EncryptedSecretStore(key);
    const sealed = await seal(store, "secret", "user-1");
    await expect(
      unseal(store, { id: "another-record", ciphertext: sealed.ciphertext }),
    ).rejects.toThrow();
  });

  it("refuses a different key", async () => {
    const sealed = await seal(new EncryptedSecretStore(key), "secret", "user-1");
    await expect(
      unseal(new EncryptedSecretStore("another-key"), {
        id: sealed.id,
        ciphertext: sealed.ciphertext,
      }),
    ).rejects.toThrow();
  });
});
