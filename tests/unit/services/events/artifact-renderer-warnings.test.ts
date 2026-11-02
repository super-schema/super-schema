import { describe, it, expect, vi } from "vitest";
vi.mock("@/lib/db", () => ({ prisma: {} }));
vi.mock("@/lib/events/version-source", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/events/version-source")>();
  return {
    ...actual,
    // `warnings` is empty for every real input today (conflicts are errors); fake a non-fatal note to prove the plumbing.
    combineTypeSpecSources: (parts: Parameters<typeof actual.combineTypeSpecSources>[0]) => {
      const r = actual.combineTypeSpecSources(parts);
      return r.success ? { ...r, data: { ...r.data, warnings: ["a non-fatal note"] } } : r;
    },
  };
});
import { createArtifactRenderer, type EmitFiles } from "@/services/events/artifact-renderer";

const TENANT = "tenant-acme";

const db = {
  entityVersion: {
    findUnique: vi.fn(async () => ({
      id: "vOrder", entityId: "eOrder", major: 1, minor: 0, entity: { name: "Order" },
      resolvedSource: "model Order {\n  id: string;\n}\n", fieldSnapshot: [],
    })),
  },
  schemaReference: { findMany: vi.fn(async () => []) },
  entity: { findUnique: vi.fn(async () => ({ tenant: { slug: "acme" }, domain: null, product: null })) },
};

describe("artifact renderer — warnings", () => {
  it("surfaces the program-combination warnings through render, also from the cache", async () => {
    const emitFiles = vi.fn<EmitFiles>(async () => ({ success: true, data: [{ relativePath: "Order.avsc.json", content: '{"type":"record","name":"Order"}' }] }));
    const renderer = createArtifactRenderer({ db: db as never, emitFiles });
    const subject = { kind: "version" as const, entityVersionId: "vOrder", tenantId: TENANT };
    const first = await renderer.render(subject, "avro");
    expect(first.success && first.data.warnings).toEqual(["a non-fatal note"]);
    const second = await renderer.render(subject, "avro");
    expect(second.success && second.data.warnings).toEqual(["a non-fatal note"]);
    expect(emitFiles).toHaveBeenCalledTimes(1);
  });
});
