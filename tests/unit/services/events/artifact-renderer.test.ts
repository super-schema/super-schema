import { describe, it, expect, vi } from "vitest";
vi.mock("@/lib/db", () => ({ prisma: {} }));
import { createArtifactRenderer, type EmitFiles } from "@/services/events/artifact-renderer";
import { Semaphore } from "@/lib/concurrency/semaphore";

const TENANT = "tenant-acme";

type V = { id: string; entityId: string; major: number; minor: number; resolvedSource: string; fieldSnapshot: unknown; entity: { name: string } };
const versions: Record<string, V> = {
  vOrder: {
    id: "vOrder", entityId: "eOrder", major: 2, minor: 1, entity: { name: "Order" },
    resolvedSource: "namespace Custom;\nmodel Order {\n  id: string;\n  address: Address;\n}\n",
    fieldSnapshot: [{ name: "id", fieldNumber: 1 }, { name: "address", fieldNumber: 2 }],
  },
  vAddress: { id: "vAddress", entityId: "eAddress", major: 1, minor: 0, entity: { name: "Address" }, resolvedSource: "model Address {\n  street: string;\n}\n", fieldSnapshot: [{ name: "street", fieldNumber: null }] },
  vAddress2: { id: "vAddress2", entityId: "eAddress", major: 2, minor: 0, entity: { name: "Address" }, resolvedSource: "model Address {\n  line1: string;\n}\n", fieldSnapshot: [] },
  vCustomer: { id: "vCustomer", entityId: "eCustomer", major: 1, minor: 0, entity: { name: "Customer" }, resolvedSource: "model Customer {\n  home: Address;\n}\n", fieldSnapshot: [] },
  vBroken: { id: "vBroken", entityId: "eBroken", major: 1, minor: 0, entity: { name: "Broken" }, resolvedSource: "model Broken {\n  id: string;\n}\n", fieldSnapshot: [] },
};
const fieldPins: Record<string, string[]> = { vOrder: ["vAddress"], vCustomer: ["vAddress2"], vMixed: [] };

function fakeDb(extraPins: Record<string, string[]> = {}) {
  const pins = { ...fieldPins, ...extraPins };
  return {
    entityVersion: { findUnique: vi.fn(async ({ where }: { where: { id: string } }) => versions[where.id] ?? null) },
    schemaReference: { findMany: vi.fn(async ({ where }: { where: { fromId: string } }) => (pins[where.fromId] ?? []).map((toId) => ({ toId }))) },
    entity: { findUnique: vi.fn(async () => ({ tenant: { slug: "acme" }, domain: { slug: "payments" }, product: { slug: "checkout" } })) },
  };
}

const order = { kind: "version" as const, entityVersionId: "vOrder", tenantId: TENANT };

