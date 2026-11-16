import type { CodexLiveCatalog } from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import { withModelRoles } from "../../../../packages/adapters/src/testing/model-roles.js";
import type { prepareModelCredential } from "../model-credentials.js";
import {
  createModelConnector,
  persistModelCredential,
  writeModelCredential,
} from "../model-credentials.js";
import type { RouterDeps } from "../router.js";
import {
  MODEL_CONNECTION_REFUSED_MESSAGE,
  MODEL_POLICY_ENV,
  MODEL_POLICY_HOUSE_ONLY,
  parseModelPolicy,
} from "./model-policy.js";

const actor = {
  spaceId: "workspace-1",
  userId: "user-1",
  email: "user@rakazo.test",
  isDeploymentOwner: true,
} satisfies Actor;

const connectInput = { provider: "openrouter", apiKey: "sk-fake-user-key", credentialId: null };

/** A RouterDeps stub whose only writer is the stubbed prisma client, so the test can see
 * whether anything was written. The model credential paths never touch a real database here. */
function policyDeps(modelPolicy: string) {
  const userModelCredential = {
    findFirst: vi.fn().mockResolvedValue(null),
    findMany: vi.fn().mockResolvedValue([]),
    create: vi.fn(async ({ data }: { data: { provider: string } }) => ({
      id: "cred-1",
      userId: actor.userId,
      provider: data.provider,
      label: data.provider,
      secretId: "secret-1",
      supportsImages: false,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    })),
    update: vi.fn(),
  };
  const userModelPreference = {
    findFirst: vi.fn().mockResolvedValue(null),
    updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    upsert: vi.fn().mockResolvedValue({ id: "preference" }),
  };
  const tx = {
    userModelCredential,
    secret: { create: vi.fn().mockResolvedValue({ id: "secret-1" }) },
    userModelPreference,
  };
  const prisma = {
    userModelCredential,
    userModelPreference,
    deploymentSettings: { findUnique: vi.fn().mockResolvedValue(null) },
    $transaction: vi.fn(async (work: (client: unknown) => unknown) => work(withModelRoles(tx))),
  };
  const deps = {
    prisma,
    secrets: { put: vi.fn().mockResolvedValue({ id: "secret-1", ciphertext: "cipher" }) },
    // Offline key verification: transport errors are tolerated by the connect path, so
    // "policy off" can run the whole save without reaching a real provider.
    modelConnectionFetch: vi.fn().mockRejectedValue(new Error("offline test transport")),
    env: {
      agentRuntime: "pi",
      defaultProvider: "openrouter",
      defaultModel: "openai/gpt-5.6-luna",
      webOrigin: "http://127.0.0.1:5173",
      screenProxySecret: "fake-test-secret",
      sandboxProvider: "fake",
      modelPolicy,
    },
  } as unknown as RouterDeps;
  return { deps, prisma, userModelCredential };
}

describe("parseModelPolicy", () => {
  it("reads the deployment config", () => {
    expect(parseModelPolicy(undefined)).toBe("");
    expect(parseModelPolicy("")).toBe("");
    expect(parseModelPolicy("house_only")).toBe("house_only");
    expect(() => parseModelPolicy("yes")).toThrow(MODEL_POLICY_ENV);
  });
});

