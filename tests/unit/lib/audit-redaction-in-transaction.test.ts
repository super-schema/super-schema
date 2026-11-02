import { describe, expect, it, vi } from "vitest";
import type { Prisma } from "@/generated/prisma/client";
import { auditInTransaction } from "@/services/imported-links";

// An audit row written inside an import's transaction gets the same credential redaction as one written by withAudit: the audit trail is
// immutable, so an imported schema's `x-api-key` extension must never reach it in plain text.
describe("auditInTransaction: credentials in the recorded states", () => {
  it("redacts credential-looking keys in both states and keeps the rest", async () => {
    const create = vi.fn(async () => ({}));
    const tx = { auditLog: { create } } as unknown as Prisma.TransactionClient;

    await auditInTransaction(tx, { userId: "u", tenantId: "t" }, {
      action: "UPDATE",
      entityType: "Entity",
      entityId: "e1",
      beforeState: { name: "Orders", metadata: { custom: { extensions: { "x-api-key": "sk-live-before" } } } },
      afterState: { name: "Orders", metadata: { custom: { extensions: { "x-api-key": "sk-live-after", "x-owner": "team-a" } } }, secret: true },
    });

    const data = (create.mock.calls[0] as unknown as [{ data: Record<string, unknown> }])[0].data;
    expect(data.beforeState).toEqual({ name: "Orders", metadata: { custom: { extensions: { "x-api-key": "[redacted]" } } } });
    expect(data.afterState).toEqual({ name: "Orders", metadata: { custom: { extensions: { "x-api-key": "[redacted]", "x-owner": "team-a" } } }, secret: true });
    expect(JSON.stringify(data)).not.toContain("sk-live");
  });
});
