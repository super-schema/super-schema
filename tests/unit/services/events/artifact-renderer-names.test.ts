/**
 * Final review F5 through the real renderer sequence (combine -> buildTargetSource -> real `tsp`):
 * - C1: a protobuf payload keeps every field named like a TypeSpec reserved word (`context`, `metadata`, `op` …);
 * - I2: an Avro payload with enum values such as `in-progress` is a valid Avro schema, with a coded warning per rename
 *   and a clear error when two values collide.
 */
import { describe, it, expect, vi } from "vitest";
vi.mock("@/lib/db", () => ({ prisma: {} }));
import { createArtifactRenderer, type EmitFiles } from "@/services/events/artifact-renderer";

type V = { id: string; entityId: string; major: number; minor: number; resolvedSource: string; fieldSnapshot: unknown; entity: { name: string } };

const versions: Record<string, V> = {
  vOrder: {
    id: "vOrder", entityId: "eOrder", major: 1, minor: 0, entity: { name: "Order" },
    resolvedSource: "model Order {\n  id: string;\n  context: string;\n  `op`: string;\n  metadata: string;\n  `in-progress`: string;\n}\n",
    fieldSnapshot: [
      { name: "id", fieldNumber: null }, { name: "context", fieldNumber: null }, { name: "op", fieldNumber: null },
      { name: "metadata", fieldNumber: 9 }, { name: "in-progress", fieldNumber: null },
    ],
  },
  vTicket: {
    id: "vTicket", entityId: "eTicket", major: 1, minor: 0, entity: { name: "Ticket" },
    resolvedSource: 'enum Ticket_status {\n  "in-progress",\n  "en US",\n  done,\n}\n\nmodel Ticket {\n  id: string;\n  status: Ticket_status;\n}\n',
    fieldSnapshot: [{ name: "id", fieldNumber: null }, { name: "status", fieldNumber: null }],
  },
  vClash: {
    id: "vClash", entityId: "eClash", major: 1, minor: 0, entity: { name: "Clash" },
    resolvedSource: 'enum Clash_kind {\n  "a-b",\n  "a b",\n}\n\nmodel Clash {\n  kind: Clash_kind;\n}\n',
    fieldSnapshot: [{ name: "kind", fieldNumber: null }],
  },
};

function fakeDb() {
  return {
    entityVersion: { findUnique: vi.fn(async ({ where }: { where: { id: string } }) => versions[where.id] ?? null) },
    schemaReference: { findMany: vi.fn(async () => []) },
    entity: { findUnique: vi.fn(async () => ({ tenant: { slug: "acme" }, domain: { slug: "payments" }, product: { slug: "checkout" } })) },
  };
}

const subject = (id: string) => ({ kind: "version" as const, entityVersionId: id });

describe("protobuf payload (real tsp)", () => {
  it("keeps context / metadata / op / in-progress with their numbers", async () => {
    const r = await createArtifactRenderer({ db: fakeDb() as never }).render(subject("vOrder"), "protobuf");
    if (!r.success) throw new Error(r.error.message);
    const proto = r.data.artifact.schema as string;
    expect(proto).toContain("message Order {");
    expect(proto).toContain("string id = 1;");
    expect(proto).toContain("string context = 2;");
    expect(proto).toContain("string op = 3;");
    expect(proto).toContain("string metadata = 9;");
    expect(proto).toContain("string in_progress = 5;");
  }, 120_000);
});

describe("Avro payload", () => {
  it("passes the emitter valid symbols (not the wire values) and reports each rename as a coded note", async () => {
    const emitFiles = vi.fn<EmitFiles>(async () => ({
      success: true,
      data: [{ relativePath: "Ticket.avsc.json", content: '{"type":"record","name":"Ticket","fields":[]}' }],
    }));
    const r = await createArtifactRenderer({ db: fakeDb() as never, emitFiles }).render(subject("vTicket"), "avro");
    if (!r.success) throw new Error(r.error.message);
    const source = emitFiles.mock.calls[0][1];
    expect(source).toContain("  in_progress,");
    expect(source).toContain("  en_US,");
    expect(source).not.toContain("in-progress");
    expect(r.data.notes).toEqual([
      { code: "AVRO_ENUM_SYMBOL_RENAMED", message: expect.stringContaining('"in-progress" of Ticket_status is published as "in_progress"') },
      { code: "AVRO_ENUM_SYMBOL_RENAMED", message: expect.stringContaining('"en US" of Ticket_status is published as "en_US"') },
    ]);
    expect(r.data.warnings).toEqual([]);
  });

  it("through the real Avro emitter the published symbols are valid", async () => {
    const r = await createArtifactRenderer({ db: fakeDb() as never }).render(subject("vTicket"), "avro");
    if (!r.success) throw new Error(r.error.message);
    const schema = r.data.artifact.schema as { fields: Array<{ name: string; type: { symbols?: string[] } }> };
    expect(schema.fields.find((f) => f.name === "status")?.type.symbols).toEqual(["in_progress", "en_US", "done"]);
  }, 120_000);

  it("a collision is a render failure that names the enum, and the emitter never runs", async () => {
    const emitFiles = vi.fn<EmitFiles>();
    const r = await createArtifactRenderer({ db: fakeDb() as never, emitFiles }).render(subject("vClash"), "avro");
    expect(r.success).toBe(false);
    expect(!r.success && r.error.code).toBe("ARTIFACT_RENDER_FAILED");
    expect(!r.success && r.error.message).toContain('Avro enum Clash_kind: the values "a-b" and "a b" would all be published as the symbol "a_b"');
    expect(!r.success && r.error.details).toEqual({ cause: "AVRO_SYMBOL_COLLISION" });
    expect(emitFiles).not.toHaveBeenCalled();
  });

  it("a payload with nothing to rename carries no notes key at all", async () => {
    const emitFiles = vi.fn<EmitFiles>(async () => ({ success: true, data: [{ relativePath: "Order.avsc.json", content: '{"type":"record","name":"Order","fields":[]}' }] }));
    const r = await createArtifactRenderer({ db: fakeDb() as never, emitFiles }).render(subject("vOrder"), "avro");
    expect(r.success && "notes" in r.data).toBe(false);
  });
});
