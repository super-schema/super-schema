import { describe, it, expect } from "vitest";
import type { LogicalType, SuperSchemaField, SuperSchemaModel } from "@/types/super-schema-model";
import { buildDbTypeSpecTarget } from "@/lib/typespec-official/db-source";
import { columnNote, emittedColumnType, tableComment, tableNotes } from "@/lib/typespec-official/db-column-types";
import { unescapeTypeSpecText } from "@/lib/compiler/typespec-identifiers";

/**
 * Table notes: what the DDL cannot say about a column (a decimal's precision and scale, a url stored as text, ...) goes
 * into the table's comment: the description on the first line, then `Notes:` and one `- <note>` line per note. The wording,
 * the placement, the size cut, and that the notes hold no user text but a plain identifier.
 */

/** Characters by code point (this file keeps invisible and control characters out of its source). */
const chars = (...codes: number[]): string => String.fromCharCode(...codes);

function field(overrides: Partial<SuperSchemaField> & { name: string; type: LogicalType }): SuperSchemaField {
  return { id: `f-${overrides.name}`, nullable: true, isKey: false, sortOrder: 1, description: "", aliases: [], decorators: {}, ...overrides } as SuperSchemaField;
}

function model(fields: SuperSchemaField[], description = ""): SuperSchemaModel {
  return { namespace: "", entity: { name: "Transaction", description, domain: "payments", metadata: {} }, fields } as unknown as SuperSchemaModel;
}

const KEY = field({ name: "transactionId", type: "string", isKey: true, nullable: false, sortOrder: 0 });
const TARGETS = [
  { target: "spanner", dialect: "spanner", where: "Cloud Spanner", text: "STRING(MAX)" },
  { target: "postgresql", dialect: "postgres", where: "PostgreSQL", text: "TEXT" },
  { target: "bigquery", dialect: "bigquery", where: "BigQuery", text: "STRING" },
] as const;

/** The table's `@doc` text as the emitter receives it (the TypeSpec string unescaped: real line breaks), or null when the model has no table doc. */
function tableDoc(fields: SuperSchemaField[], target: string, description = ""): string | null {
  const source = buildDbTypeSpecTarget(model(fields, description), target).source;
  const match = source.match(/^@doc\("(.*)"\)\n(?:@rowDeletionPolicy.*\n)?model /m);
  return match ? unescapeTypeSpecText(match[1]) : null;
}

