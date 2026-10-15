/**
 * Final review F5, I2: Avro enum symbols must be [A-Za-z_][A-Za-z0-9_]*. The canonical source keeps wire values
 * (`"in-progress"`), the Avro emitter (a separate repo) writes member names as they are, and the AsyncAPI parser then
 * rejects the whole document. The Avro projection renames to the symbol the pipeline always produced, reports the rename
 * and refuses a collision.
 */
import { describe, it, expect, vi, beforeAll } from "vitest";
import { compileEntity } from "@/lib/compiler/compiler.service";
import type { PrismaEntityInput, PrismaFieldInput } from "@/lib/compiler/compiler.service";
import { generateTypeSpec } from "@/lib/compiler/typespec-generator";
import { AVRO_SYMBOL, describeAvroProjection, projectTypeSpecSourceForAvro, toAvroSymbol } from "@/lib/typespec-official/avro-source";
import { assembleAsyncApi3 } from "@/lib/event-specs/assemble";
import { AsyncApiParserValidator } from "@/lib/event-specs/validation/asyncapi-parser-validator";
import type { JsonObject } from "@/lib/event-specs/types";
import { channel, message, operation, spec } from "../event-specs/fixtures/builders";

vi.mock("server-only", () => ({}));

let emitOfficialTypeSpecTargetFromData: typeof import("@/lib/typespec-official/emitter.service").emitOfficialTypeSpecTargetFromData;
beforeAll(async () => {
  ({ emitOfficialTypeSpecTargetFromData } = await import("@/lib/typespec-official/emitter.service"));
});

const entity = (name = "Ticket"): PrismaEntityInput => ({
  id: "e1",
  name,
  description: "",
  status: "DRAFT",
  version: 1,
  domainId: "d1",
  metadata: {},
  domain: { id: "d1", name: "Sales", slug: "sales" },
});

let seq = 0;
const field = (name: string, type = "string", aliases: string[] = []): PrismaFieldInput => ({
  id: `f${seq}`,
  name,
  type,
  precision: null,
  scale: null,
  nullable: false,
  isKey: false,
  fieldNumber: null,
  description: "",
  classification: null,
  aliases,
  decorators: {},
  sortOrder: ++seq,
});

describe("toAvroSymbol", () => {
  it("maps wire values to the symbols the pipeline always produced", () => {
    expect(toAvroSymbol("in-progress")).toBe("in_progress");
    expect(toAvroSymbol("en US")).toBe("en_US");
    expect(toAvroSymbol("1")).toBe("_1");
    expect(toAvroSymbol("")).toBe("_");
    expect(toAvroSymbol("日本語")).toBe("___");
    for (const v of ["in-progress", "en US", "1", "", "a.b", "x/y"]) expect(AVRO_SYMBOL.test(toAvroSymbol(v))).toBe(true);
  });
});

describe("projectTypeSpecSourceForAvro", () => {
  it("renames quoted members to valid symbols and reports each rename", () => {
    const p = projectTypeSpecSourceForAvro('enum Ticket_status {\n  "in-progress",\n  "en US",\n  "1",\n  done,\n}\n');
    expect(p.source).toBe("enum Ticket_status {\n  in_progress,\n  en_US,\n  _1,\n  done,\n}\n");
    expect(p.renames).toEqual([
      { enumName: "Ticket_status", from: "in-progress", to: "in_progress" },
      { enumName: "Ticket_status", from: "en US", to: "en_US" },
      { enumName: "Ticket_status", from: "1", to: "_1" },
    ]);
    expect(p.collisions).toEqual([]);
  });

  it("leaves a valid symbol alone, including a quoted keyword (`model` is a fine Avro symbol)", () => {
    const source = 'enum E {\n  "model",\n  `op`,\n  public,\n  A,\n}\n';
    const p = projectTypeSpecSourceForAvro(source);
    expect(p.source).toBe(source);
    expect(p.renames).toEqual([]);
  });

  it("reports two values that collapse into one symbol as a collision (never silently merged)", () => {
    const p = projectTypeSpecSourceForAvro('enum Ticket_kind {\n  "a-b",\n  "a b",\n  a_b,\n  other,\n}\n');
    expect(p.collisions).toEqual([{ enumName: "Ticket_kind", to: "a_b", from: ["a-b", "a b", "a_b"] }]);
    const d = describeAvroProjection(p);
    expect(d.errors).toEqual([
      'Avro enum Ticket_kind: the values "a-b" and "a b" and "a_b" would all be published as the symbol "a_b" — rename one of them',
    ]);
  });

  it("describes a rename as a warning that names the wire value and the published symbol", () => {
    const d = describeAvroProjection(projectTypeSpecSourceForAvro('enum Ticket_status {\n  "in-progress",\n}\n'));
    expect(d.errors).toEqual([]);
    expect(d.warnings).toEqual([
      'Avro enum symbol "in-progress" of Ticket_status is published as "in_progress" (an Avro symbol must match [A-Za-z_][A-Za-z0-9_]*); consumers must send "in_progress"',
    ]);
  });

  it("handles one-line enums, comments, decorators, backticked and string-valued members", () => {
    const source = [
      "enum A { \"x-y\", ok }",
      "enum B {",
      "  // a comment, with a comma",
      '  @doc("the first, really") "p q",',
      "  `r-s`,",
      '  Named: "in-progress",',
      "  Numbered: 7,",
      "}",
      "",
    ].join("\n");
    const p = projectTypeSpecSourceForAvro(source);
    expect(p.source).toBe(
      [
        "enum A { x_y, ok }",
        "enum B {",
        "  // a comment, with a comma",
        '  @doc("the first, really") p_q,',
        "  r_s,",
        '  Named: "in_progress",',
        "  Numbered: 7,",
        "}",
        "",
      ].join("\n")
    );
    expect(p.renames.map((r) => `${r.enumName}:${r.from}->${r.to}`)).toEqual(["A:x-y->x_y", "B:p q->p_q", "B:r-s->r_s", "B:in-progress->in_progress"]);
  });

  it("does not touch anything that is not an enum body, and is a no-op without enums", () => {
    const source = 'model M {\n  `in-progress`: string;\n  "not an enum": string;\n}\n';
    expect(projectTypeSpecSourceForAvro(source).source).toBe(source);
  });
});

