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
  exportedTargetSummary,
  generateExportFiles,
  pickExportVersion,
  planGitExport,
  sanitizeExportFilePath,
  targetFileExtension,
  type GitExportEntityInput,
} from "@/services/git.service";
import { exportWithReview } from "@/services/git-pr.service";
import { prisma } from "@/lib/db";
import { getSchemaTargetCatalog } from "@/lib/schema-targets/catalog";
import type { ServiceContext } from "@/types/service-context";
import type { SchemaVersion, SchemaVersionsMap } from "@/types/schema-version";
import type { EmittedFile } from "@/lib/typespec-official/closure-emit";
import type { TargetOutput } from "@/lib/emission/emission.types";
import { assign } from "../../helpers/access-mocks";

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
const dirOf = (path: string) => path.slice(0, path.lastIndexOf("/"));

/** One entity's export input; `schemaVersions` is what `entity.metadata.schemaVersions` holds. */
function entityInput(over: Partial<GitExportEntityInput> & { name: string }): GitExportEntityInput {
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
      productName: "Checkout",
      schemaVersions: closureVersions(),
      warnings,
    });

    const dir = "schemas/payments/checkout/order";
    // The root's full file set: its own files and those of the Address it references.
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
    const files = generateExportFiles(BASE, "Payments", "Order", { name: "Order" }, {}, { productName: "Checkout", schemaVersions });
    for (const target of getSchemaTargetCatalog()) {
      const written = files.filter((f) => f.path.startsWith(`schemas/payments/checkout/order/${target.key}/`));
      expect(written, target.key).toHaveLength(1);
      expect(written[0].content).toBe(`content of ${target.key}`);
    }
    // 1 SuperSchema JSON + one file per catalog target.
    expect(files).toHaveLength(1 + getSchemaTargetCatalog().length);
  });

  it("falls back to the output string, one file named by the target's extension convention, when a version has no files", () => {
    const warnings: string[] = [];
    const files = generateExportFiles(BASE, "Payments", "Order Item", { name: "Order Item" }, {}, {
      productName: "Checkout",
      warnings,
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
    // Only the draft is worth a remark.
    expect(warnings).toEqual(["Order Item: bigquery: exported draft v2"]);
  });

  it("uses the _tenant placeholder for a missing domain and a missing product", () => {
    const files = generateExportFiles(BASE, null, "Customer", { name: "Customer" }, {}, {
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
      productName: "Checkout",
      schemaVersions: {},
    });
    expect(paths(files)).toEqual(["schemas/payments/checkout/order/order.superschema.json"]);
  });

  it("two same-named entities in different products do not collide, in one bulk run or one at a time", () => {
    const a = entityInput({ name: "Order", productName: "Checkout", schemaVersions: { avro: [published("avro", 1, [file("avro", "acme.Order.avsc.json", "A", "e-a")])] } });
    const b = entityInput({ name: "Order", productName: "Billing", schemaVersions: { avro: [published("avro", 1, [file("avro", "acme.Order.avsc.json", "B", "e-b")])] } });
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
    const oneA = generateExportFiles(BASE, "Payments", "Order", { name: "Order" }, {}, { productName: "Checkout", schemaVersions: a.schemaVersions });
    expect(paths(oneA).every((p) => p.startsWith("schemas/payments/checkout/order/"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Folder names
// ---------------------------------------------------------------------------

describe("folder names", () => {
  const exportPaths = (domain: string | null, product: string | null, entity: string) =>
    paths(generateExportFiles(BASE, domain, entity, {}, {}, { productName: product, schemaVersions: {} }));

  it("never are a name Windows reserves for a device: a trailing underscore is added", () => {
    expect(exportPaths("NUL", "Aux", "Con")).toEqual(["schemas/nul_/aux_/con_/con_.superschema.json"]);
    expect(exportPaths("Payments", "COM1", "lpt9")).toEqual(["schemas/payments/com1_/lpt9_/lpt9_.superschema.json"]);
    // Names that only start with one are fine.
    expect(exportPaths("Console", "Communication", "Auxiliary")).toEqual(["schemas/console/communication/auxiliary/auxiliary.superschema.json"]);
  });

  it("are at most 100 characters, without a trailing hyphen", () => {
    expect(exportPaths("Payments", "Checkout", "x".repeat(150))).toEqual([`schemas/payments/checkout/${"x".repeat(100)}/${"x".repeat(100)}.superschema.json`]);
    const name = `${"a".repeat(99)} b`; // slug: 99 a, hyphen, b: cut at 100 leaves a trailing hyphen
    expect(exportPaths("Payments", "Checkout", name)).toEqual([`schemas/payments/checkout/${"a".repeat(99)}/${"a".repeat(99)}.superschema.json`]);
  });

  it("are built from slugs only: a path-like name cannot leave the base (and a name without letters or digits is _unnamed)", () => {
    const files = generateExportFiles(BASE, "../..", "../../etc/passwd", { name: "x" }, {}, {
      productName: "..",
      schemaVersions: { avro: [version({ version: 1, status: "published", output: "{}" })] },
    });
    expect(paths(files)).toEqual([
      "schemas/_unnamed/_unnamed/etc-passwd/etc-passwd.superschema.json",
      "schemas/_unnamed/_unnamed/etc-passwd/avro/etc-passwd.avro.json",
    ]);
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

describe("what the export tells about the version it picked", () => {
  const warningsOf = (schemaVersions: SchemaVersionsMap): string[] => {
    const warnings: string[] = [];
    generateExportFiles(BASE, "Payments", "Order", { name: "Order" }, {}, { productName: "Checkout", schemaVersions, warnings });
    return warnings;
  };

  it("says that a newer draft was not exported", () => {
    expect(
      warningsOf({ avro: [version({ version: 3, status: "draft", output: "D" }), version({ version: 2, status: "published", output: "P" })] })
    ).toEqual(["Order: avro: exported published v2; newer draft v3 not exported"]);
  });

  it("says nothing when the exported version is the newest published one", () => {
    expect(warningsOf({ avro: [version({ version: 2, status: "published", output: "P" }), version({ version: 1, status: "published", output: "P" })] })).toEqual([]);
    expect(warningsOf({ avro: [version({ version: 2, status: "deployed", output: "P" })] })).toEqual([]);
  });

  it("says that a draft was exported because nothing is published, and that it is a preview when it references drafts", () => {
    expect(warningsOf({ avro: [version({ version: 1, status: "draft", output: "D" })] })).toEqual(["Order: avro: exported draft v1"]);
    expect(
      warningsOf({
        avro: [version({ version: 2, status: "draft", output: "D", resolution: { mode: "draft", preview: true, entities: [] } })],
      })
    ).toEqual(["Order: avro: exported draft v2 (preview)"]);
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
    ["com.acme.Order.avsc.json", "com.acme.Order.avsc.json"],
    ["com\\acme\\Order.java", "com/acme/Order.java"],
    ["a..b/c.json", "a..b/c.json"],
    // Names that only look like a Windows device name.
    ["console.json", "console.json"],
    ["communication/x.json", "communication/x.json"],
    ["com10.json", "com10.json"],
    ["lpt.json", "lpt.json"],
    // 127 two-byte characters are 254 bytes.
    ["é".repeat(127), "é".repeat(127)],
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
    ["a/b:c.json", "colon"],
    ["a/x.json:stream", "colon"],
    ["a//b.json", "empty segment"],
    ["a/", "empty segment"],
    ["", "empty"],
    ["a/\u0000b.json", "control character"],
    ["a/\nb.json", "control character"],
    [".git/hooks/pre-commit", "git"],
    ["a/.GIT/config", "git"],
    ["a/.git./config", "git"],
    ["a/GIT~1/config", "git"],
    ["a/.g\u200cit/config", "invisible"],
    ["a/\ufeffb.json", "invisible"],
    ["con", "device name"],
    ["CON.json", "device name"],
    ["a/Aux.java", "device name"],
    ["a/b/com1.txt", "device name"],
    ["LPT9", "device name"],
    ["nul.tar.gz", "device name"],
    [`${"a".repeat(300)}.json`, "segment too long"],
    [`${"é".repeat(130)}.json`, "segment too long"], // 130 characters, 266 bytes
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

  it("a malformed schemaVersions value exports nothing for the target and does not throw", () => {
    const garbage: unknown[] = [null, "x", 3, [], { avro: "not a list", "java-pojo": [null, 7, { status: "published" }] }];
    for (const schemaVersions of garbage) {
      const files = generateExportFiles(BASE, "Payments", "Order", { name: "Order" }, {}, { productName: "Checkout", schemaVersions });
      expect(paths(files)).toEqual(["schemas/payments/checkout/order/order.superschema.json"]);
    }
  });

  it("returns at most 50 warnings and counts the rest", () => {
    const hostile = Array.from({ length: 60 }, (_, i) => file("avro", `../x${i}.json`, "evil"));
    const warnings: string[] = [];
    const files = generateExportFiles(BASE, "Payments", "Order", { name: "Order" }, {}, {
      productName: "Checkout",
      warnings,
      schemaVersions: { avro: [published("avro", 1, hostile)] },
    });
    expect(paths(files)).toEqual(["schemas/payments/checkout/order/order.superschema.json"]);
    expect(warnings).toHaveLength(51);
    expect(warnings[0]).toContain("../x0.json");
    expect(warnings[49]).toContain("../x49.json");
    expect(warnings[50]).toBe("and 10 more warnings");
  });
});

describe("two files that cannot both be written", () => {
  const exportAvro = (avroFiles: EmittedFile[]) => {
    const warnings: string[] = [];
    const files = generateExportFiles(BASE, "Payments", "Order", { name: "Order" }, {}, {
      productName: "Checkout",
      warnings,
      schemaVersions: { avro: [published("avro", 1, avroFiles)] },
    });
    return { files: files.filter((f) => f.path.includes("/avro/")), warnings };
  };

  it("on one path: the first is kept, and a warning says so when their content differs", () => {
    const { files, warnings } = exportAvro([
      file("avro", "x.avsc.json", "first"),
      file("avro", "x.avsc.json", "second"),
      file("avro", "same.json", "same"),
      file("avro", "same.json", "same"),
    ]);
    expect(files.filter((f) => f.path.endsWith("/avro/x.avsc.json")).map((f) => f.content)).toEqual(["first"]);
    expect(files.filter((f) => f.path.endsWith("/avro/same.json"))).toHaveLength(1);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("x.avsc.json");
  });

  it("on paths that differ only by letter case: the first is kept, with a warning", () => {
    const { files, warnings } = exportAvro([file("avro", "Order.avsc.json", "upper"), file("avro", "order.avsc.json", "lower")]);
    expect(files.map((f) => [f.path, f.content])).toEqual([["schemas/payments/checkout/order/avro/Order.avsc.json", "upper"]]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("letter case");
    expect(warnings[0]).toContain("order.avsc.json");
  });

  it("when one is a file and the other would be inside it, in either order", () => {
    const fileFirst = exportAvro([file("avro", "x", "a file"), file("avro", "x/y.json", "inside")]);
    expect(fileFirst.files.map((f) => f.content)).toEqual(["a file"]);
    expect(fileFirst.warnings).toHaveLength(1);
    expect(fileFirst.warnings[0]).toContain("x/y.json");

    const directoryFirst = exportAvro([file("avro", "x/y.json", "inside"), file("avro", "x", "a file")]);
    expect(directoryFirst.files.map((f) => f.content)).toEqual(["inside"]);
    expect(directoryFirst.warnings).toHaveLength(1);
    expect(directoryFirst.warnings[0]).toContain("directory");
  });

  it("across entities that share a folder (the first is kept)", () => {
    const first = entityInput({ name: "Order", schemaVersions: { avro: [published("avro", 1, [file("avro", "x.json", "first")])] } });
    const second = entityInput({ name: "order", schemaVersions: { avro: [published("avro", 1, [file("avro", "x.json", "second")])] } });
    const plan = planGitExport(BASE, [first, second]);
    expect(plan.files.filter((f) => f.path.endsWith("/avro/x.json")).map((f) => f.content)).toEqual(["first"]);
    expect(plan.warnings.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// The files of the entities a root references
// ---------------------------------------------------------------------------

describe("every entity folder holds the root's full file set", () => {
  /** An Order whose JSON Schema and Avro files point at the files of Address and a Customer qualified by its domain. */
  const orderVersions = (): SchemaVersionsMap => ({
    "json-schema": [
      published("json-schema", 1, [
        file("json-schema", "Address.json", "{\"title\":\"Address\"}", "e-address"),
        file("json-schema", "Billing.Customer.json", "{\"title\":\"Customer of Billing\"}", "e-customer-billing"),
        file("json-schema", "Order.json", JSON.stringify({ title: "Order", properties: { a: { $ref: "Address.json" }, c: { $ref: "Billing.Customer.json" } } }), "e-order"),
      ]),
    ],
    avro: [
      published("avro", 1, [
        file("avro", "acme.Address.avsc.json", "ADDRESS via order", "e-address"),
        file("avro", "acme.Order.avsc.json", "ORDER", "e-order"),
      ]),
    ],
  });
  const addressVersions = (): SchemaVersionsMap => ({
    "json-schema": [published("json-schema", 1, [file("json-schema", "Address.json", "{\"title\":\"Address\"}", "e-address")])],
    // Another name for the same file, as happens when names collide in another root.
    avro: [published("avro", 1, [file("avro", "Address.avsc.json", "ADDRESS own", "e-address")])],
  });

  const order = () => entityInput({ name: "Order", schemaVersions: orderVersions() });
  const address = () => entityInput({ name: "Address", schemaVersions: addressVersions() });

  const filesUnder = (files: { path: string; content: string }[], dir: string) =>
    files.filter((f) => f.path.startsWith(`${dir}/`)).map((f) => [f.path, f.content]);

  it("the target of every $ref of a file is in the same folder, whether Address is exported too or not", () => {
    for (const run of [[order()], [order(), address()], [address(), order()]]) {
      const plan = planGitExport(BASE, run);
      const orderFile = plan.files.find((f) => f.path === "schemas/payments/checkout/order/json-schema/Order.json");
      expect(orderFile).toBeDefined();
      const refs = Object.values(JSON.parse(orderFile?.content ?? "{}").properties as Record<string, { $ref: string }>).map((p) => p.$ref);
      expect(refs).toEqual(["Address.json", "Billing.Customer.json"]);
      for (const ref of refs) expect(paths(plan.files)).toContain(`${dirOf(orderFile?.path ?? "")}/${ref}`);
      expect(plan.warnings).toEqual([]);
    }
  });

  it("an entity exports the same files in its folder alone and in a bulk run (exportAll)", () => {
    const alone = generateExportFiles(BASE, "Payments", "Order", { name: "Order" }, {}, { productName: "Checkout", schemaVersions: orderVersions() });
    const bulk = planGitExport(BASE, [order(), address()]).files;
    const dir = "schemas/payments/checkout/order";
    expect(filesUnder(bulk, dir)).toEqual(filesUnder(alone, dir));
    expect(filesUnder(alone, dir).length).toBe(1 + 3 + 2);
  });

  it("holds the files of the entities it references under their qualified names and full names", () => {
    const plan = planGitExport(BASE, [order(), address()]);
    const dir = "schemas/payments/checkout/order";
    expect(paths(plan.files)).toEqual(
      expect.arrayContaining([
        `${dir}/json-schema/Address.json`,
        `${dir}/json-schema/Billing.Customer.json`,
        `${dir}/json-schema/Order.json`,
        `${dir}/avro/acme.Address.avsc.json`,
        `${dir}/avro/acme.Order.avsc.json`,
      ])
    );
    // The referenced entity that is exported itself has its own folder with its own full set (content repeats across folders).
    expect(filesUnder(plan.files, "schemas/payments/checkout/address")).toEqual([
      ["schemas/payments/checkout/address/address.superschema.json", JSON.stringify({ name: "Address" }, null, 2)],
      ["schemas/payments/checkout/address/avro/Address.avsc.json", "ADDRESS own"],
      ["schemas/payments/checkout/address/json-schema/Address.json", "{\"title\":\"Address\"}"],
    ]);
    // Nothing of Order's set is dropped from its folder because Address is exported too.
    expect(plan.files.find((f) => f.path === `${dir}/avro/acme.Address.avsc.json`)?.content).toBe("ADDRESS via order");
  });

  it("a protobuf cycle's file is in the folder of each member that has it, once", () => {
    const shared = () => [file("protobuf", "cycle.proto", "A and B", "e-a")];
    const a = entityInput({ name: "A", schemaVersions: { protobuf: [published("protobuf", 1, shared())] } });
    const b = entityInput({ name: "B", schemaVersions: { protobuf: [published("protobuf", 1, shared())] } });
    const plan = planGitExport(BASE, [a, b]);
    expect(paths(plan.files).filter((p) => p.includes("/protobuf/")).sort()).toEqual(
      ["schemas/payments/checkout/a/protobuf/cycle.proto", "schemas/payments/checkout/b/protobuf/cycle.proto"].sort()
    );
    expect(plan.warnings).toEqual([]);
  });

  it("files without an entityId are in the folder too", () => {
    const files = generateExportFiles(BASE, "Payments", "Order", { name: "Order" }, {}, {
      productName: "Checkout",
      schemaVersions: { protobuf: [published("protobuf", 1, [file("protobuf", "shared.proto", "SHARED"), file("protobuf", "order.proto", "ORDER", "e-order")])] },
    });
    expect(paths(files)).toEqual(
      expect.arrayContaining(["schemas/payments/checkout/order/protobuf/shared.proto", "schemas/payments/checkout/order/protobuf/order.proto"])
    );
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
// The target table of a PR
// ---------------------------------------------------------------------------

describe("exportedTargetSummary", () => {
  it("lists the targets of the entity in catalog order with the picked version, its status and file count", () => {
    const rows = exportedTargetSummary(entityInput({ name: "Order", schemaVersions: closureVersions() }));
    expect(rows).toEqual([
      { target: "avro", displayName: "Avro Schema", version: 1, status: "published", fileCount: 2 },
      { target: "java-pojo", displayName: "Java POJO", version: 1, status: "published", fileCount: 2 },
      { target: "openapi3", displayName: "OpenAPI 3 (TypeSpec)", version: 1, status: "published", fileCount: 2 },
      { target: "json-schema", displayName: "JSON Schema (TypeSpec)", version: 1, status: "published", fileCount: 2 },
      { target: "protobuf", displayName: "Protobuf (TypeSpec)", version: 1, status: "published", fileCount: 2 },
    ]);
  });

  it("reports the version the export writes (published over a newer draft), a preview, and the output fallback as one file", () => {
    const rows = exportedTargetSummary(
      entityInput({
        name: "Order",
        schemaVersions: {
          avro: [version({ version: 3, status: "draft", output: "D" }), version({ version: 2, status: "published", output: "P" })],
          postgresql: [version({ version: 1, status: "draft", output: "DDL", resolution: { mode: "draft", preview: true, entities: [] } })],
          "json-schema": [published("json-schema", 1, [file("json-schema", "../evil.json", "x"), file("json-schema", "A.json", "a"), file("json-schema", "A.json", "a")])],
        },
      })
    );
    expect(rows).toEqual([
      { target: "avro", displayName: "Avro Schema", version: 2, status: "published", fileCount: 1 },
      { target: "postgresql", displayName: "PostgreSQL DDL", version: 1, status: "draft", fileCount: 1, preview: true },
      { target: "json-schema", displayName: "JSON Schema (TypeSpec)", version: 1, status: "published", fileCount: 1 },
    ]);
  });

  it("is empty for an entity without versions", () => {
    expect(exportedTargetSummary(entityInput({ name: "Order" }))).toEqual([]);
    expect(exportedTargetSummary(entityInput({ name: "Order", schemaVersions: "garbage" }))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The entry points that call it
// ---------------------------------------------------------------------------

const adminCtx: ServiceContext = {
  userId: "user-admin",
  userRole: "ADMIN", assignments: [assign.global()],
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

  it("exportAll gives every entity its own full folder, same-named ones of different products side by side", async () => {
    vi.mocked(prisma.entity.findMany).mockResolvedValue([
      entityRow({
        id: "e-order",
        product: { name: "Checkout" },
        metadata: { schemaVersions: { avro: [published("avro", 1, [file("avro", "Order.avsc.json", "O1", "e-order"), file("avro", "Address.avsc.json", "A1", "e-address")])] } },
      }),
      entityRow({
        id: "e-address",
        name: "Address",
        product: { name: "Checkout" },
        metadata: { schemaVersions: { avro: [published("avro", 1, [file("avro", "Address.avsc.json", "A1", "e-address")])] } },
      }),
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
      // Order (Checkout): JSON + Order.avsc + Address.avsc; Address: JSON + Address.avsc; Order (Billing): JSON + Order.avsc.
      expect(result.data.filesExported).toBe(3 + 2 + 2);
      expect(result.data.warnings).toBeUndefined();
    }
    const query = vi.mocked(prisma.entity.findMany).mock.calls[0][0];
    expect(query).toMatchObject({ include: { domain: true, product: true } });
    // A fixed order, so two runs write the same files.
    expect(query).toMatchObject({ orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
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

  it("exportWithReview (PR) exports the file set too, and the PR body lists the targets it adds", async () => {
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
      const body = (result.data as { prBody?: string }).prBody ?? "";
      expect(body).toContain("| Target | Version | Status | Files | Details |");
      expect(body).toContain("| Avro Schema | v1 | published | 2 | - |");
      expect(body).toContain("| Protobuf (TypeSpec) | v1 | published | 2 | - |");
      expect(body).not.toContain("No emission targets configured.");
      expect(body).not.toContain("Invalid");
    }
  });
});
