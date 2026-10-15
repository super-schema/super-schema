/**
 * Story 16.6 (R53): publishing a FRESH stored source freezes it verbatim, except that legacy `@tag(...)`
 * lines (stored before the generator stopped emitting them) are upgraded first — otherwise an uncompilable
 * source would be frozen into an immutable version. The upgraded text is written back in the same
 * transaction. Mocked Prisma and audit: no database rows, so no immutable PUBLISH_VERSION audit entry.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { publishEntity } from "@/services/entity-version.service";
import { WRITE_BACK_SOURCE_SQL } from "@/lib/entity-versioning/draft-state";
import { freezableStoredSource } from "@/lib/entity-versioning/resolve-source";
import type { ServiceContext } from "@/types/service-context";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/audit", () => ({
  withAudit: async ({ fn }: { fn: () => Promise<unknown> }) => fn(),
  AuditUserMissingError: class extends Error {},
}));

const LEGACY = [
  '@tag("sales")',
  "model Order {",
  "  id: string;",
  '  @tag("classification:PII")',
  "  email?: string;",
  "}",
  "",
].join("\n");

const CURRENT = ["@doc(\"Orders\")", "model Order {", "  id: string;", "}", ""].join("\n");

function fakePrisma(typespecSource: string) {
  const entityRow = {
    id: "e1",
    name: "Order",
    status: "DRAFT",
    version: 1,
    hasUnpublishedChanges: true,
    typespecSource,
    metadata: null,
    fields: [],
    latestVersion: null,
  };
  const created: Array<{ resolvedSource: string }> = [];
  const executed: unknown[][] = [];
  const tx = {
    $queryRaw: vi.fn().mockResolvedValue([]),
    $executeRawUnsafe: vi.fn(async (...args: unknown[]) => {
      executed.push(args);
      return 1;
    }),
    entity: {
      findUnique: vi.fn().mockResolvedValue(entityRow),
      findMany: vi.fn().mockResolvedValue([]),
      update: vi.fn().mockResolvedValue({ id: "e1" }),
    },
    entityVersion: {
      create: vi.fn(async ({ data }: { data: { resolvedSource: string } }) => {
        created.push(data);
        return {
          id: "v1", entityId: "e1", major: 1, minor: 0, sequence: 1, changeKind: "MINOR", changeSummary: null,
          publishedById: "u1", publishedAt: new Date("2026-10-14T00:00:00Z"), publishedBy: { name: "U" },
        };
      }),
    },
    schemaReference: { createMany: vi.fn() },
  };
  const prisma = {
    entity: tx.entity,
    $transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
  };
  return { prisma, created, executed };
}

const ctxFor = (prisma: unknown) => ({ userId: "u1", userRole: "AUTHOR", prisma }) as unknown as ServiceContext;

describe("freezableStoredSource", () => {
  it("upgrades legacy @tag lines and reports it; leaves a current source untouched", () => {
    const up = freezableStoredSource(LEGACY);
    expect(up.upgraded).toBe(true);
    expect(up.source).not.toMatch(/@tag\(/);
    expect(up.source).toContain('@TypeSpec.OpenAPI.extension("x-tags", #["sales"])');
    expect(freezableStoredSource(CURRENT)).toEqual({ source: CURRENT, upgraded: false });
  });
});

describe("publishEntity phase 2 with a fresh stored source", () => {
  beforeEach(() => vi.clearAllMocks());

  it("freezes the upgraded text and writes it back in the same transaction when legacy @tag lines remain", async () => {
    const { prisma, created, executed } = fakePrisma(LEGACY);
    const res = await publishEntity("e1", {}, ctxFor(prisma));
    expect(res.success).toBe(true);

    const upgraded = freezableStoredSource(LEGACY).source;
    expect(created).toHaveLength(1);
    expect(created[0].resolvedSource).toBe(upgraded);
    expect(created[0].resolvedSource).not.toMatch(/@tag\(/);
    expect(executed).toEqual([[WRITE_BACK_SOURCE_SQL, "e1", upgraded]]);
  });

  it("freezes a current stored source verbatim and does not write it back", async () => {
    const { prisma, created, executed } = fakePrisma(CURRENT);
    const res = await publishEntity("e1", {}, ctxFor(prisma));
    expect(res.success).toBe(true);
    expect(created[0].resolvedSource).toBe(CURRENT);
    expect(executed).toEqual([]);
  });
});