describe("artifact renderer", () => {
  it("renders Avro from the combined program and picks <Root>.avsc.json", async () => {
    const emitFiles = vi.fn<EmitFiles>(async () => ({
      success: true,
      data: [
        { relativePath: "Address.avsc.json", content: '{"type":"record","name":"Address","fields":[]}' },
        { relativePath: "Order.avsc.json", content: '{"type":"record","name":"Order","fields":[]}' },
      ],
    }));
    const renderer = createArtifactRenderer({ db: fakeDb() as never, emitFiles });
    const r = await renderer.render(order, "avro");
    expect(r).toEqual({ success: true, data: { artifact: { format: "avro", schema: { type: "record", name: "Order", fields: [] } }, warnings: [] } });
    const [pkg, source, options] = emitFiles.mock.calls[0];
    expect(pkg).toBe("@typespec/avro");
    expect(options).toEqual({});
    expect(source).toContain("namespace Acme.Payments.Checkout;");
    expect(source).not.toContain("namespace Custom;");
    expect(source.indexOf("model Order")).toBeLessThan(source.indexOf("model Address"));
  });

  it("also finds the root's file when the emitter qualified every file name by namespace (closure emission's `qualified-file-names`)", async () => {
    const qualified = (names: string[]): EmitFiles => async () => ({
      success: true,
      data: names.map((relativePath) => ({ relativePath, content: `{"type":"record","name":"${relativePath.split(".").slice(-3, -2)[0]}","fields":[]}` })),
    });
    const picked = await createArtifactRenderer({ db: fakeDb() as never, emitFiles: qualified(["com.acme.address.Address.avsc.json", "com.acme.order.Order.avsc.json"]) }).render(order, "avro");
    expect(picked).toEqual({ success: true, data: { artifact: { format: "avro", schema: { type: "record", name: "Order", fields: [] } }, warnings: [] } });
    // two namespaces that each hold an `Order`: no way to tell which is the root, so no guess
    const ambiguous = await createArtifactRenderer({ db: fakeDb() as never, emitFiles: qualified(["com.a.Order.avsc.json", "com.b.Order.avsc.json"]) }).render(order, "avro");
    expect(ambiguous.success).toBe(false);
  });

  it("caches immutable versions (one emit for two renders) and does not cache failures", async () => {
    const emitFiles = vi.fn<EmitFiles>(async () => ({ success: true, data: [{ relativePath: "Order.avsc.json", content: '{"type":"record","name":"Order"}' }] }));
    const renderer = createArtifactRenderer({ db: fakeDb() as never, emitFiles });
    await renderer.render(order, "avro");
    await renderer.render(order, "avro");
    expect(emitFiles).toHaveBeenCalledTimes(1);

    const failing = vi.fn<EmitFiles>(async () => ({ success: false, error: { code: "EMITTER_FAILED", message: "boom" } }));
    const r2 = createArtifactRenderer({ db: fakeDb() as never, emitFiles: failing });
    const first = await r2.render({ kind: "version", entityVersionId: "vBroken", tenantId: TENANT }, "avro");
    expect(!first.success && first.error).toEqual({ code: "ARTIFACT_RENDER_FAILED", message: "Broken@1.0 → avro: boom", details: { cause: "EMITTER_FAILED" } });
    await r2.render({ kind: "version", entityVersionId: "vBroken", tenantId: TENANT }, "avro");
    expect(failing).toHaveBeenCalledTimes(2);
  });

  it("renders JSON Schema once as a 2020-12 bundle and inlines it", async () => {
    const bundle = {
      $id: "Order",
      $defs: {
        Order: { $id: "Order.json", type: "object", properties: { address: { $ref: "Address.json" } } },
        Address: { $id: "Address.json", type: "object", properties: { street: { type: "string" } } },
      },
    };
    const emitFiles = vi.fn<EmitFiles>(async () => ({ success: true, data: [{ relativePath: "Order", content: JSON.stringify(bundle) }] }));
    const r = await createArtifactRenderer({ db: fakeDb() as never, emitFiles }).render(order, "json-schema");
    expect(r.success && r.data.artifact).toMatchObject({
      format: "json-schema", dialect: "2020-12",
      schema: { type: "object", properties: { address: { $ref: "#/$defs/Address" } }, $defs: { Address: { type: "object" } } },
    });
    expect(emitFiles.mock.calls[0][0]).toBe("@typespec/json-schema");
    expect(emitFiles.mock.calls[0][1]).toContain('import "@typespec/json-schema";');
    expect(emitFiles.mock.calls[0][2]).toEqual({ emitAllModels: true, "file-type": "json", bundleId: "Order" });
  });

  it("renders protobuf with @package, field numbers from every version, and the root message first", async () => {
    const proto = 'syntax = "proto3";\n\nmessage Address {\n  string street = 1;\n}\n\nmessage Order {\n  string id = 1;\n  Address address = 2;\n}\n';
    const emitFiles = vi.fn<EmitFiles>(async () => ({ success: true, data: [{ relativePath: "main.proto", content: proto }] }));
    const r = await createArtifactRenderer({ db: fakeDb() as never, emitFiles }).render(order, "protobuf");
    const text = r.success ? (r.data.artifact.schema as string) : "";
    expect(text.indexOf("// @RootNode\nmessage Order")).toBeGreaterThan(-1);
    expect(text.indexOf("message Order")).toBeLessThan(text.indexOf("message Address"));
    const source = emitFiles.mock.calls[0][1];
    expect(source).toContain("@package\nnamespace Acme.Payments.Checkout;");
    expect(source).toContain("@field(1)\n  id: string;");
    expect(source).toContain("@field(2)\n  address: Address;");
    expect(source).toContain("@field(1)\n  street: string;");
  });

  it("refuses two versions of one entity in a single program", async () => {
    const renderer = createArtifactRenderer({ db: fakeDb({ vOrder: ["vAddress", "vCustomer"] }) as never, emitFiles: vi.fn() });
    const r = await renderer.render(order, "avro");
    expect(!r.success && r.error.code).toBe("CONFLICTING_PINS");
  });
});

