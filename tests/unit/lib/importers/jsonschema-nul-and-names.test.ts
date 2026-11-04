import { describe, expect, it } from "vitest";
import { parseJsonSchemaDocument } from "@/lib/importers/jsonschema.importer";

const parse = (raw: string, sourceName?: string) => parseJsonSchemaDocument(raw, undefined, sourceName);

describe("NUL characters in a schema never reach the database", () => {
  it("strips an escaped NUL from enum symbols and descriptions, and says so", () => {
    const raw = '{"type":"string","title":"Signal","description":"a\\u0000b","enum":["X\\u0000Y","Z"]}';
    const r = parse(raw);
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.enums[0].values).toEqual(["XY", "Z"]);
    expect(r.data.enums[0].description).toBe("ab");
    expect(JSON.stringify(r.data)).not.toContain("\\u0000");
    expect(r.data.warnings.join("\n")).toMatch(/NUL/);
  });

  it("leaves a document without NUL untouched and silent", () => {
    const r = parse('{"type":"string","title":"S","enum":["A"]}');
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.warnings.join("\n")).not.toMatch(/NUL/);
  });

  it("does not mistake an escaped backslash followed by u0000 text for a NUL", () => {
    const r = parse('{"type":"string","title":"S","description":"x\\\\u0000y","enum":["A"]}');
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.enums[0].description).toBe("x\\u0000y");
  });
});

describe("names are identifiers", () => {
  const obj = (title: string | undefined) => ({ type: "object", ...(title ? { title } : {}), properties: { a: { type: "string" } } });

  it("a display title becomes a PascalCase identifier when nothing better names it", () => {
    const r = parse(JSON.stringify(obj("Account closed successfully event.")));
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.entities[0].name).toBe("AccountClosedSuccessfullyEvent");
  });

  it("a display title yields to the file name, in PascalCase", () => {
    const r = parse(JSON.stringify(obj("Account closed successfully event.")), "schema/json/account_closed_event.json");
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.entities[0].name).toBe("AccountClosedEvent");
  });

  it("keeps the title as the description when the schema has none", () => {
    const r = parse(JSON.stringify(obj("Account closed successfully event.")));
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.entities[0].description).toBe("Account closed successfully event.");
  });

  it("an identifier title stays as written", () => {
    const r = parse(JSON.stringify(obj("Customer")));
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.entities[0].name).toBe("Customer");
  });

  it("a title with no letters or digits falls back to the default name", () => {
    const r = parse(JSON.stringify(obj("!!!")));
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.entities[0].name).toBe("ImportedEntity");
  });
});