describe.each(TARGETS)("table notes: $target", ({ target, dialect, where, text }) => {
  const note = (f: SuperSchemaField, column = f.name) => columnNote(dialect, where, column, f);

  it("a decimal with precision and scale says what the DDL type is and what it does not keep", () => {
    const amount = field({ name: "amount", type: "decimal", precision: 19, scale: 4 });
    const expected =
      dialect === "postgres"
        ? "amount: declared decimal(19,4); the DDL type is NUMERIC and does not enforce precision or scale"
        : `amount: declared decimal(19,4); the DDL type is NUMERIC, which ${where} fixes at precision 38 and scale 9`;
    expect(note(amount)).toBe(expected);
    expect(note(field({ name: "n", type: "numeric", precision: 10, scale: 2 }))).toContain("declared numeric(10,2);");
    expect(note(field({ name: "d", type: "decimal128", precision: 34, scale: 6 }))).toContain("declared decimal128(34,6);");
  });

  it("a decimal that declared only a precision or only a scale says so; one that declared neither has nothing to note", () => {
    expect(note(field({ name: "p", type: "decimal", precision: 12 }))).toContain("declared decimal(12);");
    expect(note(field({ name: "s", type: "decimal", scale: 3 }))).toContain("declared decimal(scale 3);");
    expect(note(field({ name: "none", type: "decimal" }))).toBeNull();
    expect(note(field({ name: "nulls", type: "decimal", precision: null as unknown as undefined, scale: null as unknown as undefined }))).toBeNull();
  });

  it("an array of decimals reads the element's precision and scale and names the array type", () => {
    const prices = field({ name: "prices", type: "array", complexType: { arrayElementType: "decimal", arrayElementPrecision: 9, arrayElementScale: 2 } as SuperSchemaField["complexType"] });
    const printed = dialect === "postgres" ? "NUMERIC[]" : "ARRAY<NUMERIC>";
    expect(note(prices)).toContain(`prices: declared decimal(9,2)[]; the DDL type is ${printed}`);
    expect(note(field({ name: "plain", type: "array", complexType: { arrayElementType: "decimal" } as SuperSchemaField["complexType"] }))).toBeNull();
  });

  it.each(["url", "plainTime", "duration", "enum", "reference", "map", "object"] as const)("%s is declared as such and stored as text", (type) => {
    expect(note(field({ name: "x", type }))).toBe(`x: declared ${type}; stored as ${text}`);
  });

  it("an array of text-stored elements, and an array with no element type, are stored as an array of text", () => {
    const array = (arrayElementType?: string) => field({ name: "xs", type: "array", complexType: arrayElementType ? ({ arrayElementType } as SuperSchemaField["complexType"]) : undefined });
    const printed = dialect === "postgres" ? `${text}[]` : `ARRAY<${text}>`;
    expect(note(array("duration"))).toBe(`xs: declared duration[]; stored as ${printed}`);
    expect(note(array("enum"))).toBe(`xs: declared enum[]; stored as ${printed}`);
    expect(note(array())).toBe(`xs: declared array; stored as ${printed}`);
    expect(note(array("string"))).toBeNull();
    expect(note(array("integer"))).toBeNull();
  });

  it.each([
    ["a hostile string", "foo bar */ -- x ${y} 'q' \"dq\" \\"],
    ["a name from Object.prototype", "constructor"],
    ["__proto__", "__proto__"],
    ["a number", 42],
    ["an object", { kind: "[object Object]" }],
    ["an empty string", ""],
    ["a type that is not one of the builder's", "array"],
  ])("an array whose element type is %s (client data, unvalidated) says `array` and never prints it", (_label, element) => {
    const xs = field({ name: "xs", type: "array", complexType: { arrayElementType: element } as unknown as SuperSchemaField["complexType"] });
    const printed = dialect === "postgres" ? `${text}[]` : `ARRAY<${text}>`;

    expect(note(xs)).toBe(`xs: declared array; stored as ${printed}`);
    expect(emittedColumnType(dialect, xs)).toBe(printed);
  });

  it("a field type that is none of the builder's is `unknown`, never printed", () => {
    const odd = field({ name: "x", type: "foo bar */ -- x" as unknown as LogicalType });
    expect(note(odd)).toBe(`x: declared unknown; stored as ${text}`);
  });

  it("a url that declared a maximum length loses it (only a string's is passed on): the note says so", () => {
    const url = field({ name: "site", type: "url", decorators: { typespec: { validation: { maxLength: 255 } } } });
    expect(note(url)).toBe(`site: declared url with maximum length 255; stored as ${text}, which does not carry the maximum length`);
  });

  it("a string with a maximum length keeps it in the DDL type, so there is nothing to note", () => {
    const code = field({ name: "code", type: "string", decorators: { typespec: { validation: { maxLength: 50 } } } });
    expect(note(code)).toBeNull();
    expect(emittedColumnType(dialect, code)).toBe(dialect === "postgres" ? "VARCHAR(50)" : "STRING(50)");
  });

  it("an offsetDateTime keeps the instant but not the offset; a unixTimestamp32 is a plain integer", () => {
    const stamp = dialect === "postgres" ? "TIMESTAMPTZ" : "TIMESTAMP";
    const integer = dialect === "postgres" ? "INTEGER" : "INT64";
    expect(note(field({ name: "at", type: "offsetDateTime" }))).toBe(`at: declared offsetDateTime; stored as ${stamp}, which keeps the instant but not the UTC offset`);
    expect(note(field({ name: "ts", type: "unixTimestamp32" }))).toBe(`ts: declared unixTimestamp32; stored as ${integer}, a plain number without a date or time type`);
  });

  it("an unsigned integer is noted where the DDL type tops out lower, and nowhere else", () => {
    const big = dialect === "postgres" ? "BIGINT" : "INT64";
    expect(note(field({ name: "u64", type: "uint64" }))).toBe(`u64: declared uint64; stored as ${big}, which cannot hold values above 9223372036854775807`);
    const u32 = note(field({ name: "u32", type: "uint32" }));
    const u16 = note(field({ name: "u16", type: "uint16" }));
    if (dialect === "postgres") {
      expect(u32).toBe("u32: declared uint32; stored as INTEGER, which cannot hold values above 2147483647");
      expect(u16).toBe("u16: declared uint16; stored as SMALLINT, which cannot hold values above 32767");
    } else {
      expect(u32).toBeNull();
      expect(u16).toBeNull();
    }
    expect(note(field({ name: "u8", type: "uint8" }))).toBeNull();
  });

  it("notes nothing for a type the DDL states as declared (or in a wider type)", () => {
    const plain: LogicalType[] = ["string", "integer", "int8", "int16", "int32", "int64", "safeint", "numeric", "float", "float32", "float64", "boolean", "bytes", "plainDate", "utcDateTime"];
    for (const type of plain) expect(note(field({ name: "x", type })), type).toBeNull();
  });

  it("names the column as the DDL has it, and the field's own name too when it differs and is a plain identifier", () => {
    const f = (name: string) => field({ name, type: "duration" });
    const built = buildDbTypeSpecTarget(model([KEY, f("orderTotal"), f("plain"), f("café"), f("my field"), f("a-b")]), target);
    const doc = tableDoc([KEY, f("orderTotal"), f("plain"), f("café"), f("my field"), f("a-b")], target) ?? "";

    expect(built.errors).toEqual([]);
    expect(doc).toContain(`order_total (orderTotal): declared duration; stored as ${text}`);
    expect(doc).toContain(`plain: declared duration; stored as ${text}`);
    // not plain identifiers: only the column the DDL has
    expect(doc).toContain(`caf: declared duration; stored as ${text}`);
    expect(doc).toContain(`my_field: declared duration; stored as ${text}`);
    expect(doc).toContain(`a_b: declared duration; stored as ${text}`);
    expect(doc).not.toContain("café");
    expect(doc).not.toContain("a-b");
  });

  it("puts `Notes:` and one `- <note>` line per note after the entity description, in column order", () => {
    const fields = [KEY, field({ name: "amount", type: "decimal", precision: 19, scale: 4, sortOrder: 1 }), field({ name: "site", type: "url", sortOrder: 2 })];
    const doc = tableDoc(fields, target, "A payment transaction");
    const amount = note(fields[1]);
    expect(doc).toBe(`A payment transaction\nNotes:\n- ${amount}\n- site: declared url; stored as ${text}`);
  });

  it("with no description the first line is `Notes:`; with a description and no note it is the description alone; with neither there is no table doc", () => {
    const lossy = [KEY, field({ name: "site", type: "url", sortOrder: 1 })];
    const plain = [KEY, field({ name: "name", type: "string", sortOrder: 1 })];
    expect(tableDoc(lossy, target)).toBe(`Notes:\n- site: declared url; stored as ${text}`);
    expect(tableDoc(plain, target, "Just text")).toBe("Just text");
    expect(tableDoc(plain, target)).toBeNull();
    expect(buildDbTypeSpecTarget(model(plain), target).source).not.toContain("@doc");
  });

  it("writes the line breaks of the table doc as TypeSpec escapes: the source line is one line, the emitter gets real line breaks", () => {
    const source = buildDbTypeSpecTarget(model([KEY, field({ name: "site", type: "url", sortOrder: 1 })], "Text"), target).source;
    expect(source).toContain(`@doc("Text\\nNotes:\\n- site: declared url; stored as ${text}")\nmodel Transaction {`);
  });

  it("adds no warning for a noted column: the comment is the mechanism", () => {
    const fields = [KEY, field({ name: "amount", type: "decimal", precision: 19, scale: 4, sortOrder: 1 }), field({ name: "site", type: "url", sortOrder: 2 }), field({ name: "u", type: "uint64", sortOrder: 3 })];
    expect(buildDbTypeSpecTarget(model(fields), target).warnings).toEqual([]);
  });

  it("keeps the identifier warnings, and the note names the column the DDL has", () => {
    const fields = [KEY, field({ name: "Order", type: "duration", sortOrder: 1 })];
    const built = buildDbTypeSpecTarget(model(fields), target);
    expect(built.warnings.some((w) => w.startsWith('The column "order" is a reserved word'))).toBe(true);
    expect(tableDoc(fields, target)).toContain(`order (Order): declared duration; stored as ${text}`);
  });

  it("holds nothing the user typed except a plain identifier: quotes, markup and line breaks in a field name or description never reach the notes", () => {
    const hostile = ['a"b; Notes: x', "x */ y", "it's ${x}", "line\nbreak", "tab\tname", "back\\slash"];
    const fields = [KEY, ...hostile.map((name, i) => field({ name, type: "duration", sortOrder: i + 1, description: `desc ${name}` }))];
    const doc = tableDoc(fields, target) ?? "";

    expect(doc).not.toMatch(/["'*\\$\t]/);
    expect(doc.match(/Notes:/g)).toHaveLength(1);
    expect(doc).not.toContain("desc");
    // `Notes:`, then only `- <column>: ...` lines
    const [head, ...lines] = doc.split("\n");
    expect(head).toBe("Notes:");
    expect(lines).toHaveLength(hostile.length);
    for (const line of lines) expect(line).toMatch(/^- [a-z0-9_]+: declared duration; stored as /);
  });
});

describe("tableComment: lines and the size cut", () => {
  /** The length of the block as the emitters write it: the lines from `Notes:` on, joined by line breaks. */
  const blockOf = (comment: string): string => comment.slice(comment.indexOf("Notes:"));

  it("is the description, `Notes:`, and one `- ` line per note, joined by real line breaks", () => {
    expect(tableComment("A payment transaction", ["a: declared url; stored as TEXT", "b: declared duration; stored as TEXT"])).toBe(
      "A payment transaction\nNotes:\n- a: declared url; stored as TEXT\n- b: declared duration; stored as TEXT",
    );
    expect(tableComment(null, ["a: x"])).toBe("Notes:\n- a: x");
  });

  it("cuts the notes block at 2,000 characters on a whole-note boundary, ends `- ...and N more.`, and keeps the most notes that fit", () => {
    const notes = Array.from({ length: 300 }, (_, i) => `col_${i}: declared duration; stored as TEXT`);
    const comment = tableComment(null, notes) ?? "";

    expect(comment.length).toBeLessThanOrEqual(2000);
    const lines = comment.split("\n");
    expect(lines[0]).toBe("Notes:");
    const kept = lines.length - 2;
    expect(lines.slice(1, -1)).toEqual(notes.slice(0, kept).map((note) => `- ${note}`));
    expect(lines[lines.length - 1]).toBe(`- ...and ${300 - kept} more.`);
    // one more note would not have fit with the shorter tail
    const oneMore = ["Notes:", ...notes.slice(0, kept + 1).map((note) => `- ${note}`), `- ...and ${300 - kept - 1} more.`].join("\n");
    expect(oneMore.length).toBeGreaterThan(2000);
  });

  it("is never cut when the block fits exactly, and cut by one note when it is one character over", () => {
    const sized = (length: number) => "n".repeat(length);
    // `Notes:` (6) + `\n- ` (3) + a + `\n- ` (3) + b = 12 + a + b
    const exact = [sized(994), sized(994)];
    expect(tableComment(null, exact)).toBe(`Notes:\n- ${exact[0]}\n- ${exact[1]}`);
    expect(tableComment(null, exact)?.length).toBe(2000);
    expect(tableComment(null, [sized(994), sized(995)])).toBe(`Notes:\n- ${sized(994)}\n- ...and 1 more.`);
  });

  it("a first note that alone is over the limit leaves `Notes:` and `- ...and N more.`", () => {
    expect(tableComment(null, ["x".repeat(2500), "short"])).toBe("Notes:\n- ...and 2 more.");
  });

  it("the description is on its own first line and is never cut; the limit counts the notes block only", () => {
    const notes = Array.from({ length: 300 }, (_, i) => `col_${i}: declared url; stored as TEXT`);
    const description = "A long description. ".repeat(150).trim();
    const comment = tableComment(description, notes) ?? "";

    expect(comment.split("\n")[0]).toBe(description);
    expect(comment.split("\n")[1]).toBe("Notes:");
    expect(blockOf(comment).length).toBeLessThanOrEqual(2000);
    expect(comment.length).toBeGreaterThan(2000);
  });

  it("returns the description alone, or null, when there are no notes", () => {
    expect(tableComment("text", [])).toBe("text");
    expect(tableComment(null, [])).toBeNull();
  });
});

describe.each(TARGETS)("descriptions: control characters are taken out ($target)", ({ target }) => {
  const entityDoc = (description: string) => tableDoc([KEY], target, description);
  const columnDoc = (description: string) => {
    const source = buildDbTypeSpecTarget(model([{ ...KEY, description }]), target).source;
    return source.match(/@doc\("(.*)"\) transactionId/)?.[1] ?? null;
  };

  it("strips NUL, the other C0 controls (not tab), DEL and the bidirectional controls, keeps a tab", () => {
    const typed = `a${chars(0)}b${chars(1, 8, 0x0e, 0x1f)}c${chars(0x7f)}d${chars(0x202a, 0x202b, 0x202c, 0x202d, 0x202e)}e${chars(0x2066, 0x2067, 0x2068, 0x2069)}f\tg`;
    expect(entityDoc(typed)).toBe("abcdef\tg");
    expect(columnDoc(typed)).toBe("abcdef\\tg");
  });

  it("leaves no doc at all for a description that is only control characters, whitespace and line breaks", () => {
    for (const typed of [chars(0, 1, 2), ` ${chars(0)} \n${chars(0x202e)}\t`, chars(0x7f, 0x2066, 0x2069)]) {
      expect(entityDoc(typed), JSON.stringify(typed)).toBeNull();
      expect(columnDoc(typed), JSON.stringify(typed)).toBeNull();
    }
  });

  it("flattens the line breaks first, so a CR, LF, VT or FF is a space and not a missing separator", () => {
    expect(entityDoc(`a\rb\nc${chars(0x0b)}d${chars(0x0c)}e`)).toBe("a b c d e");
  });
});

describe("which logical types get a note", () => {
  const ALL: LogicalType[] = [
    "string", "url", "integer", "int8", "int16", "int32", "int64", "safeint", "uint8", "uint16", "uint32", "uint64", "numeric",
    "float", "float32", "float64", "decimal", "decimal128", "boolean", "bytes", "plainDate", "plainTime", "utcDateTime",
    "offsetDateTime", "duration", "unixTimestamp32", "enum", "map", "object", "reference",
  ];
  const LOSSY_EVERYWHERE = new Set<string>(["url", "plainTime", "duration", "enum", "map", "object", "reference", "unixTimestamp32", "offsetDateTime", "uint64"]);

  it.each(TARGETS)("$target: exactly the types the DDL cannot state, as a scalar and as an array element", ({ dialect, where }) => {
    const expected = (type: string) => LOSSY_EVERYWHERE.has(type) || (dialect === "postgres" && (type === "uint32" || type === "uint16"));
    const withNote = (fields: SuperSchemaField[]) => tableNotes(dialect, where, fields.map((f) => ({ column: f.name, field: f }))).map((n) => n.split(":")[0]);

    const scalars = ALL.map((type) => field({ name: `s_${type}`, type }));
    const arrays = ALL.map((type) => field({ name: `a_${type}`, type: "array", complexType: { arrayElementType: type } as SuperSchemaField["complexType"] }));

    expect(withNote(scalars)).toEqual(ALL.filter(expected).map((type) => `s_${type}`));
    // an array of a text-stored type is noted too, and so is an array of any other lossy element
    expect(withNote(arrays)).toEqual(ALL.filter(expected).map((type) => `a_${type}`));
  });
});

describe("tableNotes", () => {
  it("lists a note per lossy column, in the order given, skipping the others", () => {
    const columns = [
      { column: "id", field: field({ name: "id", type: "string" }) },
      { column: "amount", field: field({ name: "amount", type: "decimal", precision: 19, scale: 4 }) },
      { column: "name", field: field({ name: "name", type: "string" }) },
      { column: "site", field: field({ name: "site", type: "url" }) },
    ];
    expect(tableNotes("postgres", "PostgreSQL", columns)).toEqual([
      "amount: declared decimal(19,4); the DDL type is NUMERIC and does not enforce precision or scale",
      "site: declared url; stored as TEXT",
    ]);
  });
});
