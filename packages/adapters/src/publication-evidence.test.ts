import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import {
  buildPublicationCard,
  collectPublicationEvidence,
  PublicationEvidenceError,
} from "./publication-evidence.js";

type McpServerRead = Pick<PrismaClient, "mcpServer">;

function connectionRow(row: { id: string; enabled: boolean } | null): McpServerRead {
  return { mcpServer: { findFirst: vi.fn(async () => row) } } as unknown as McpServerRead;
}

const ready = () => connectionRow({ id: "srv_1", enabled: true });

function gfinResult(payload: unknown) {
  return { content: [{ type: "text", text: JSON.stringify(payload) }] };
}

describe("collectPublicationEvidence", () => {
  it("reads readiness from the Space's connection and the lists from GFIN", async () => {
    const callTool = vi.fn(async () => ({
      structuredContent: {
        opportunities: [
          { title: "Coastal Resilience Grant", status: "applied" },
          { title: "Rural Broadband Fund", status: "denied" },
          { name: "Water Storage Co-op" },
        ],
      },
    }));
    const evidence = await collectPublicationEvidence(
      "space_1",
      { gfin_url: "https://gofunditnow.com/opportunities/coastal" },
      { prisma: ready(), callTool },
    );
    expect(evidence).toEqual({
      applied: ["Coastal Resilience Grant", "Water Storage Co-op"],
      denied: ["Rural Broadband Fund"],
      readiness: true,
      gfinLink: "https://gofunditnow.com/opportunities/coastal",
    });
    expect(callTool).toHaveBeenCalledWith("get_my_saved_opportunities", {});
  });

  it("reads the payload from the text block when there is no structured content", async () => {
    const evidence = await collectPublicationEvidence(
      "space_1",
      {},
      {
        prisma: ready(),
        callTool: async () =>
          gfinResult({ opportunities: [{ title: "Youth Sports Grant", status: "applied" }] }),
      },
    );
    expect(evidence.applied).toEqual(["Youth Sports Grant"]);
    expect(evidence.gfinLink).toBe("https://app.gofunditnow.com");
  });

  it("does not read GFIN when the Space has no ready connection", async () => {
    const callTool = vi.fn();
    const evidence = await collectPublicationEvidence("space_1", {}, {
      prisma: connectionRow(null),
      callTool,
    });
    expect(evidence).toEqual({
      applied: [],
      denied: [],
      readiness: false,
      gfinLink: "https://app.gofunditnow.com",
    });
    expect(callTool).not.toHaveBeenCalled();
  });

  it("treats a disabled connection row as not ready", async () => {
    const callTool = vi.fn();
    const evidence = await collectPublicationEvidence("space_1", {}, {
      prisma: connectionRow({ id: "srv_1", enabled: false }),
      callTool,
    });
    expect(evidence.readiness).toBe(false);
    expect(callTool).not.toHaveBeenCalled();
  });

  it("throws a named contract mismatch for a payload outside the saved-opportunities shape", async () => {
    const error = await collectPublicationEvidence("space_1", {}, {
      prisma: ready(),
      callTool: async () => ({ structuredContent: { rows: [] } }),
    }).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(PublicationEvidenceError);
    expect((error as PublicationEvidenceError).key).toBe("gfin_evidence_contract_mismatch");
  });

  it("throws a named contract mismatch for a row with no name", async () => {
    const error = await collectPublicationEvidence("space_1", {}, {
      prisma: ready(),
      callTool: async () => ({ structuredContent: { opportunities: [{ status: "applied" }] } }),
    }).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(PublicationEvidenceError);
    expect((error as PublicationEvidenceError).key).toBe("gfin_evidence_contract_mismatch");
  });

  it("fails closed when GFIN refuses the read", async () => {
    const error = await collectPublicationEvidence("space_1", {}, {
      prisma: ready(),
      callTool: async () => ({
        isError: true,
        content: [{ type: "text", text: "not connected" }],
      }),
    }).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(PublicationEvidenceError);
    expect((error as PublicationEvidenceError).key).toBe("gfin_evidence_unavailable");
  });

  it("throws a named DB contract mismatch when the connection row is malformed", async () => {
    const prisma = {
      mcpServer: { findFirst: vi.fn(async () => ({ id: 42, enabled: "yes" })) },
    } as unknown as McpServerRead;
    const error = await collectPublicationEvidence("space_1", {}, {
      prisma,
      callTool: vi.fn(),
    }).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(PublicationEvidenceError);
    expect((error as PublicationEvidenceError).key).toBe("db_evidence_contract_mismatch");
  });
});

describe("buildPublicationCard", () => {
  it("validates a ready gather and copies both lists", () => {
    expect(
      buildPublicationCard({
        applied: ["A"],
        denied: ["B"],
        readiness: true,
        gfinLink: "https://app.gofunditnow.com",
      }),
    ).toEqual({
      validated: true,
      applied_by: ["A"],
      denied_by: ["B"],
      gfinLink: "https://app.gofunditnow.com",
    });
  });

  it("marks an unready gather unvalidated with a named reason", () => {
    expect(
      buildPublicationCard({
        applied: [],
        denied: [],
        readiness: false,
        gfinLink: "https://app.gofunditnow.com",
      }),
    ).toEqual({
      validated: false,
      applied_by: [],
      denied_by: [],
      reason: "gfin_connection_not_ready",
      gfinLink: "https://app.gofunditnow.com",
    });
  });
});
