// R10 / A3: a stored AsyncAPI document published before a key became `internal` is stripped on read, with the CURRENT dictionary.
import { describe, expect, it, vi } from "vitest";
vi.mock("@/lib/db", () => ({ prisma: {} }));
import { emitEventStoredVersion } from "@/services/events/event-emit.service";

const TENANT = "tenant-a";
const EVENT = "event-1";
const PRODUCT = "product-1";
const ADMIN = [{ role: "ADMIN", scope: { kind: "GLOBAL" } }];

const STORED = {
  asyncapi: "3.0.0",
  info: { title: "checkout", version: "1.0.0" },
  channels: { orders: { address: "orders.v1", "x-review-note": "secret-ch", "x-owner": "payments" } },
  components: { messages: { Created: { payload: { type: "object", properties: { a: { type: "string", "x-review-note": "secret-deep" } } } } } },
};

function fakePrisma(definitions: Array<Record<string, unknown>>) {
  const event = {
    id: EVENT, name: "checkout", specType: "asyncapi@3.0", tenantId: TENANT, domainId: "domain-1", productId: PRODUCT,
    product: { slug: "checkout" }, latestVersion: null,
  };
  return {
    eventSpec: { findUnique: vi.fn(async () => event) },
    product: { findUnique: vi.fn(async () => ({ id: PRODUCT, domainId: "domain-1", domain: { tenantId: TENANT } })) },
    eventSpecVersion: { findUnique: vi.fn(async () => ({ document: structuredClone(STORED), major: 1, minor: 0, patch: 0, stage: "RELEASED", compatReport: {} })) },
    metadataAttributeDefinition: { findMany: vi.fn(async (args: { where: { tenantId: string } }) => (args.where.tenantId === TENANT ? definitions : [])) },
  };
}

const row = (key: string, scope: string) => ({
  id: key, tenantId: TENANT, key, label: key, description: "", valueSchema: { type: "string" }, targets: ["channel"], scope,
  placement: "field", derive: null, requiredWhen: "never", pack: null, protobufOptionNumber: null, createdAt: new Date(), updatedAt: new Date(),
});

describe("emitEventStoredVersion: internal keys (R10, A3)", () => {
  it("strips a key that is internal NOW from the stored document, at any depth", async () => {
    const prisma = fakePrisma([row("x-review-note", "internal"), row("x-owner", "schema")]);
    const res = await emitEventStoredVersion(EVENT, PRODUCT, "1.0.0", { userId: "u1", userRole: "ADMIN", assignments: ADMIN, prisma } as never);
    expect(res.success).toBe(true);
    if (!res.success) return;
    expect(res.data.json).not.toContain("secret");
    expect(res.data.yaml).not.toContain("secret");
    expect(JSON.stringify(res.data.document)).not.toContain("x-review-note");
    expect(res.data.json).toContain("x-owner");
    expect(prisma.metadataAttributeDefinition.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ tenantId: TENANT }) }));
  });

  it("serves the stored document as published when no key is internal", async () => {
    const res = await emitEventStoredVersion(EVENT, PRODUCT, "1.0.0", { userId: "u1", userRole: "ADMIN", assignments: ADMIN, prisma: fakePrisma([]) } as never);
    expect(res.success && res.data.json).toContain("secret-ch");
  });
});
