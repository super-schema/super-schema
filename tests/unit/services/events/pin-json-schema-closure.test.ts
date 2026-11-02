import { describe, it, expect, vi } from "vitest";
vi.mock("@/lib/db", () => ({ prisma: {} }));
import type { Assignment } from "@/types/schemas/rbac";
import { createArtifactRenderer, type EmitFiles } from "@/services/events/artifact-renderer";
import { PIN_SCHEMA_RENDER_FAILED, renderPinJsonSchema } from "@/services/events/pin-json-schema.service";

/**
 * The JSON Schema of a pin renders the pinned version's whole closure (its FIELD edges), as the preview does. A caller whose roles do not cover
 * an entity of that closure gets no schema: the entity's content would reach the editor through a pin whose own entity the caller may read.
 * The real renderer runs over a fake database that honours the tenant filters it is given; only the emitter is stubbed.
 */

const TENANT = "tenant-a";
const D1 = { tenantId: TENANT, domainId: "domain-1", productId: "product-1", product: { domainId: "domain-1" } };
const D2 = { tenantId: TENANT, domainId: "domain-2", productId: null, product: null };

/** Order (E1, domain 1) pins Ledger (E2, domain 2) through its FIELD edge V1 -> V2. */
const VERSIONS: Record<string, Record<string, unknown>> = {
  V1: { id: "V1", entityId: "E1", major: 1, minor: 0, resolvedSource: "model Order {\n  id: string;\n  ledger: Ledger;\n}\n", fieldSnapshot: [], entity: { name: "Order", ...D1 } },
  V2: { id: "V2", entityId: "E2", major: 1, minor: 0, resolvedSource: "model Ledger {\n  total: string;\n}\n", fieldSnapshot: [], entity: { name: "Ledger", ...D2 } },
};
const EDGES: Record<string, string[]> = { V1: ["V2"] };

function fakePrisma() {
  return {
    entityVersion: {
      findFirst: vi.fn(async ({ where }: { where: { id: string; entity: { tenantId: string } } }) => {
        const v = VERSIONS[where.id];
        return v && (v.entity as { tenantId: string }).tenantId === where.entity.tenantId ? { id: where.id } : null;
      }),
      findUnique: vi.fn(async ({ where }: { where: { id: string; entity?: { tenantId: string } } }) => {
        const v = VERSIONS[where.id];
        return v && (where.entity === undefined || (v.entity as { tenantId: string }).tenantId === where.entity.tenantId) ? v : null;
      }),
    },
    entity: {
      findFirst: vi.fn(async () => null),
      findUnique: vi.fn(async () => ({ tenant: { slug: "acme" }, domain: { slug: "payments" }, product: { slug: "checkout" } })),
    },
    schemaReference: {
      findMany: vi.fn(async ({ where }: { where: { fromId: string } }) => (EDGES[where.fromId] ?? []).map((toId) => ({ toId }))),
    },
  };
}

const JSON_SCHEMA_FILE = { relativePath: "Order", content: JSON.stringify({ $schema: "https://json-schema.org/draft/2020-12/schema", type: "object", properties: { id: { type: "string" } } }) };

const PIN = { entityId: "E1", entityVersionId: "V1" };
const ctxOf = (assignments: Assignment[], prisma: unknown) => ({ userId: "u1", userRole: "AUTHOR", assignments, prisma }) as never;
const run = (assignments: Assignment[], emitFiles: EmitFiles) => {
  const prisma = fakePrisma();
  const renderer = createArtifactRenderer({ db: prisma as never, emitFiles });
  return renderPinJsonSchema(ctxOf(assignments, prisma), { tenantId: TENANT, pin: PIN }, { renderer });
};

describe("pin JSON Schema: the closure of the pinned version is read by the caller's roles too", () => {
  it("gives no schema when the caller's roles do not cover an entity the pinned version refers to, and emits nothing", async () => {
    const emitFiles = vi.fn<EmitFiles>(async () => ({ success: true, data: [JSON_SCHEMA_FILE] }));
    const viewerOfD1: Assignment[] = [{ role: "VIEWER", scope: { kind: "DOMAIN", tenantId: TENANT, domainId: "domain-1" } }];

    const out = await run(viewerOfD1, emitFiles);

    expect(out.success).toBe(false);
    if (out.success) return;
    expect(out.error.message).toBe(PIN_SCHEMA_RENDER_FAILED);
    expect(JSON.stringify(out.error)).not.toMatch(/Ledger|E2|V2/);
    expect(emitFiles).not.toHaveBeenCalled();
  });

  it("returns the schema when the caller's roles cover every entity of the closure", async () => {
    const emitFiles = vi.fn<EmitFiles>(async () => ({ success: true, data: [JSON_SCHEMA_FILE] }));
    const everywhere: Assignment[] = [{ role: "VIEWER", scope: { kind: "TENANT", tenantId: TENANT } }];

    const out = await run(everywhere, emitFiles);

    expect(out.success).toBe(true);
    if (out.success) expect(out.data.schema).toMatchObject({ type: "object" });
    expect(emitFiles).toHaveBeenCalledTimes(1);
  });
});
