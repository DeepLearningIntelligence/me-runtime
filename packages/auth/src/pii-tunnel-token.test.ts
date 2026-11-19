import { describe, expect, it } from "vitest";
import {
  consumePIITunnelToken,
  issuePIITunnelToken,
  PII_TUNNEL_TOKEN_MS,
  PII_TUNNEL_TOKEN_PREFIX,
} from "./pii-tunnel-token.js";

type Row = { value: string; expiresAt: Date };

/** The verification store's two calls, mirrored so the suite needs no database. */
function fakeVerifications() {
  const rows = new Map<string, Row>();
  return {
    rows,
    async createVerificationValue(data: { identifier: string; value: string; expiresAt: Date }) {
      rows.set(data.identifier, { value: data.value, expiresAt: data.expiresAt });
      return data;
    },
    async consumeVerificationValue(identifier: string): Promise<Row | null> {
      const row = rows.get(identifier);
      if (!row) return null;
      rows.delete(identifier);
      return { ...row };
    },
  };
}

describe("PII tunnel tokens", () => {
  it("issues a one-shot token under the tunnel prefix for its person", async () => {
    const store = fakeVerifications();
    const token = await issuePIITunnelToken(store, "user-1");
    const [identifier, row] = [...store.rows.entries()][0]!;
    expect(identifier).toBe(`${PII_TUNNEL_TOKEN_PREFIX}${token}`);
    expect(row.value).toBe("user-1");
    expect(row.expiresAt.getTime() - Date.now()).toBeGreaterThan(0);
    expect(row.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(PII_TUNNEL_TOKEN_MS);

    await expect(consumePIITunnelToken(store, token)).resolves.toBe("user-1");
    // Consuming deleted the row: a replayed link names nobody.
    await expect(consumePIITunnelToken(store, token)).resolves.toBeNull();
    expect(store.rows.size).toBe(0);
  });

  it("refuses an unknown token and an empty one without touching the store", async () => {
    const store = fakeVerifications();
    await expect(consumePIITunnelToken(store, "not-a-token")).resolves.toBeNull();
    await expect(consumePIITunnelToken(store, "")).resolves.toBeNull();
  });

  it("refuses a token whose window closed and consumes it anyway", async () => {
    const store = fakeVerifications();
    store.rows.set(`${PII_TUNNEL_TOKEN_PREFIX}expired`, {
      value: "user-2",
      expiresAt: new Date(Date.now() - 1),
    });
    await expect(consumePIITunnelToken(store, "expired")).resolves.toBeNull();
    expect(store.rows.has(`${PII_TUNNEL_TOKEN_PREFIX}expired`)).toBe(false);
  });

  it("keeps one person's token from naming another", async () => {
    const store = fakeVerifications();
    const first = await issuePIITunnelToken(store, "user-1");
    const second = await issuePIITunnelToken(store, "user-2");
    await expect(consumePIITunnelToken(store, first)).resolves.toBe("user-1");
    await expect(consumePIITunnelToken(store, second)).resolves.toBe("user-2");
  });
});