describe("artifact renderer — legacy @tag lines and draft subjects", () => {
  const legacy: V = {
    id: "vLegacy", entityId: "eLegacy", major: 1, minor: 0, entity: { name: "Legacy" }, fieldSnapshot: [],
    resolvedSource: '@tag("sales")\nmodel Legacy {\n  id: string;\n  @tag("classification:PII")\n  ssn: string;\n  @doc("mentions @tag(x) inline")\n  note: string;\n}\n',
  };
  const avroFiles = [{ relativePath: "Legacy.avsc.json", content: '{"type":"record","name":"Legacy"}' }];

  it("upgrades legacy @tag lines (frozen pre-Track-F resolvedSource) and projects the overlay away before compiling, in every format", async () => {
    for (const format of ["avro", "json-schema", "protobuf"] as const) {
      const emitFiles = vi.fn<EmitFiles>(async () => ({
        success: true,
        data: format === "json-schema"
          ? [{ relativePath: "Legacy", content: JSON.stringify({ $id: "Legacy", $defs: { Legacy: { $id: "Legacy.json", type: "object" } } }) }]
          : format === "protobuf"
            ? [{ relativePath: "main.proto", content: "message Legacy {\n  string id = 1;\n}\n" }]
            : avroFiles,
      }));
      const db = { ...fakeDb(), entityVersion: { findUnique: vi.fn(async () => legacy) } };
      const r = await createArtifactRenderer({ db: db as never, emitFiles }).render({ kind: "version", entityVersionId: "vLegacy", tenantId: TENANT }, format);
      expect(r.success).toBe(true);
      const source = emitFiles.mock.calls[0][1];
      expect(source).not.toMatch(/^\s*@tag\(/m);
      expect(source).not.toMatch(/Enterprise|x-tags|x-classification|typespec-enterprise|@typespec\/openapi/);
      expect(source).toContain("model Legacy {");
      expect(source).toContain('@doc("mentions @tag(x) inline")');
    }
  });

  it("compiles frozen Story 16.6 sources without the governance overlay (decorators and library imports), in every format", async () => {
    const governed: V = {
      id: "vGoverned", entityId: "eGoverned", major: 1, minor: 0, entity: { name: "Governed" },
      fieldSnapshot: [{ name: "id", fieldNumber: 1 }, { name: "email", fieldNumber: 2 }],
      resolvedSource: [
        'import "@superschema/typespec-enterprise";',
        'import "@typespec/openapi";',
        "",
        '@TypeSpec.OpenAPI.extension("x-tags", #["sales"])',
        "model Governed {",
        "  id: string;",
        "  @Enterprise.dataClassification(Enterprise.DataClassification.PII)",
        "  email: string;",
        "}",
        "",
      ].join("\n"),
    };
    for (const format of ["avro", "json-schema", "protobuf"] as const) {
      const emitFiles = vi.fn<EmitFiles>(async () => ({
        success: true,
        data: format === "json-schema"
          ? [{ relativePath: "Governed", content: JSON.stringify({ $id: "Governed", $defs: { Governed: { $id: "Governed.json", type: "object" } } }) }]
          : format === "protobuf"
            ? [{ relativePath: "main.proto", content: "message Governed {\n  string id = 1;\n}\n" }]
            : [{ relativePath: "Governed.avsc.json", content: '{"type":"record","name":"Governed"}' }],
      }));
      const db = { ...fakeDb(), entityVersion: { findUnique: vi.fn(async () => governed) } };
      const r = await createArtifactRenderer({ db: db as never, emitFiles }).render({ kind: "version", entityVersionId: "vGoverned", tenantId: TENANT }, format);
      expect(r.success).toBe(true);
      const source = emitFiles.mock.calls[0][1];
      expect(source).not.toMatch(/Enterprise|x-tags|typespec-enterprise|@typespec\/openapi/);
      expect(source).toContain("model Governed {");
      if (format === "protobuf") expect(source).toContain("@field(2)\n  email: string;");
    }
  });

  type DraftField = { id: string; name: string; fieldNumber: number | null; decorators: Record<string, unknown> };
  const idRef: DraftField = { id: "f1", name: "address", fieldNumber: null, decorators: { referencedEntityId: "eAddress", referencedEntityName: "Address" } };
  const nameOnlyRef: DraftField = { id: "f1", name: "address", fieldNumber: null, decorators: { referencedEntityName: "Address" } };
  const placement = { tenantId: "t1", domainId: "d1", productId: "p1" };

  function draftDb(refLatestVersionId: string | null, fields: DraftField[] = [idRef], lineEntities: Array<{ id: string; name: string } & typeof placement> = [{ id: "eAddress", name: "Address", ...placement }]) {
    const draft = {
      id: "eDraft", name: "Draft", metadata: {}, ...placement,
      typespecSource: '@tag("x")\nmodel Draft {\n  address: Address;\n}\n',
      fields,
    };
    const base = fakeDb();
    return {
      ...base,
      entity: {
        findUnique: vi.fn(async ({ select }: { select: Record<string, unknown> }) =>
          "typespecSource" in select ? draft : { tenant: { slug: "acme" }, domain: { slug: "payments" }, product: { slug: "checkout" } }),
        findMany: vi.fn(async ({ where }: { where: { id?: { in: string[] } } }) =>
          where.id
            ? [{ id: "eAddress", name: "Address", latestVersionId: refLatestVersionId }].filter((e) => where.id?.in.includes(e.id))
            : lineEntities),
      },
    };
  }

  it("renders a draft against the latest published version of every entity it references, and never caches it", async () => {
    const emitFiles = vi.fn<EmitFiles>(async () => ({ success: true, data: [{ relativePath: "Draft.avsc.json", content: '{"type":"record","name":"Draft"}' }] }));
    const renderer = createArtifactRenderer({ db: draftDb("vAddress") as never, emitFiles });
    const subject = { kind: "draft" as const, entityId: "eDraft", tenantId: TENANT };
    const r = await renderer.render(subject, "avro");
    expect(r.success && r.data.artifact.schema).toMatchObject({ name: "Draft" });
    const source = emitFiles.mock.calls[0][1];
    expect(source).toContain("model Draft {");
    expect(source).toContain("model Address {");
    expect(source).not.toMatch(/^\s*@tag\(/m);
    await renderer.render(subject, "avro");
    expect(emitFiles).toHaveBeenCalledTimes(2);
  });

  it("names the unpublished entity when a draft references one", async () => {
    const r = await createArtifactRenderer({ db: draftDb(null) as never, emitFiles: vi.fn() }).render({ kind: "draft", entityId: "eDraft", tenantId: TENANT }, "avro");
    expect(!r.success && r.error.code).toBe("UNPUBLISHED_REFERENCE");
    expect(!r.success && r.error.message).toContain("Address");
  });

  it("resolves a draft reference stored by name only (referencedEntityName) in the entity's line, like publish does", async () => {
    const emitFiles = vi.fn<EmitFiles>(async () => ({ success: true, data: [{ relativePath: "Draft.avsc.json", content: '{"type":"record","name":"Draft"}' }] }));
    const db = draftDb("vAddress", [nameOnlyRef]);
    const r = await createArtifactRenderer({ db: db as never, emitFiles }).render({ kind: "draft", entityId: "eDraft", tenantId: TENANT }, "avro");
    expect(r.success).toBe(true);
    expect(emitFiles.mock.calls[0][1]).toContain("model Address {");
    // the line lookup is scoped to the entity's tenant / domain / product, exactly as publish does it
    expect(db.entity.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { tenantId: "t1", OR: [{ domainId: null }, { domainId: "d1", productId: null }, { productId: "p1" }] },
    }));
  });

  it("fails a draft whose by-name reference matches no entity in its line with UNRESOLVED_REFERENCE (not a raw tsp error)", async () => {
    const emitFiles = vi.fn<EmitFiles>();
    const db = draftDb("vAddress", [nameOnlyRef], []);
    const r = await createArtifactRenderer({ db: db as never, emitFiles }).render({ kind: "draft", entityId: "eDraft", tenantId: TENANT }, "avro");
    expect(!r.success && r.error.code).toBe("UNRESOLVED_REFERENCE");
    expect(!r.success && r.error.message).toContain("Address");
    expect(!r.success && r.error.details).toEqual({ names: ["Address"] });
    expect(emitFiles).not.toHaveBeenCalled();
  });

  it("fails a draft that references an entity id that no longer exists with UNRESOLVED_REFERENCE", async () => {
    const gone: DraftField = { id: "f1", name: "address", fieldNumber: null, decorators: { referencedEntityId: "eGone" } };
    const r = await createArtifactRenderer({ db: draftDb("vAddress", [gone]) as never, emitFiles: vi.fn() }).render({ kind: "draft", entityId: "eDraft", tenantId: TENANT }, "avro");
    expect(!r.success && r.error.code).toBe("UNRESOLVED_REFERENCE");
    expect(!r.success && r.error.message).toContain("eGone");
  });

  // Final review B-I4: the draft path used `entity.typespecSource` as-is, ignoring `metadata.sourceStale` (publish regenerates).
  describe("a draft whose stored source is flagged stale (B-I4)", () => {
    const STORED = "model Order {\n  id: string;\n}\n";
    const idOnlyField = (name: string) => ({
      id: `f-${name}`, name, type: "string", precision: null, scale: null, nullable: false, isKey: false, fieldNumber: null,
      description: null, classification: null, aliases: [], decorators: {}, sortOrder: 0,
    });

    /** An entity whose stored source says `id` while its field rows now say `code`; `metadata` decides whether that is flagged (read per call). */
    function staleDb(metadata: Record<string, unknown> | (() => Record<string, unknown>), typespecSource: string | null = STORED) {
      const fields = [idOnlyField("code")];
      const currentMetadata = () => (typeof metadata === "function" ? metadata() : metadata);
      const entityRow = () => ({ id: "eDraft", name: "Order", description: null, status: "DRAFT", version: 1, domainId: "d1", metadata: currentMetadata(), domain: null });
      return {
        ...fakeDb(),
        entity: {
          findUnique: vi.fn(async ({ select }: { select?: Record<string, unknown> }) => {
            if (!select) return entityRow(); // loadEntityModel (include)
            if ("typespecSource" in select) return { ...entityRow(), ...placement, typespecSource, fields: fields.map((f) => ({ id: f.id, name: f.name, fieldNumber: f.fieldNumber, decorators: f.decorators })) };
            return { tenant: { slug: "acme" }, domain: { slug: "payments" }, product: { slug: "checkout" } };
          }),
          findMany: vi.fn(async () => []),
        },
        field: { findMany: vi.fn(async () => fields) },
      };
    }
    const orderFiles: EmitFiles = async () => ({ success: true, data: [{ relativePath: "Order.avsc.json", content: '{"type":"record","name":"Order"}' }] });
    const subject = { kind: "draft" as const, entityId: "eDraft", tenantId: TENANT };

    it("regenerates the source from the field rows (the NEW field, not the stored one)", async () => {
      const emitFiles = vi.fn<EmitFiles>(orderFiles);
      const db = staleDb({ sourceStale: true });
      const r = await createArtifactRenderer({ db: db as never, emitFiles }).render(subject, "avro");
      expect(r.success).toBe(true);
      const source = emitFiles.mock.calls[0][1];
      expect(source).toContain("model Order {");
      expect(source).toMatch(/\bcode: string;/);
      expect(source).not.toMatch(/\bid: string;/);
      expect(db.field.findMany).toHaveBeenCalled(); // loadEntityModel ran
    });

    it("keeps a fresh (unflagged) stored source as-is, and still regenerates when there is no stored source", async () => {
      const fresh = vi.fn<EmitFiles>(orderFiles);
      const freshDb = staleDb({});
      await createArtifactRenderer({ db: freshDb as never, emitFiles: fresh }).render(subject, "avro");
      expect(fresh.mock.calls[0][1]).toMatch(/\bid: string;/);
      expect(fresh.mock.calls[0][1]).not.toMatch(/\bcode: string;/);
      expect(freshDb.field.findMany).not.toHaveBeenCalled();

      const none = vi.fn<EmitFiles>(orderFiles);
      await createArtifactRenderer({ db: staleDb({}, null) as never, emitFiles: none }).render(subject, "avro");
      expect(none.mock.calls[0][1]).toMatch(/\bcode: string;/);
    });

    it("never caches the draft render: an edit between two renders shows up in the second", async () => {
      const emitFiles = vi.fn<EmitFiles>(orderFiles);
      let metadata: Record<string, unknown> = {};
      const renderer = createArtifactRenderer({ db: staleDb(() => metadata) as never, emitFiles });
      await renderer.render(subject, "avro");
      metadata = { sourceStale: true };
      await renderer.render(subject, "avro");
      expect(emitFiles).toHaveBeenCalledTimes(2);
      expect(emitFiles.mock.calls[0][1]).toMatch(/\bid: string;/);
      expect(emitFiles.mock.calls[1][1]).toMatch(/\bcode: string;/);
    });
  });
});

