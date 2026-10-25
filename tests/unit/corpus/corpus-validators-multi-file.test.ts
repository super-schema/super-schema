/**
 * A closure is one file per entity, joined as `===== path =====` blocks (`SchemaVersion.output`). The corpus judges EVERY file of it, with
 * the validator of its target: each OpenAPI document and each Avro schema on its own (each is self-contained), the Protobuf files together
 * (they import each other). A single bare file is judged as before.
 */
import { describe, it, expect } from "vitest";
import { validateAvro, validateOpenApi, validateProtobuf } from "../../helpers/corpus/validators";

const bundle = (files: Record<string, string>) => Object.entries(files).map(([name, body]) => `===== ${name} =====\n${body}`).join("\n\n");

const OPENAPI = (title: string) => `openapi: 3.1.0\ninfo:\n  title: ${title}\n  version: 0.0.0\npaths: {}\ncomponents:\n  schemas:\n    ${title}:\n      type: object\n      properties:\n        id:\n          type: string\n`;
const BAD_OPENAPI = "openapi: 3.1.0\ninfo: {}\npaths: {}\n";

const AVRO = (name: string, field = "string") => JSON.stringify({ type: "record", name, namespace: "x.y", fields: [{ name: "id", type: field }] });

const PROTO_A = 'syntax = "proto3";\npackage a;\nimport "b/B.proto";\nmessage A {\n  b.B b = 1;\n}\n';
const PROTO_B = 'syntax = "proto3";\npackage b;\nmessage B {\n  string id = 1;\n}\n';

describe("validateOpenApi", () => {
  it("judges a bare document, and every document of a set", async () => {
    expect(await validateOpenApi(OPENAPI("A"))).toMatchObject({ ok: true, tier: "@scalar/openapi-parser validate" });
    const set = bundle({ "openapi.A.yaml": OPENAPI("A"), "openapi.B.yaml": OPENAPI("B") });
    expect(await validateOpenApi(set)).toMatchObject({ ok: true, tier: expect.stringContaining("2 files") });
  });

  it("fails the set when any document is invalid, naming the file (not only the first is read)", async () => {
    const set = bundle({ "openapi.A.yaml": OPENAPI("A"), "openapi.B.yaml": BAD_OPENAPI });
    const result = await validateOpenApi(set);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("openapi.B.yaml");
  });
});

describe("validateAvro", () => {
  it("judges a bare schema, and every schema of a set", async () => {
    expect(await validateAvro(AVRO("A"))).toMatchObject({ ok: true, tier: "avsc Type.forSchema" });
    expect(await validateAvro(bundle({ "x.y.A.avsc.json": AVRO("A"), "x.y.B.avsc.json": AVRO("B") }))).toMatchObject({ ok: true, tier: expect.stringContaining("2 files") });
  });

  it("fails the set when any schema is invalid, naming the file", async () => {
    const result = await validateAvro(bundle({ "x.y.A.avsc.json": AVRO("A"), "x.y.B.avsc.json": AVRO("B", "nope") }));
    expect(result.ok).toBe(false);
    expect(result.error).toContain("x.y.B.avsc.json");
    // a file that is not JSON
    expect(await validateAvro(bundle({ "x.y.A.avsc.json": AVRO("A"), "x.y.B.avsc.json": "{ nope" }))).toMatchObject({ ok: false });
  });
});

describe("validateProtobuf", () => {
  it("loads the files together, so an import between them resolves", async () => {
    expect(await validateProtobuf(PROTO_B)).toMatchObject({ ok: true });
    const result = await validateProtobuf(bundle({ "a/A.proto": PROTO_A, "b/B.proto": PROTO_B }));
    expect(result).toMatchObject({ ok: true, tier: expect.stringContaining("2 files") });
  });

  it("fails an import of a file that is not in the set", async () => {
    const result = await validateProtobuf(bundle({ "a/A.proto": PROTO_A }));
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/b\/B\.proto|no such file|illegal path/i);
  });

  it("fails a message that names a type no file defines", async () => {
    const dangling = 'syntax = "proto3";\npackage a;\nmessage A {\n  Nowhere n = 1;\n}\n';
    expect(await validateProtobuf(bundle({ "a/A.proto": dangling, "b/B.proto": PROTO_B }))).toMatchObject({ ok: false });
  });

  it("refuses a file name that leaves the directory", async () => {
    expect(await validateProtobuf(bundle({ "../evil.proto": PROTO_B, "b/B.proto": PROTO_B }))).toMatchObject({ ok: false, error: expect.stringContaining("unsafe file name") });
  });
});