describe("Avro target through the real emitter and the real AsyncAPI parser", () => {
  const fields = () => [field("id"), field("status", "enum", ["in-progress", "en US", "1", "done"])];

  it("publishes valid symbols, flags the rename as a warning, and the AsyncAPI parser accepts the schema", async () => {
    const r = await emitOfficialTypeSpecTargetFromData(entity(), fields(), "avro");
    expect(r.errors).toEqual([]);
    expect(r.validationStatus).toBe("WARNING");
    expect(r.warnings).toHaveLength(3);
    expect(r.warnings.join("\n")).toContain('"in-progress" of Ticket_status is published as "in_progress"');
    expect(r.warnings.join("\n")).toContain('"en US" of Ticket_status is published as "en_US"');
    expect(r.warnings.join("\n")).toContain('"1" of Ticket_status is published as "_1"');

    const schema = JSON.parse(r.output) as { fields: Array<{ name: string; type: { symbols?: string[] } }> };
    const status = schema.fields.find((f) => f.name === "status");
    expect(status?.type.symbols).toEqual(["in_progress", "en_US", "_1", "done"]);

    const avroChannel = channel({ id: "ch", name: "tickets", profile: { format: "avro" } });
    const document = assembleAsyncApi3(
      spec({
        channels: [avroChannel],
        messages: [message({ id: "m", name: "Ticket", payloads: [{ format: "avro", schema: schema as unknown as JsonObject }] })],
        operations: [operation({ key: "publishTicket", channelRef: "ch", messageRefs: ["m"] })],
      })
    ).document;
    const parsed = await new AsyncApiParserValidator().validate(document);
    if (!parsed.success) throw new Error(parsed.error.message);
    expect(parsed.data.filter((d) => d.severity === "error")).toEqual([]);
  }, 180_000);

  it("an entity with no renames stays VALID with no warnings", async () => {
    const r = await emitOfficialTypeSpecTargetFromData(entity(), [field("id"), field("status", "enum", ["OPEN", "DONE"])], "avro");
    expect(r.validationStatus).toBe("VALID");
    expect(r.warnings).toEqual([]);
  }, 120_000);

  it("two values that would collide are an INVALID emission that names the enum", async () => {
    const r = await emitOfficialTypeSpecTargetFromData(entity(), [field("id"), field("kind", "enum", ["a-b", "a b"])], "avro");
    expect(r.validationStatus).toBe("INVALID");
    expect(r.output).toBe("");
    expect(r.errors).toEqual([{ message: 'Avro enum Ticket_kind: the values "a-b" and "a b" would all be published as the symbol "a_b" — rename one of them' }]);
  });

  it("without the projection the same schema is rejected by the parser (what the review reproduced)", async () => {
    // the canonical (unprojected) source straight through the Avro emitter, then the real parser
    const { runTypeSpecEmitterFiles } = await import("@/lib/typespec-official/emitter.service");
    const source = generateTypeSpec(compileEntity(entity(), fields()), { governance: false });
    const files = await runTypeSpecEmitterFiles("@typespec/avro", source, {});
    if (!files.success) throw new Error(files.error.message);
    const schema = JSON.parse(files.data[0].content) as JsonObject;
    const document = assembleAsyncApi3(
      spec({
        channels: [channel({ id: "ch", name: "tickets", profile: { format: "avro" } })],
        messages: [message({ id: "m", name: "Ticket", payloads: [{ format: "avro", schema }] })],
        operations: [operation({ key: "publishTicket", channelRef: "ch", messageRefs: ["m"] })],
      })
    ).document;
    const parsed = await new AsyncApiParserValidator().validate(document);
    if (!parsed.success) throw new Error(parsed.error.message);
    expect(parsed.data.filter((d) => d.severity === "error").length).toBeGreaterThan(0);
  }, 180_000);
});
