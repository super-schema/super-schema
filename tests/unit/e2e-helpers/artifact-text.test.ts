/**
 * What the lifecycle specs do with a generated artifact: `canon` (compact JSON of the text, so one spelling of a substring matches JSON
 * or YAML output) and `requiredOf` (the `required` list of the entity's own schema). A multi-file version reaches them as a
 * `===== path =====` bundle, which is not one YAML / JSON document: they must work file by file. The fake bundles have the shape of
 * the `enums` variation of fixtures/jsonschema-variations.ts: the root object's file and a file per inline enum (`<Model>_<field>.json`),
 * as the JSON Schema emitter writes them (one file per declaration, no `bundleId`).
 */
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { bundlePreviewFiles } from "../../e2e/helpers/preview-text";
import { canon, requiredOf, rootFirst } from "../../e2e/helpers/artifact-text";

const SCHEMA = "https://json-schema.org/draft/2020-12/schema";

const TICKET = JSON.stringify(
  {
    $schema: SCHEMA,
    $id: "Ticket.json",
    type: "object",
    properties: {
      ticket_id: { type: "string" },
      state: { $ref: "Ticket_state.json" },
      priority: { type: "integer", minimum: 1, maximum: 3 },
      kind: { $ref: "Ticket_kind.json" },
    },
    required: ["ticket_id", "state"],
  },
  null,
  4,
);
const TICKET_STATE = JSON.stringify({ $schema: SCHEMA, $id: "Ticket_state.json", type: "string", enum: ["new", "in_progress", "done"] }, null, 4);
const TICKET_KIND = JSON.stringify({ $schema: SCHEMA, $id: "Ticket_kind.json", type: "string", enum: ["support"] }, null, 4);

const ENUMS_BUNDLE = bundlePreviewFiles([
  { path: "Ticket.json", content: TICKET },
  { path: "Ticket_kind.json", content: TICKET_KIND },
  { path: "Ticket_state.json", content: TICKET_STATE },
]);

describe("the problem: a bundle is not one document", () => {
  it("YAML cannot parse a multi-file bundle (what `canon` and `requiredOf` used to try)", () => {
    expect(() => parseYaml(ENUMS_BUNDLE)).toThrow();
  });
});

describe("canon", () => {
  it("canonicalizes EACH file of a bundle and joins them: the enum values of the enum file are in it, as compact JSON", () => {
    const out = canon(ENUMS_BUNDLE);

    expect(out).toContain('"enum":["new","in_progress","done"]');
    expect(out).toContain('"in_progress"');
    expect(out).toContain('"required":["ticket_id","state"]');
    expect(out).toContain('"minimum":1');
    // not the raw, indented text
    expect(out).not.toContain("=====");
    expect(out).not.toContain("    ");
  });

  it("a single file is canonicalized exactly as before: JSON as compact JSON, YAML as compact JSON", () => {
    expect(canon(TICKET_KIND)).toBe(JSON.stringify(JSON.parse(TICKET_KIND)));
    expect(canon("openapi: 3.1.0\ninfo:\n  title: T\n")).toBe('{"openapi":"3.1.0","info":{"title":"T"}}');
  });

  it("a file that does not parse stays raw, the others are still canonicalized", () => {
    const out = canon(bundlePreviewFiles([
      { path: "a.proto", content: 'syntax = "proto3";\nmessage A {\n  string id = 1;\n}' },
      { path: "b.json", content: '{ "k": [1, 2] }' },
    ]));

    expect(out).toContain('message A {');
    expect(out).toContain('{"k":[1,2]}');
  });

  it("an artifact that is not parseable at all is returned as it is (as before)", () => {
    expect(canon("CREATE TABLE t (id INT64 NOT NULL);\n: [")).toContain("CREATE TABLE t");
  });
});

describe("rootFirst", () => {
  const files = [
    { path: "Ticket_kind.json", content: "" },
    { path: "Ticket.json", content: "" },
    { path: "Ticket_state.json", content: "" },
  ];

  it("puts the file named after the entity first, the others in their order", () => {
    expect(rootFirst(files, "Ticket").map((f) => f.path)).toEqual(["Ticket.json", "Ticket_kind.json", "Ticket_state.json"]);
  });

  it("matches the last dotted segment of an OpenAPI-style name, directories and spelling aside", () => {
    const named = [
      { path: "openapi.Other.yaml", content: "" },
      { path: "docs/openapi.Sales.Orders.Order.yaml", content: "" },
    ];
    expect(rootFirst(named, "Order")[0].path).toBe("docs/openapi.Sales.Orders.Order.yaml");
    expect(rootFirst([{ path: "line_item.json", content: "" }, { path: "Order.json", content: "" }], "LineItem")[0].path).toBe("line_item.json");
  });

  it("keeps the order when no file is named after the entity (the first file is the root's)", () => {
    expect(rootFirst(files, "Unrelated").map((f) => f.path)).toEqual(files.map((f) => f.path));
  });
});

describe("requiredOf", () => {
  it("finds the required list in the ROOT entity's file of a multi-file JSON Schema (no title, the document IS the model)", () => {
    expect(requiredOf(ENUMS_BUNDLE, "Ticket")).toEqual(["ticket_id", "state"]);
  });

  it("finds it whichever position the root's file has in the bundle", () => {
    const reversed = bundlePreviewFiles([
      { path: "Ticket_state.json", content: TICKET_STATE },
      { path: "Ticket.json", content: TICKET },
    ]);
    expect(requiredOf(reversed, "Ticket")).toEqual(["ticket_id", "state"]);
  });

  it("a single JSON Schema file works as before", () => {
    expect(requiredOf(TICKET, "Ticket")).toEqual(["ticket_id", "state"]);
  });

  it("finds the entity's schema in an OpenAPI document by its key or its title", () => {
    const openapi = [
      "openapi: 3.1.0",
      "components:",
      "  schemas:",
      "    Ticket:",
      "      type: object",
      "      required:",
      "        - ticket_id",
      "      properties:",
      "        ticket_id:",
      "          type: string",
      "    Other:",
      "      required: [x]",
    ].join("\n");
    expect(requiredOf(openapi, "Ticket")).toEqual(["ticket_id"]);
    expect(requiredOf(bundlePreviewFiles([{ path: "openapi.Ticket.yaml", content: openapi }, { path: "openapi.Other.yaml", content: "openapi: 3.1.0" }]), "Ticket")).toEqual(["ticket_id"]);
  });

  it("still reads the older shape (every model under $defs of one document, found by key)", () => {
    const bundled = JSON.stringify({ $defs: { Ticket: { type: "object", required: ["ticket_id"] }, Ticket_state: { enum: ["new"] } } });
    expect(requiredOf(bundled, "Ticket")).toEqual(["ticket_id"]);
  });

  it("is null when the entity's own file has no required list, even if another file of the set has one", () => {
    const noRequired = JSON.stringify({ $schema: SCHEMA, $id: "Ticket.json", type: "object", properties: { id: { type: "string" } } });
    const other = JSON.stringify({ $schema: SCHEMA, $id: "Address.json", type: "object", properties: { city: { type: "string" } }, required: ["city"] });
    expect(requiredOf(bundlePreviewFiles([{ path: "Ticket.json", content: noRequired }, { path: "Address.json", content: other }]), "Ticket")).toBeNull();
  });

  it("is null for an artifact that has no parseable document", () => {
    expect(requiredOf("CREATE TABLE t (\n  id INT64\n) ;: [", "Ticket")).toBeNull();
  });
});