/** An Avro emitter fake that writes `<Root>.avsc.json` for the first model of the program it is given. */
const avroOk: EmitFiles = async (_pkg, source) => {
  const root = /model (\w+)/.exec(source)?.[1] ?? "Unknown";
  return { success: true, data: [{ relativePath: `${root}.avsc.json`, content: JSON.stringify({ type: "record", name: root }) }] };
};

describe("artifact renderer — failures never throw and are never cached", () => {
  it("turns a throwing loader into ARTIFACT_RENDER_FAILED, does not cache it, and retries on the next call", async () => {
    let broken = true;
    const db = fakeDb();
    const original = db.schemaReference.findMany;
    db.schemaReference.findMany = vi.fn(async (args: { where: { fromId: string } }) => {
      if (broken) throw new Error("connection reset");
      return original(args);
    });
    const emitFiles = vi.fn<EmitFiles>(avroOk);
    const renderer = createArtifactRenderer({ db: db as never, emitFiles });
    const first = await renderer.render(order, "avro");
    expect(!first.success && first.error.code).toBe("ARTIFACT_RENDER_FAILED");
    expect(!first.success && first.error.message).toContain("connection reset");
    expect(emitFiles).not.toHaveBeenCalled();
    broken = false;
    const second = await renderer.render(order, "avro");
    expect(second.success).toBe(true);
    expect(emitFiles).toHaveBeenCalledTimes(1);
  });

  it("turns a throwing / rejecting emitter into ARTIFACT_RENDER_FAILED (no cached rejection) and retries", async () => {
    const emitFiles = vi.fn<EmitFiles>()
      .mockRejectedValueOnce(new Error("spawn EAGAIN"))
      .mockImplementationOnce(() => { throw new Error("sync boom"); })
      .mockImplementation(avroOk);
    const renderer = createArtifactRenderer({ db: fakeDb() as never, emitFiles });
    for (const message of ["spawn EAGAIN", "sync boom"]) {
      const r = await renderer.render(order, "avro");
      expect(!r.success && r.error.code).toBe("ARTIFACT_RENDER_FAILED");
      expect(!r.success && r.error.message).toContain(message);
    }
    expect((await renderer.render(order, "avro")).success).toBe(true);
    expect(emitFiles).toHaveBeenCalledTimes(3);
  });

  it("turns a throwing cache-key lookup into a result too", async () => {
    const db = { ...fakeDb(), entityVersion: { findUnique: vi.fn(async () => { throw new Error("db down"); }) } };
    const r = await createArtifactRenderer({ db: db as never, emitFiles: vi.fn() }).render(order, "avro");
    expect(!r.success && r.error.code).toBe("ARTIFACT_RENDER_FAILED");
    expect(!r.success && r.error.message).toContain("db down");
  });

  it("maps combine failures to ARTIFACT_RENDER_FAILED carrying the cause and the conflict details", async () => {
    const conflicting = { ...fakeDb(), entityVersion: { findUnique: vi.fn(async ({ where }: { where: { id: string } }) => ({
      ...versions[where.id],
      resolvedSource: where.id === "vOrder" ? "enum Status { Active }\nmodel Order { s: Status; a: Address; }\n" : "enum Status { Active, Retired }\nmodel Address { s: Status; }\n",
    })) } };
    const emitFiles = vi.fn<EmitFiles>();
    const r = await createArtifactRenderer({ db: conflicting as never, emitFiles }).render(order, "avro");
    expect(!r.success && r.error.code).toBe("ARTIFACT_RENDER_FAILED");
    expect(!r.success && r.error.message).toContain("Order@2.1 → avro:");
    expect(!r.success && r.error.details).toMatchObject({ cause: "TYPESPEC_DECLARATION_CONFLICT", name: "Status" });
    expect(emitFiles).not.toHaveBeenCalled();
  });

  it("refuses a source that imports anything but @typespec/* or the governance library", async () => {
    const evil = { ...fakeDb(), entityVersion: { findUnique: vi.fn(async ({ where }: { where: { id: string } }) => ({
      ...versions[where.id], resolvedSource: 'import "./steal.js";\nmodel Order { id: string; address: Address; }\n',
    })) } };
    const emitFiles = vi.fn<EmitFiles>();
    const r = await createArtifactRenderer({ db: evil as never, emitFiles }).render(order, "avro");
    expect(!r.success && r.error.code).toBe("ARTIFACT_RENDER_FAILED");
    expect(!r.success && r.error.details).toMatchObject({ cause: "TYPESPEC_IMPORT_NOT_ALLOWED", specifier: "./steal.js" });
    expect(emitFiles).not.toHaveBeenCalled();
  });

  it("refuses to guess the root among several models when none is named after the entity", async () => {
    const ambiguous = { ...fakeDb(), entityVersion: { findUnique: vi.fn(async ({ where }: { where: { id: string } }) => ({
      ...versions[where.id], resolvedSource: "model Line { a: string; }\nmodel Other { b: string; }\n",
    })) } };
    const r = await createArtifactRenderer({ db: ambiguous as never, emitFiles: vi.fn() }).render(order, "avro");
    expect(!r.success && r.error.code).toBe("ROOT_MODEL_NOT_FOUND");
  });
});