describe("model policy on the model-connection write paths", () => {
  it("refuses the connect path with the named 403 and writes nothing", async () => {
    const { deps } = policyDeps(MODEL_POLICY_HOUSE_ONLY);
    const connector = createModelConnector(deps, {} as CodexLiveCatalog);
    const error = await connector
      .connectModelCredential(actor, connectInput, undefined)
      .catch((caught: unknown) => caught);
    // FORBIDDEN is the oRPC code served as HTTP 403; the message names the refusing rule.
    expect(error).toMatchObject({ code: "FORBIDDEN" });
    expect((error as { message: string }).message).toContain("model_policy_house_only");
    expect((error as { message: string }).message).toBe(MODEL_CONNECTION_REFUSED_MESSAGE);
    // Nothing was stored or written: no key verification, no secret, no row.
    expect(deps.secrets.put).not.toHaveBeenCalled();
    expect(deps.prisma.$transaction).not.toHaveBeenCalled();
  });

  it("refuses the direct save path before the secret store sees the key", async () => {
    const { deps } = policyDeps(MODEL_POLICY_HOUSE_ONLY);
    await expect(
      persistModelCredential(
        deps,
        actor,
        { provider: "openrouter", credentialId: null, plaintext: "sk-fake-user-key" },
        {} as CodexLiveCatalog,
      ),
    ).rejects.toThrow(MODEL_CONNECTION_REFUSED_MESSAGE);
    expect(deps.secrets.put).not.toHaveBeenCalled();
    expect(deps.prisma.$transaction).not.toHaveBeenCalled();
  });

  it("lets the same connect path proceed when the policy is off", async () => {
    const { deps, userModelCredential } = policyDeps("");
    const connector = createModelConnector(deps, {} as CodexLiveCatalog);
    await expect(
      connector.connectModelCredential(actor, connectInput, undefined),
    ).resolves.toMatchObject({ provider: "openrouter" });
    // The path really ran: the key was stored and the connection row written.
    expect(deps.secrets.put).toHaveBeenCalledWith("sk-fake-user-key", expect.anything());
    expect(userModelCredential.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ provider: "openrouter" }) }),
    );
    expect(deps.prisma.$transaction).toHaveBeenCalledOnce();
  });

  it("refuses the lowest-level writer directly, so no caller bypasses the check", async () => {
    const modelPolicy = MODEL_POLICY_HOUSE_ONLY;
    const create = vi.fn();
    const tx = {
      userModelCredential: { findFirst: vi.fn().mockResolvedValue(null), create, update: vi.fn() },
      secret: { create: vi.fn() },
    } as never;
    const input = { provider: "openrouter", credentialId: null, plaintext: "sk-fake-user-key" };
    const prepared = {
      stored: { id: "secret-1", ref: "secret-1", ciphertext: "cipher" },
      defaultModel: "openai/gpt-5.6-luna",
      allowedThinking: undefined,
    } as Awaited<ReturnType<typeof prepareModelCredential>>;
    await expect(writeModelCredential(tx, actor, input, prepared, modelPolicy)).rejects.toThrow(
      MODEL_CONNECTION_REFUSED_MESSAGE,
    );
    expect(create).not.toHaveBeenCalled();
  });

  it("keeps the lowest-level writer working when the policy is off", async () => {
    const create = vi.fn(async ({ data }: { data: { provider: string } }) => ({
      id: "cred-1",
      ...data,
    }));
    const tx = {
      userModelCredential: {
        findFirst: vi.fn().mockResolvedValue(null),
        findMany: vi.fn().mockResolvedValue([]),
        create,
        update: vi.fn(),
      },
      secret: { create: vi.fn().mockResolvedValue({ id: "secret-1" }) },
      userModelPreference: {
        findFirst: vi.fn().mockResolvedValue(null),
        upsert: vi.fn().mockResolvedValue({}),
      },
    };
    const prepared = {
      stored: { id: "secret-1", ref: "secret-1", ciphertext: "cipher" },
      defaultModel: "openai/gpt-5.6-luna",
      allowedThinking: undefined,
    } as Awaited<ReturnType<typeof prepareModelCredential>>;
    const written = await writeModelCredential(
      withModelRoles(tx) as never,
      actor,
      { provider: "openrouter", credentialId: null, plaintext: "sk-fake-user-key" },
      prepared,
      "",
    );
    expect(written).toMatchObject({ id: "cred-1", provider: "openrouter" });
    expect(create).toHaveBeenCalledOnce();
  });

  it("refuses a save against a connection that predates the policy", async () => {
    // Decided (FORK.d/B.md): a connection created before house_only stays readable and can be
    // disconnected, but the write path refuses every save against it, including a re-key.
    const existing = {
      id: "cred-old",
      userId: actor.userId,
      provider: "openrouter",
      secretId: "old-secret",
    };
    const { deps } = policyDeps(MODEL_POLICY_HOUSE_ONLY);
    (deps.prisma.userModelCredential.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(
      existing,
    );
    await expect(
      persistModelCredential(
        deps,
        actor,
        { provider: "openrouter", credentialId: "cred-old", plaintext: "sk-fake-user-key" },
        {} as CodexLiveCatalog,
      ),
    ).rejects.toThrow(MODEL_CONNECTION_REFUSED_MESSAGE);
    expect(deps.secrets.put).not.toHaveBeenCalled();
    expect(deps.prisma.$transaction).not.toHaveBeenCalled();
  });
});
