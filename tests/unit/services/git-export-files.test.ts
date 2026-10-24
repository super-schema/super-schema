import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock Prisma (the service entry points at the bottom read entities and the Git config)
// ---------------------------------------------------------------------------
vi.mock("@/lib/db", () => ({
  prisma: {
    gitConfig: { findFirst: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
    gitPullRequest: { create: vi.fn() },
    entity: { findUnique: vi.fn(), findMany: vi.fn() },
    auditLog: { create: vi.fn().mockResolvedValue({ id: "audit-1" }) },
  },
}));

import {
  buildExportEntityDefinition,
  exportAll,
  exportEntity,
  generateExportFiles,
  pickExportVersion,
  planGitExport,
  sanitizeExportFilePath,
  targetFileExtension,
  type ExportEntityInput,
} from "@/services/git.service";
import { exportWithReview } from "@/services/git-pr.service";
import { prisma } from "@/lib/db";
import { getSchemaTargetCatalog } from "@/lib/schema-targets/catalog";
import type { ServiceContext } from "@/types/service-context";
import type { SchemaVersion, SchemaVersionsMap } from "@/types/schema-version";
import type { EmittedFile } from "@/lib/typespec-official/closure-emit";
import type { TargetOutput } from "@/lib/emission/emission.types";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const BASE = "schemas/";

function version(over: Partial<SchemaVersion> & { version: number }): SchemaVersion {
  return {
    status: "draft",
    output: "",
    generatedAt: "2026-10-24T00:00:00.000Z",
    entityVersion: 1,
    ...over,
  };
}

function file(target: string, path: string, content: string, entityId?: string): EmittedFile {
  return { path, content, target, ...(entityId ? { entityId } : {}) };
}

const paths = (files: { path: string }[]) => files.map((f) => f.path);

/** One entity's export input; `schemaVersions` is what `entity.metadata.schemaVersions` holds. */
function entityInput(over: Partial<ExportEntityInput> & { name: string }): ExportEntityInput {
  return { domainName: "Payments", productName: "Checkout", definition: { name: over.name }, ...over };
}

/** A published version of `target` with the given files (and the bundled output). */
function published(target: string, versionNumber: number, files: EmittedFile[]): SchemaVersion {
  return version({
    version: versionNumber,
    status: "published",
    files,
    output: files.map((f) => `===== ${f.path} =====\n${f.content}`).join("\n"),
  });
}

/** The five closure targets for an Order that references an Address, with realistic per-file paths. */
function closureVersions(): SchemaVersionsMap {
  return {
    "json-schema": [
      published("json-schema", 1, [
        file("json-schema", "Address.json", "{\"title\":\"Address\"}", "e-address"),
        file("json-schema", "Order.json", "{\"title\":\"Order\"}", "e-order"),
      ]),
    ],
    openapi3: [
      published("openapi3", 1, [
        file("openapi3", "Address.openapi.yaml", "openapi: 3.0.0 # address", "e-address"),
        file("openapi3", "Order.openapi.yaml", "openapi: 3.0.0 # order", "e-order"),
      ]),
    ],
    protobuf: [
      published("protobuf", 1, [
        file("protobuf", "payments/checkout/address/address.proto", "syntax = \"proto3\";", "e-address"),
        file("protobuf", "payments/checkout/order/order.proto", "syntax = \"proto3\";", "e-order"),
      ]),
    ],
    avro: [
      published("avro", 1, [
        file("avro", "acme.payments.Address.avsc.json", "{\"name\":\"Address\"}", "e-address"),
        file("avro", "acme.payments.Order.avsc.json", "{\"name\":\"Order\"}", "e-order"),
      ]),
    ],
    "java-pojo": [
      published("java-pojo", 1, [
        file("java-pojo", "com/acme/payments/Address.java", "class Address {}", "e-address"),
        file("java-pojo", "com/acme/payments/Order.java", "class Order {}", "e-order"),
      ]),
    ],
  };
}

const legacyOutput = (output: string): TargetOutput => ({
  name: "x",
  targetFormat: "x",
  output,
  isValid: true,
  validationStatus: "VALID",
  warnings: [],
  errors: [],
});

// ---------------------------------------------------------------------------
// generateExportFiles: one entity
// ---------------------------------------------------------------------------

describe("generateExportFiles reads schemaVersions", () => {
  it("writes every closure target with per-file paths under <domain>/<product>/<entity>/<target>/", () => {
    const warnings: string[] = [];
    const files = generateExportFiles(BASE, "Payments", "Order", { name: "Order" }, {}, {
      entityId: "e-order",
      productName: "Checkout",
      schemaVersions: closureVersions(),
      warnings,
    });

    const dir = "schemas/payments/checkout/order";
    // The root's own files and the referenced Address files: Address is not among the entities being exported here, so its files
    // sit under the root's folder (nothing lost).
    expect(paths(files).sort()).toEqual(
      [
        `${dir}/order.superschema.json`,
        `${dir}/avro/acme.payments.Address.avsc.json`,
        `${dir}/avro/acme.payments.Order.avsc.json`,
        `${dir}/java-pojo/com/acme/payments/Address.java`,
        `${dir}/java-pojo/com/acme/payments/Order.java`,
        `${dir}/json-schema/Address.json`,
        `${dir}/json-schema/Order.json`,
        `${dir}/openapi3/Address.openapi.yaml`,
        `${dir}/openapi3/Order.openapi.yaml`,
        `${dir}/protobuf/payments/checkout/address/address.proto`,
        `${dir}/protobuf/payments/checkout/order/order.proto`,
      ].sort()
    );
    expect(warnings).toEqual([]);
    // The SuperSchema JSON comes first; the content of each file is the stored content.
    expect(files[0].path).toBe(`${dir}/order.superschema.json`);
    expect(JSON.parse(files[0].content)).toEqual({ name: "Order" });
    expect(files.find((f) => f.path.endsWith("com/acme/payments/Order.java"))?.content).toBe("class Order {}");
  });

  it("covers every target of the catalog, not only bigquery, avro and openapi", () => {
    const schemaVersions: SchemaVersionsMap = {};
    for (const target of getSchemaTargetCatalog()) {
      schemaVersions[target.key] = [version({ version: 1, status: "published", output: `content of ${target.key}` })];
    }
    const files = generateExportFiles(BASE, "Payments", "Order", { name: "Order" }, {}, { entityId: "e-order", productName: "Checkout", schemaVersions });
    for (const target of getSchemaTargetCatalog()) {
      const written = files.filter((f) => f.path.startsWith(`schemas/payments/checkout/order/${target.key}/`));
      expect(written, target.key).toHaveLength(1);
      expect(written[0].content).toBe(`content of ${target.key}`);
    }
    // 1 SuperSchema JSON + one file per catalog target.
    expect(files).toHaveLength(1 + getSchemaTargetCatalog().length);
  });

  it("falls back to the output string, one file named by the target's extension convention, when a version has no files", () => {
    const files = generateExportFiles(BASE, "Payments", "Order Item", { name: "Order Item" }, {}, {
      entityId: "e1",
      productName: "Checkout",
      schemaVersions: {
        postgresql: [version({ version: 1, status: "published", output: "CREATE TABLE a (id int);" })],
        spanner: [version({ version: 1, status: "published", output: "CREATE TABLE a (id INT64) PRIMARY KEY (id);" })],
        bigquery: [version({ version: 2, status: "draft", output: "CREATE TABLE a (id INT64);" })],
        "json-schema": [version({ version: 1, status: "published", output: "{}", files: [] })],
      },
    });
    const dir = "schemas/payments/checkout/order-item";
    expect(paths(files).sort()).toEqual(
      [
        `${dir}/order-item.superschema.json`,
        `${dir}/postgresql/order-item.pg.sql`,
        `${dir}/spanner/order-item.spanner.sql`,
        `${dir}/bigquery/order-item.bq.sql`,
        `${dir}/json-schema/order-item.schema.json`,
      ].sort()
    );
    expect(files.find((f) => f.path.endsWith("order-item.pg.sql"))?.content).toBe("CREATE TABLE a (id int);");
  });

  it("uses the _tenant placeholder for a missing domain and a missing product", () => {
    const files = generateExportFiles(BASE, null, "Customer", { name: "Customer" }, {}, {
      entityId: "e1",
      productName: null,
      schemaVersions: { avro: [version({ version: 1, status: "published", output: "{}" })] },
    });
    expect(paths(files).sort()).toEqual(
      [
        "schemas/_tenant/_tenant/customer/customer.superschema.json",
        "schemas/_tenant/_tenant/customer/avro/customer.avro.json",
      ].sort()
    );
  });

  it("an entity without any generated output exports its SuperSchema JSON inside its own folder, product and all", () => {
    const files = generateExportFiles(BASE, "Payments", "Order", { name: "Order" }, {}, {
      entityId: "e1",
      productName: "Checkout",
      schemaVersions: {},
    });
    expect(paths(files)).toEqual(["schemas/payments/checkout/order/order.superschema.json"]);
  });

  it("two same-named entities in different products do not collide, in one bulk run or one at a time", () => {
    const a = entityInput({ name: "Order", entityId: "e-a", productName: "Checkout", schemaVersions: { avro: [published("avro", 1, [file("avro", "acme.Order.avsc.json", "A", "e-a")])] } });
    const b = entityInput({ name: "Order", entityId: "e-b", productName: "Billing", schemaVersions: { avro: [published("avro", 1, [file("avro", "acme.Order.avsc.json", "B", "e-b")])] } });
    const plan = planGitExport(BASE, [a, b]);
    expect(plan.warnings).toEqual([]);
    expect(paths(plan.files).sort()).toEqual(
      [
        "schemas/payments/checkout/order/order.superschema.json",
        "schemas/payments/checkout/order/avro/acme.Order.avsc.json",
        "schemas/payments/billing/order/order.superschema.json",
        "schemas/payments/billing/order/avro/acme.Order.avsc.json",
      ].sort()
    );
    expect(plan.files.find((f) => f.path === "schemas/payments/checkout/order/avro/acme.Order.avsc.json")?.content).toBe("A");
    expect(plan.files.find((f) => f.path === "schemas/payments/billing/order/avro/acme.Order.avsc.json")?.content).toBe("B");
    // One at a time they land in the same two folders.
    const oneA = generateExportFiles(BASE, "Payments", "Order", { name: "Order" }, {}, { entityId: "e-a", productName: "Checkout", schemaVersions: a.schemaVersions });
    expect(paths(oneA).every((p) => p.startsWith("schemas/payments/checkout/order/"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Which version of a target is exported
// ---------------------------------------------------------------------------

describe("pickExportVersion", () => {
  it("prefers the latest published version over a newer draft", () => {
    const picked = pickExportVersion([
      version({ version: 4, status: "draft" }),
      version({ version: 3, status: "published" }),
      version({ version: 2, status: "published" }),
    ]);
    expect(picked?.version).toBe(3);
  });

  it("counts a deployed version as published", () => {
    expect(pickExportVersion([version({ version: 5, status: "draft" }), version({ version: 2, status: "deployed" })])?.version).toBe(2);
  });

  it("falls back to the latest version when nothing is published", () => {
    expect(pickExportVersion([version({ version: 2, status: "draft" }), version({ version: 1, status: "draft" })])?.version).toBe(2);
  });

  it("decides by the version number, not by array position", () => {
    expect(pickExportVersion([version({ version: 1, status: "published" }), version({ version: 3, status: "published" }), version({ version: 2, status: "published" })])?.version).toBe(3);
  });

  it("reads no version from an empty or malformed list", () => {
    expect(pickExportVersion([])).toBeUndefined();
    expect(pickExportVersion([null as never, "x" as never])).toBeUndefined();
  });

  it("is what the export writes: the published files, not the newer draft's", () => {
    const files = generateExportFiles(BASE, "Payments", "Order", { name: "Order" }, {}, {
      entityId: "e1",
      productName: "Checkout",
      schemaVersions: {
        avro: [
          version({ version: 2, status: "draft", output: "DRAFT" }),
          version({ version: 1, status: "published", output: "PUBLISHED" }),
        ],
      },
    });
    expect(files.find((f) => f.path.includes("/avro/"))?.content).toBe("PUBLISHED");
  });
});

// ---------------------------------------------------------------------------
// Legacy emittedOutputs
// ---------------------------------------------------------------------------

describe("legacy entities that only have emittedOutputs", () => {
  it("export exactly as before, with or without the new options", () => {
    const outputs = { bigquery: legacyOutput("DDL"), avro: legacyOutput("AVRO"), openapi: legacyOutput("OPENAPI"), spanner: legacyOutput("never exported") };
    const expected = [
      "schemas/payments/transaction.superschema.json",
      "schemas/payments/transaction.bq.sql",
      "schemas/payments/transaction.avro.json",
      "schemas/payments/transaction.openapi.yaml",
    ];

    const plain = generateExportFiles("schemas/", "Payments", "Transaction", { name: "Transaction" }, outputs);
    expect(paths(plain)).toEqual(expected);

    const withOptions = generateExportFiles("schemas/", "Payments", "Transaction", { name: "Transaction" }, outputs, {
      entityId: "e1",
      productName: "Checkout",
      schemaVersions: {},
    });
    expect(withOptions).toEqual(plain);
    expect(plain.map((f) => f.content)).toEqual([JSON.stringify({ name: "Transaction" }, null, 2), "DDL", "AVRO", "OPENAPI"]);
  });

  it("a tenant-level legacy entity keeps its legacy folder name", () => {
    const files = generateExportFiles("schemas/", null, "Customer", { name: "Customer" }, { avro: legacyOutput("AVRO") });
    expect(paths(files)).toEqual(["schemas/enterprise/customer.superschema.json", "schemas/enterprise/customer.avro.json"]);
  });

  it("an entity with versions for some targets keeps its legacy output of a target that has none, in the new layout", () => {
    const files = generateExportFiles(BASE, "Payments", "Order", { name: "Order" }, { bigquery: legacyOutput("OLD BQ"), avro: legacyOutput("OLD AVRO") }, {
      entityId: "e1",
      productName: "Checkout",
      schemaVersions: { avro: [published("avro", 1, [file("avro", "acme.Order.avsc.json", "NEW AVRO", "e1")])] },
    });
    const dir = "schemas/payments/checkout/order";
    expect(paths(files).sort()).toEqual(
      [`${dir}/order.superschema.json`, `${dir}/avro/acme.Order.avsc.json`, `${dir}/bigquery/order.bq.sql`].sort()
    );
    expect(files.find((f) => f.path.endsWith("order.bq.sql"))?.content).toBe("OLD BQ");
    expect(files.some((f) => f.content === "OLD AVRO")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Hostile file paths
// ---------------------------------------------------------------------------

describe("sanitizeExportFilePath", () => {
  it.each([
    ["Order.json", "Order.json"],
    ["com/acme/payments/Order.java", "com/acme/payments/Order.java"],
    ["acme.payments.Order.avsc.json", "acme.payments.Order.avsc.json"],
    ["com\\acme\\Order.java", "com/acme/Order.java"],
    ["a..b/c.json", "a..b/c.json"],
  ])("accepts %j as %j", (raw, expected) => {
    expect(sanitizeExportFilePath(raw)).toEqual({ ok: true, path: expected });
  });

  it.each([
    ["../x.json", "dot segment"],
    ["a/../../x.json", "dot segment"],
    ["..\\x.json", "dot segment"],
    ["a/./b.json", "dot segment"],
    ["a/.../b.json", "dot segment"],
    ["/etc/passwd", "absolute"],
    ["\\\\server\\share\\x.json", "absolute"],
    ["C:\\x.json", "drive letter"],
    ["c:x.json", "drive letter"],
    ["a//b.json", "empty segment"],
    ["a/", "empty segment"],
    ["", "empty"],
    ["a/\u0000b.json", "control character"],
    ["a/\nb.json", "control character"],
    [".git/hooks/pre-commit", "git"],
    ["a/.GIT/config", "git"],
    ["a/.git./config", "git"],
    [`${"a".repeat(300)}.json`, "segment too long"],
    [`${"a/".repeat(300)}x.json`, "too long"],
  ])("rejects %j (%s)", (raw, reason) => {
    const result = sanitizeExportFilePath(raw);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain(reason);
  });

  it("rejects a value that is not a string", () => {
    expect(sanitizeExportFilePath(undefined).ok).toBe(false);
    expect(sanitizeExportFilePath(42).ok).toBe(false);
  });
});

describe("a hostile file path is skipped with a warning and the rest of the export is kept", () => {
  it("never writes outside the base path", () => {
    const warnings: string[] = [];
    const files = generateExportFiles(BASE, "Payments", "Order", { name: "Order" }, {}, {
      entityId: "e-order",
      productName: "Checkout",
      warnings,
      schemaVersions: {
        "json-schema": [
          published("json-schema", 1, [
            file("json-schema", "../../../etc/cron.d/x", "evil", "e-order"),
            file("json-schema", "/abs/Order.json", "evil", "e-order"),
            file("json-schema", "C:\\Windows\\x.json", "evil", "e-order"),
            file("json-schema", ".git/config", "evil", "e-order"),
            file("json-schema", "Order.json", "good", "e-order"),
            { path: 7 as never, content: "evil", target: "json-schema" },
            { path: "NoContent.json", target: "json-schema" } as never,
          ]),
        ],
      },
    });

    expect(paths(files).sort()).toEqual(
      ["schemas/payments/checkout/order/order.superschema.json", "schemas/payments/checkout/order/json-schema/Order.json"].sort()
    );
    expect(files.some((f) => f.content === "evil")).toBe(false);
    for (const f of files) {
      expect(f.path.startsWith(BASE)).toBe(true);
      expect(f.path.split("/")).not.toContain("..");
    }
    expect(warnings).toHaveLength(6);
    expect(warnings[0]).toContain("json-schema");
    expect(warnings[0]).toContain("../../../etc/cron.d/x");
  });

  it("a hostile path in an output fallback cannot happen: the path is built from slugs", () => {
    const files = generateExportFiles(BASE, "../..", "../../etc/passwd", { name: "x" }, {}, {
      entityId: "e1",
      productName: "..",
      schemaVersions: { avro: [version({ version: 1, status: "published", output: "{}" })] },
    });
    for (const f of files) {
      expect(f.path.startsWith(BASE)).toBe(true);
      expect(f.path.split("/")).not.toContain("..");
    }
  });

  it("a malformed schemaVersions value exports nothing for the target and does not throw", () => {
    const garbage: unknown[] = [null, "x", 3, [], { avro: "not a list", "java-pojo": [null, 7, { status: "published" }] }];
    for (const schemaVersions of garbage) {
      const files = generateExportFiles(BASE, "Payments", "Order", { name: "Order" }, {}, { entityId: "e1", productName: "Checkout", schemaVersions });
      expect(paths(files)).toEqual(["schemas/payments/checkout/order/order.superschema.json"]);
    }
  });

  it("two files that land on the same path keep the first and warn when their content differs", () => {
    const warnings: string[] = [];
    const files = generateExportFiles(BASE, "Payments", "Order", { name: "Order" }, {}, {
      entityId: "e1",
      productName: "Checkout",
      warnings,
      schemaVersions: {
        avro: [published("avro", 1, [file("avro", "x.avsc.json", "first", "e1"), file("avro", "x.avsc.json", "second", "e1"), file("avro", "same.json", "same", "e1"), file("avro", "same.json", "same", "e1")])],
      },
    });
    expect(files.filter((f) => f.path.endsWith("/avro/x.avsc.json")).map((f) => f.content)).toEqual(["first"]);
    expect(files.filter((f) => f.path.endsWith("/avro/same.json"))).toHaveLength(1);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("x.avsc.json");
  });
});

// ---------------------------------------------------------------------------
// Files of the other entities of a closure
// ---------------------------------------------------------------------------

describe("files of the other entities of a closure", () => {
  const orderFiles = (): EmittedFile[] => [
    file("avro", "acme.Address.avsc.json", "ADDRESS via order", "e-address"),
    file("avro", "acme.Order.avsc.json", "ORDER", "e-order"),
  ];

  it("go once under the owner's folder when the owner is exported too and has nothing of its own for that target", () => {
    const order = entityInput({ name: "Order", entityId: "e-order", schemaVersions: { avro: [published("avro", 1, orderFiles())] } });
    const address = entityInput({ name: "Address", entityId: "e-address", schemaVersions: {} });

    const plan = planGitExport(BASE, [order, address]);

    expect(plan.warnings).toEqual([]);
    expect(paths(plan.files).sort()).toEqual(
      [
        "schemas/payments/checkout/order/order.superschema.json",
        "schemas/payments/checkout/order/avro/acme.Order.avsc.json",
        "schemas/payments/checkout/address/address.superschema.json",
        "schemas/payments/checkout/address/avro/acme.Address.avsc.json",
      ].sort()
    );
    expect(plan.files.find((f) => f.path.endsWith("address/avro/acme.Address.avsc.json"))?.content).toBe("ADDRESS via order");
  });

  it("are not duplicated when the owner exports its own version of the target (the owner's own files win)", () => {
    const order = entityInput({ name: "Order", entityId: "e-order", schemaVersions: { avro: [published("avro", 1, orderFiles())] } });
    const address = entityInput({
      name: "Address",
      entityId: "e-address",
      // The same entity's file under another name, as happens when names collide in the other root.
      schemaVersions: { avro: [published("avro", 1, [file("avro", "Address.avsc.json", "ADDRESS own", "e-address")])] },
    });

    const plan = paths(planGitExport(BASE, [order, address]).files);

    expect(plan.filter((p) => p.includes("/address/avro/"))).toEqual(["schemas/payments/checkout/address/avro/Address.avsc.json"]);
    expect(plan.some((p) => p.includes("/order/avro/acme.Address"))).toBe(false);
  });

  it("go under the root's folder when the owner is not among the exported entities", () => {
    const order = entityInput({ name: "Order", entityId: "e-order", schemaVersions: { avro: [published("avro", 1, orderFiles())] } });
    const other = entityInput({ name: "Other", entityId: "e-other", schemaVersions: {} });

    const plan = paths(planGitExport(BASE, [order, other]).files);

    expect(plan).toContain("schemas/payments/checkout/order/avro/acme.Address.avsc.json");
    expect(plan).toContain("schemas/payments/checkout/order/avro/acme.Order.avsc.json");
    expect(plan.some((p) => p.includes("/other/avro/"))).toBe(false);
  });

  it("go under the root's folder when the file has no entityId, and when the root has no id", () => {
    const noId = entityInput({
      name: "Order",
      schemaVersions: { protobuf: [published("protobuf", 1, [file("protobuf", "shared.proto", "SHARED"), file("protobuf", "order.proto", "ORDER", "e-order")])] },
    });
    const address = entityInput({ name: "Address", entityId: "e-address", schemaVersions: {} });
    const plan = paths(planGitExport(BASE, [noId, address]).files);
    expect(plan).toContain("schemas/payments/checkout/order/protobuf/shared.proto");
    expect(plan).toContain("schemas/payments/checkout/order/protobuf/order.proto");
  });

  it("a protobuf cycle's second member has no file of its own: the shared file is exported once, under the member it is tagged with", () => {
    const shared = () => [file("protobuf", "cycle.proto", "A and B", "e-a")];
    const a = entityInput({ name: "A", entityId: "e-a", schemaVersions: { protobuf: [published("protobuf", 1, shared())] } });
    const b = entityInput({ name: "B", entityId: "e-b", schemaVersions: { protobuf: [published("protobuf", 1, shared())] } });
    const plan = planGitExport(BASE, [a, b]);
    // B's version holds the file as a file of A, and A (exported too) has its own version of the target: A's folder carries it, once.
    expect(paths(plan.files).filter((p) => p.includes("/protobuf/"))).toEqual(["schemas/payments/checkout/a/protobuf/cycle.proto"]);
    expect(plan.warnings).toEqual([]);
  });

  it("two roots that both carry the owner's files contribute them once (the first root's copy)", () => {
    const r1 = entityInput({ name: "R1", entityId: "e-r1", schemaVersions: { avro: [published("avro", 1, [file("avro", "R1.avsc.json", "R1", "e-r1"), file("avro", "Address.avsc.json", "FROM R1", "e-address")])] } });
    const r2 = entityInput({ name: "R2", entityId: "e-r2", schemaVersions: { avro: [published("avro", 1, [file("avro", "R2.avsc.json", "R2", "e-r2"), file("avro", "ns.Address.avsc.json", "FROM R2", "e-address")])] } });
    const address = entityInput({ name: "Address", entityId: "e-address", schemaVersions: {} });
    const plan = planGitExport(BASE, [r1, r2, address]);
    const addressFiles = plan.files.filter((f) => f.path.includes("/address/avro/"));
    expect(addressFiles.map((f) => [f.path, f.content])).toEqual([["schemas/payments/checkout/address/avro/Address.avsc.json", "FROM R1"]]);
    expect(plan.warnings).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The SuperSchema JSON
// ---------------------------------------------------------------------------

describe("buildExportEntityDefinition", () => {
  const entity = {
    name: "Order",
    description: "An order",
    status: "ACTIVE",
    domain: { name: "Payments" },
    fields: [{ name: "id", type: "STRING", nullable: false, isKey: true, description: "", classification: null, decorators: {} }],
    metadata: { currentVersion: 2, tags: ["a"], schemaVersions: { avro: [{ version: 1, output: "BIG" }] }, emittedOutputs: { avro: { output: "legacy" } } },
  };

  it("keeps the definition and drops the stored generated schemas (they are exported as files)", () => {
    const definition = buildExportEntityDefinition(entity, 2);
    expect(definition.name).toBe("Order");
    expect(definition.domain).toBe("Payments");
    expect(definition.version).toBe(2);
    expect((definition.fields as unknown[]).length).toBe(1);
    expect(definition.metadata).toEqual({ currentVersion: 2, tags: ["a"], emittedOutputs: { avro: { output: "legacy" } } });
    expect(JSON.stringify(definition)).not.toContain("BIG");
    // The entity itself is not modified.
    expect(entity.metadata.schemaVersions).toBeDefined();
  });

  it("labels a tenant-level entity's domain as before", () => {
    expect(buildExportEntityDefinition({ ...entity, domain: null }, 1).domain).toBe("Enterprise");
  });
});

describe("targetFileExtension", () => {
  it("keeps the extensions of the formats exported before", () => {
    expect(targetFileExtension("bigquery")).toBe(".bq.sql");
    expect(targetFileExtension("avro")).toBe(".avro.json");
    expect(targetFileExtension("openapi")).toBe(".openapi.yaml");
    expect(targetFileExtension("openapi3")).toBe(".openapi.yaml");
  });

  it("gives every catalog target an extension", () => {
    for (const target of getSchemaTargetCatalog()) expect(targetFileExtension(target.key), target.key).toMatch(/^\.[a-z.]+$/);
    expect(targetFileExtension("unknown-target")).toBe(".txt");
  });
});

// ---------------------------------------------------------------------------
// The entry points that call it
// ---------------------------------------------------------------------------

const adminCtx: ServiceContext = {
  userId: "user-admin",
  userRole: "ADMIN",
  prisma: prisma as unknown as ServiceContext["prisma"],
};

const entityRow = (over: Record<string, unknown>) => ({
  id: "e1",
  name: "Order",
  description: "",
  status: "ACTIVE",
  domain: { name: "Payments" },
  product: { name: "Checkout" },
  fields: [],
  metadata: {},
  ...over,
});

describe("entry points export file sets", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.gitConfig.findFirst).mockResolvedValue({
      id: "gc-1",
      basePath: "schemas/",
      enabled: true,
      prReviewMode: "NEVER",
      repositoryUrl: "https://example.com/org/repo",
    } as never);
    vi.mocked(prisma.gitConfig.update).mockResolvedValue({} as never);
  });

  const orderMetadata = { schemaVersions: closureVersions() };

  it("exportEntity counts the SuperSchema JSON and every stored file of every target", async () => {
    vi.mocked(prisma.entity.findUnique).mockResolvedValue(entityRow({ id: "e-order", metadata: orderMetadata }) as never);
    const result = await exportEntity("e-order", adminCtx);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.success).toBe(true);
      expect(result.data.filesExported).toBe(1 + 10);
      expect(result.data.warnings).toBeUndefined();
    }
    // The product is read with the entity.
    expect(vi.mocked(prisma.entity.findUnique).mock.calls[0][0]).toMatchObject({ include: { domain: true, product: true } });
  });

  it("exportEntity reports the files it skipped", async () => {
    vi.mocked(prisma.entity.findUnique).mockResolvedValue(
      entityRow({
        metadata: { schemaVersions: { avro: [published("avro", 1, [file("avro", "../x", "evil", "e1"), file("avro", "ok.json", "ok", "e1")])] } },
      }) as never
    );
    const result = await exportEntity("e1", adminCtx);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.filesExported).toBe(2);
      expect(result.data.warnings).toHaveLength(1);
    }
  });

  it("exportAll exports same-named entities of different products side by side and puts a closure member's files with its owner", async () => {
    vi.mocked(prisma.entity.findMany).mockResolvedValue([
      entityRow({
        id: "e-order",
        product: { name: "Checkout" },
        metadata: { schemaVersions: { avro: [published("avro", 1, [file("avro", "Order.avsc.json", "O1", "e-order"), file("avro", "Address.avsc.json", "A1", "e-address")])] } },
      }),
      entityRow({ id: "e-address", name: "Address", product: { name: "Checkout" }, metadata: {} }),
      entityRow({
        id: "e-order-2",
        product: { name: "Billing" },
        metadata: { schemaVersions: { avro: [published("avro", 1, [file("avro", "Order.avsc.json", "O2", "e-order-2")])] } },
      }),
    ] as never);

    const result = await exportAll(adminCtx);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.success).toBe(true);
      // 3 SuperSchema JSON + Order.avsc + Address.avsc (under Address, once) + the other Order.avsc.
      expect(result.data.filesExported).toBe(6);
      expect(result.data.warnings).toBeUndefined();
    }
    expect(vi.mocked(prisma.entity.findMany).mock.calls[0][0]).toMatchObject({ include: { domain: true, product: true } });
  });

  it("exportWithReview (direct push) exports the file set too", async () => {
    vi.mocked(prisma.entity.findUnique).mockResolvedValue(entityRow({ id: "e-order", metadata: orderMetadata }) as never);
    const result = await exportWithReview("e-order", "v-1", { isBreaking: false, changeType: "non-breaking", summary: "x", changeRecord: null }, adminCtx);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.pr).toBeUndefined();
      expect(result.data.filesExported).toBe(1 + 10);
    }
  });

  it("exportWithReview (PR) exports the file set too", async () => {
    vi.mocked(prisma.gitConfig.findFirst).mockResolvedValue({
      id: "gc-1",
      basePath: "schemas/",
      enabled: true,
      prReviewMode: "ALWAYS",
      repositoryUrl: "https://example.com/org/repo",
    } as never);
    vi.mocked(prisma.entity.findUnique).mockResolvedValue(entityRow({ id: "e-order", metadata: orderMetadata }) as never);
    vi.mocked(prisma.gitPullRequest.create).mockResolvedValue({ prUrl: "https://example.com/pull/1", prNumber: 1, branchName: "schema/order/v1" } as never);
    const result = await exportWithReview("e-order", "v-1", { isBreaking: true, changeType: "breaking", summary: "x", changeRecord: null }, adminCtx);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.pr).toBeDefined();
      expect(result.data.filesExported).toBe(1 + 10);
    }
  });
});