describe("artifact renderer — timeout and concurrency", () => {
  const deferred = () => {
    let resolve!: (v: Awaited<ReturnType<EmitFiles>>) => void;
    const promise = new Promise<Awaited<ReturnType<EmitFiles>>>((r) => { resolve = r; });
    return { promise, resolve };
  };
  const tick = () => new Promise<void>((r) => setTimeout(r, 0));
  const ofVersion = (id: string) => ({ kind: "version" as const, entityVersionId: id, tenantId: TENANT });

  it("passes the timeout to the emitter and fails a hung emitter with EMITTER_TIMEOUT, freeing its slot", async () => {
    vi.useFakeTimers();
    try {
      const seen: Array<number | undefined> = [];
      // The hung emitter reports its start (as a compiler run does when it gets its slot), which is when its timeout starts.
      const emitFiles = vi.fn<EmitFiles>()
        .mockImplementationOnce((_p, _s, _o, run) => { seen.push(run?.timeoutMs); run?.onStart?.(); return new Promise(() => undefined); })
        .mockImplementation(async (p, src, o, run) => { seen.push(run?.timeoutMs); return avroOk(p, src, o); });
      const renderer = createArtifactRenderer({ db: fakeDb() as never, emitFiles, concurrency: 1, emitTimeoutMs: 1_000 });
      const hung = renderer.render(ofVersion("vOrder"), "avro");
      await vi.advanceTimersByTimeAsync(1_000 + 5_000);
      const r = await hung;
      expect(!r.success && r.error.code).toBe("ARTIFACT_RENDER_FAILED");
      expect(!r.success && r.error.details).toEqual({ cause: "EMITTER_TIMEOUT" });
      // concurrency is 1: the next render only runs because the timed-out one released the slot
      const next = await renderer.render(ofVersion("vBroken"), "avro");
      expect(next.success).toBe(true);
      expect(seen).toEqual([1_000, 1_000]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not time a render out for its wait in the compiler's queue: the timeout covers the run, from the moment the run starts", async () => {
    vi.useFakeTimers();
    try {
      // One compiler slot, as the real runs have: the second render waits behind the first one's whole run.
      const compiler = new Semaphore(1);
      const finishers: Array<() => void> = [];
      const emitFiles: EmitFiles = (pkg, source, options, run) =>
        compiler.run(
          () =>
            new Promise<Awaited<ReturnType<EmitFiles>>>((resolve) => {
              run?.onStart?.();
              finishers.push(() => void avroOk(pkg, source, options, run).then(resolve));
            })
        );
      const renderer = createArtifactRenderer({ db: fakeDb() as never, emitFiles, concurrency: 2, emitTimeoutMs: 100_000 });
      const first = renderer.render(ofVersion("vAddress"), "avro");
      const second = renderer.render(ofVersion("vBroken"), "avro");
      await vi.advanceTimersByTimeAsync(100_000);
      // the first run took 100 s of its own; the second has waited all that time and must not be timed out for it
      finishers.shift()!();
      expect((await first).success).toBe(true);
      await vi.advanceTimersByTimeAsync(0);
      expect(finishers).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(100_000);
      finishers.shift()!();
      expect((await second).success).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("never runs more than `concurrency` emitters at once, and a rejecting emitter releases its slot", async () => {
    const ids = ["vOrder", "vAddress", "vCustomer", "vBroken"];
    const roots: Record<string, string> = { vOrder: "Order", vAddress: "Address", vCustomer: "Customer", vBroken: "Broken" };
    const gates = new Map(Object.values(roots).map((root) => [root, deferred()]));
    const started: string[] = [];
    let active = 0;
    let peak = 0;
    const emitFiles = vi.fn<EmitFiles>(async (_pkg, source) => {
      const root = /model (\w+)/.exec(source)?.[1] as string;
      started.push(root);
      active++;
      peak = Math.max(peak, active);
      try {
        return await (gates.get(root) as ReturnType<typeof deferred>).promise;
      } finally {
        active--;
      }
    });
    const renderer = createArtifactRenderer({ db: fakeDb() as never, emitFiles, concurrency: 2 });
    const results = ids.map((id) => renderer.render(ofVersion(id), "avro"));
    await tick();
    expect(started).toHaveLength(2);
    expect(active).toBe(2);
    (gates.get(started[0]) as ReturnType<typeof deferred>).resolve({ success: false, error: { code: "EMITTER_FAILED", message: "first failed" } });
    await tick();
    expect(started).toHaveLength(3); // the failed render handed its slot to the next one
    for (const root of Object.values(roots)) {
      (gates.get(root) as ReturnType<typeof deferred>).resolve({ success: true, data: [{ relativePath: `${root}.avsc.json`, content: "{}" }] });
    }
    const settled = await Promise.all(results);
    expect(peak).toBe(2);
    expect(started).toHaveLength(4);
    expect(settled.filter((r) => !r.success)).toHaveLength(1);
    expect(settled.filter((r) => r.success)).toHaveLength(3);
  });

  it("releases the slot when an emitter throws", async () => {
    const emitFiles = vi.fn<EmitFiles>()
      .mockRejectedValueOnce(new Error("boom"))
      .mockImplementation(avroOk);
    const renderer = createArtifactRenderer({ db: fakeDb() as never, emitFiles, concurrency: 1 });
    const settled = await Promise.all([renderer.render(ofVersion("vOrder"), "avro"), renderer.render(ofVersion("vBroken"), "avro")]);
    expect(settled.map((r) => r.success).sort()).toEqual([false, true]);
    expect(emitFiles).toHaveBeenCalledTimes(2);
  });
});

describe("artifact renderer — cache", () => {
  const ofVersion = (id: string) => ({ kind: "version" as const, entityVersionId: id, tenantId: TENANT });

  it("evicts the least recently used entry beyond maxEntries", async () => {
    const emitFiles = vi.fn<EmitFiles>(avroOk);
    const renderer = createArtifactRenderer({ db: fakeDb() as never, emitFiles, maxEntries: 2 });
    await renderer.render(ofVersion("vOrder"), "avro");
    await renderer.render(ofVersion("vAddress"), "avro");
    await renderer.render(ofVersion("vOrder"), "avro"); // hit: vOrder becomes most recent
    expect(emitFiles).toHaveBeenCalledTimes(2);
    await renderer.render(ofVersion("vCustomer"), "avro"); // evicts vAddress
    expect(emitFiles).toHaveBeenCalledTimes(3);
    await renderer.render(ofVersion("vOrder"), "avro"); // still cached
    expect(emitFiles).toHaveBeenCalledTimes(3);
    await renderer.render(ofVersion("vAddress"), "avro"); // was evicted: re-rendered
    expect(emitFiles).toHaveBeenCalledTimes(4);
  });

  it("keys the cache by format too", async () => {
    const emitFiles = vi.fn<EmitFiles>(async (pkg) => ({
      success: true,
      data: pkg === "@typespec/json-schema"
        ? [{ relativePath: "Order", content: JSON.stringify({ $id: "Order", $defs: { Order: { $id: "Order.json", type: "object" } } }) }]
        : [{ relativePath: "Order.avsc.json", content: '{"type":"record","name":"Order"}' }],
    }));
    const renderer = createArtifactRenderer({ db: fakeDb() as never, emitFiles });
    await renderer.render(order, "avro");
    await renderer.render(order, "json-schema");
    expect(emitFiles).toHaveBeenCalledTimes(2);
  });

  it("misses the cache when the entity's level-derived namespace changed", async () => {
    const emitFiles = vi.fn<EmitFiles>(avroOk);
    const db = fakeDb();
    const renderer = createArtifactRenderer({ db: db as never, emitFiles });
    await renderer.render(order, "avro");
    await renderer.render(order, "avro");
    expect(emitFiles).toHaveBeenCalledTimes(1);
    db.entity.findUnique.mockImplementation(async () => ({ tenant: { slug: "acme" }, domain: { slug: "payments" }, product: { slug: "checkout-v2" } }));
    await renderer.render(order, "avro");
    expect(emitFiles).toHaveBeenCalledTimes(2);
    expect(emitFiles.mock.calls[1][1]).toContain("namespace Acme.Payments.CheckoutV2;");
  });
});

describe("artifact renderer — protobuf imports", () => {
  const render = async (proto: string) => {
    const emitFiles = vi.fn<EmitFiles>(async () => ({ success: true, data: [{ relativePath: "main.proto", content: proto }] }));
    const frozen = { ...fakeDb(), entityVersion: { findUnique: vi.fn(async () => ({
      id: "vExt", entityId: "eExt", major: 1, minor: 0, entity: { name: "Ext" }, fieldSnapshot: [{ name: "other", fieldNumber: 1 }],
      resolvedSource: 'model Ext {\n  other: TypeSpec.Protobuf.Extern<"vendor/other.proto", "vendor.Other">;\n}\n',
    })) } };
    const r = await createArtifactRenderer({ db: frozen as never, emitFiles }).render({ kind: "version", entityVersionId: "vExt", tenantId: TENANT }, "protobuf");
    return { r, source: emitFiles.mock.calls[0]?.[1] ?? "" };
  };

  it("rejects an .proto whose imports are not well-known / validation files (hand-edited @Protobuf.Extern)", async () => {
    const { r, source } = await render('syntax = "proto3";\n\nimport "vendor/other.proto";\nimport "google/protobuf/timestamp.proto";\nimport "../up.proto";\n\nmessage Ext {\n  vendor.Other other = 1;\n}\n');
    expect(source).toContain("TypeSpec.Protobuf.Extern<");
    expect(!r.success && r.error.code).toBe("PROTO_NOT_SELF_CONTAINED");
    expect(!r.success && r.error.details).toEqual({ imports: ["vendor/other.proto", "../up.proto"] });
  });

  it("accepts google/protobuf/*, google/type/*, validate/validate.proto and buf/validate/validate.proto", async () => {
    const { r } = await render(
      'syntax = "proto3";\n\nimport "google/protobuf/timestamp.proto";\nimport public "google/type/date.proto";\nimport "validate/validate.proto";\nimport "buf/validate/validate.proto";\n\nmessage Ext {\n  string other = 1;\n}\n'
    );
    expect(r.success).toBe(true);
  });
});
