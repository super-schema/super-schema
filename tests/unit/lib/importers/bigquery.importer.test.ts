import { describe, it, expect } from "vitest";
import { parseBigQueryDDL } from "@/lib/importers/bigquery.importer";
import { importSchema } from "@/services/import.service";

describe("BigQuery DDL Importer", () => {
  describe("basic column types", () => {
    it("parses CREATE TABLE with standard BigQuery types", () => {
      const ddl = `CREATE TABLE my_dataset.users (
  id INT64 NOT NULL,
  name STRING,
  email STRING NOT NULL,
  age INT64,
  score FLOAT64,
  active BOOL,
  data BYTES,
  created_at TIMESTAMP
);`;
      const result = parseBigQueryDDL(ddl);
      expect(result.success).toBe(true);
      if (!result.success) return;

      expect(result.data.name).toBe("users");
      expect(result.data.fields).toHaveLength(8);

      // Check specific types
      expect(result.data.fields[0]).toMatchObject({
        name: "id",
        type: "int64",
        nullable: false,
        confidence: "high",
      });
      expect(result.data.fields[1]).toMatchObject({
        name: "name",
        type: "string",
        nullable: true,
      });
      expect(result.data.fields[4]).toMatchObject({
        name: "score",
        type: "float64",
      });
      expect(result.data.fields[5]).toMatchObject({
        name: "active",
        type: "boolean",
      });
      expect(result.data.fields[7]).toMatchObject({
        name: "created_at",
        type: "utcDateTime",
      });
    });

    it("parses DATE, DATETIME, TIME types", () => {
      const ddl = `CREATE TABLE dates (
  birth_date DATE,
  event_time DATETIME,
  duration TIME
);`;
      const result = parseBigQueryDDL(ddl);
      expect(result.success).toBe(true);
      if (!result.success) return;

      expect(result.data.fields[0].type).toBe("plainDate");
      expect(result.data.fields[1].type).toBe("utcDateTime");
      expect(result.data.fields[2].type).toBe("plainTime");
    });

    it("parses NUMERIC and BIGNUMERIC types", () => {
      const ddl = `CREATE TABLE financial (
  amount NUMERIC,
  big_amount BIGNUMERIC
);`;
      const result = parseBigQueryDDL(ddl);
      expect(result.success).toBe(true);
      if (!result.success) return;

      expect(result.data.fields[0].type).toBe("decimal");
      expect(result.data.fields[1].type).toBe("decimal128");
    });
  });

  describe("NOT NULL constraints", () => {
    it("parses NOT NULL constraint correctly", () => {
      const ddl = `CREATE TABLE t (
  required_field STRING NOT NULL,
  optional_field STRING
);`;
      const result = parseBigQueryDDL(ddl);
      expect(result.success).toBe(true);
      if (!result.success) return;

      expect(result.data.fields[0].nullable).toBe(false);
      expect(result.data.fields[1].nullable).toBe(true);
    });
  });

  describe("OPTIONS with descriptions", () => {
    it("parses OPTIONS(description=...) for field descriptions", () => {
      const ddl = `CREATE TABLE t (
  email STRING OPTIONS(description='User email address')
);`;
      const result = parseBigQueryDDL(ddl);
      expect(result.success).toBe(true);
      if (!result.success) return;

      expect(result.data.fields[0].description).toBe("User email address");
    });

    // BigQuery writes its own DDL (SHOW CREATE TABLE, INFORMATION_SCHEMA) with double-quoted strings, and a description may contain a ")".
    it.each([
      [`OPTIONS(description="User email address")`, "User email address"],
      [`OPTIONS(description = "User email address" )`, "User email address"],
      [`OPTIONS(description="Primary key (the order's id)")`, "Primary key (the order's id)"],
      [`OPTIONS(description='Primary key (the order\\'s id)')`, "Primary key (the order's id)"],
      [`OPTIONS(description="Says \\"hi\\"")`, 'Says "hi"'],
      [`OPTIONS(description="User email address", labels=[("a", "b")])`, "User email address"],
    ])("reads the description of %s", (options, expected) => {
      const result = parseBigQueryDDL(`CREATE TABLE t (
  email STRING NOT NULL ${options},
  other INT64
);`);
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data.fields.map((f) => f.name)).toEqual(["email", "other"]);
      expect(result.data.fields[0].description).toBe(expected);
      expect(result.data.fields[0].nullable).toBe(false);
      expect(result.data.fields[1].description).toBeUndefined();
    });
  });

  // The description is a GoogleSQL string literal: escapes, raw strings and triple quotes mean what GoogleSQL says.
  describe("the description as a GoogleSQL string literal", () => {
    const descriptionOf = (options: string) => {
      const result = parseBigQueryDDL(`CREATE TABLE t (\n  c STRING ${options}\n);`);
      expect(result.success).toBe(true);
      if (!result.success) throw new Error("did not parse");
      expect(result.data.fields.map((f) => f.name)).toEqual(["c"]);
      return result.data.fields[0].description;
    };

    it.each([
      [`OPTIONS(description="line1\\nline2")`, "line1\nline2"],
      [`OPTIONS(description="a\\tb\\rc")`, "a\tb\rc"],
      [`OPTIONS(description="back\\\\slash")`, "back\\slash"],
      [`OPTIONS(description='it\\'s')`, "it's"],
      [`OPTIONS(description="q\\"uoted\\" and \\\`tick\\\` and \\?")`, 'q"uoted" and `tick` and ?'],
      [`OPTIONS(description="\\a\\b\\f\\v")`, "\x07\b\f\v"],
      [`OPTIONS(description="\\x41\\X42\\103")`, "ABC"],
      [`OPTIONS(description="caf\\u00e9 \\U0001F600")`, "café 😀"],
    ])("decodes the escapes of %s", (options, expected) => {
      expect(descriptionOf(options)).toBe(expected);
    });

    it("keeps an unknown escape as written (no data is lost)", () => {
      expect(descriptionOf(`OPTIONS(description="a\\dz")`)).toBe("a\\dz");
    });

    it("a raw string (r'...' / R\"...\") keeps its backslashes and a backslash-quote stays two characters", () => {
      expect(descriptionOf(`OPTIONS(description=r"C:\\temp\\n")`)).toBe("C:\\temp\\n");
      expect(descriptionOf(`OPTIONS(description=R'one\\'two')`)).toBe("one\\'two");
    });

    it("a triple-quoted string may hold quotes and parentheses", () => {
      expect(descriptionOf(`OPTIONS(description="""say "hi" (really)""")`)).toBe('say "hi" (really)');
      expect(descriptionOf(`OPTIONS(description='''it's (fine)''')`)).toBe("it's (fine)");
    });

    it("finds the description option itself, not the text of another option's string", () => {
      expect(descriptionOf(`OPTIONS(labels=[("description=trap", "x")], description="real")`)).toBe("real");
      expect(descriptionOf(`OPTIONS(DESCRIPTION = "upper")`)).toBe("upper");
      expect(descriptionOf(`OPTIONS(labels=[("a", "b")])`)).toBeUndefined();
    });

    it("an unterminated literal gives no description (and drops no column)", () => {
      expect(descriptionOf(`OPTIONS(description="never closed)`)).toBeUndefined();
    });

    describe("what a description cannot hold in the database is not kept", () => {
      it("a NUL (written \\0, \\000, \\x00, \\u0000, \\U00000000) is dropped: PostgreSQL text cannot store it", () => {
        expect(descriptionOf(`OPTIONS(description="a\\000b\\x00c\\u0000d\\U00000000e")`)).toBe("abcde");
        expect(descriptionOf(`OPTIONS(description="raw \u0000 in the text")`)).toBe("raw  in the text");
      });

      it("a lone surrogate (an escape of half a pair) becomes U+FFFD; a pair written as two escapes is the character", () => {
        expect(descriptionOf(`OPTIONS(description="a\\ud800b")`)).toBe("a�b");
        expect(descriptionOf(`OPTIONS(description="a\\udc00b")`)).toBe("a�b");
        expect(descriptionOf(`OPTIONS(description="\\ud83d\\ude00")`)).toBe("😀");
        expect(descriptionOf(`OPTIONS(description="\\ud83dx\\ude00")`)).toBe("�x�");
      });
    });

    describe("it is one scan of the text (no restart at every quote)", () => {
      const timed = (options: string) => {
        const started = performance.now();
        const result = parseBigQueryDDL(`CREATE TABLE t (\n  c STRING ${options},\n  d INT64\n);`);
        const elapsed = performance.now() - started;
        expect(result.success).toBe(true);
        return { elapsed, result };
      };

      it.each([
        ["20000 double quotes", `OPTIONS(description=${'"'.repeat(20000)})`],
        ["20000 single quotes", `OPTIONS(description=${"'".repeat(20000)})`],
        ["an unterminated literal followed by 20000 quotes", `OPTIONS(description="${"'".repeat(20000)})`],
        ["20000 raw-string openers", `OPTIONS(${'r"'.repeat(20000)})`],
        ["triple-quote openers that never close", `OPTIONS(${"'''x".repeat(5000)}${"'a".repeat(5000)})`],
        ["an unterminated literal made of 20000 escaped quotes (each quote used to start a scan to the end)", `OPTIONS(a="${'\\"'.repeat(20000)})`],
        ["20000 backslashes inside a literal", `OPTIONS(description="${"\\".repeat(20000)}")`],
        ["20000 option separators", `OPTIONS(${"a=1,".repeat(5000)}description="x")`],
      ])("%s finishes in under 100 ms", (_name, options) => {
        const { elapsed } = timed(options);
        expect(elapsed).toBeLessThan(100);
      });

      it("and still reads what it should, after text that looks like openers", () => {
        const { result } = timed(`OPTIONS(labels=[("k", "'''")], description="after")`);
        if (!result.success) throw new Error("did not parse");
        expect(result.data.fields[0].description).toBe("after");
      });
    });
  });

  describe("precision and scale", () => {
    const fieldOf = (type: string) => {
      const result = parseBigQueryDDL(`CREATE TABLE t (\n  c ${type}\n);`);
      expect(result.success).toBe(true);
      if (!result.success) throw new Error("did not parse");
      return result.data.fields[0];
    };

    it.each([
      ["NUMERIC(12, 2)", "decimal", 12, 2],
      ["NUMERIC(12,2)", "decimal", 12, 2],
      ["BIGNUMERIC(38, 9)", "decimal128", 38, 9],
      ["DECIMAL(5, 1)", "decimal", 5, 1],
      ["BIGDECIMAL(40, 10)", "decimal128", 40, 10],
      // BigQuery: the scale of NUMERIC(p) is 0.
      ["NUMERIC(10)", "decimal", 10, 0],
    ] as const)("%s is a %s of precision %i and scale %i", (type, logical, precision, scale) => {
      const field = fieldOf(type);
      expect(field.type).toBe(logical);
      expect(field.precision).toBe(precision);
      expect(field.scale).toBe(scale);
    });

    it("a NUMERIC with no parameters has neither (the engine's own defaults apply)", () => {
      const field = fieldOf("NUMERIC");
      expect(field.type).toBe("decimal");
      expect(field.precision).toBeUndefined();
      expect(field.scale).toBeUndefined();
    });

    describe("a declaration outside what the type allows is not kept: a plain decimal, and a warning of the import", () => {
      const parsed = (type: string) => {
        const result = parseBigQueryDDL(`CREATE TABLE t (\n  total ${type}\n);`);
        expect(result.success).toBe(true);
        if (!result.success) throw new Error("did not parse");
        return result.data;
      };

      it.each([
        ["NUMERIC(99999999999,2)", "decimal"],
        ["NUMERIC(40, 2)", "decimal"], // above NUMERIC's 38 digits
        ["NUMERIC(10, 10)", "decimal"], // a scale above NUMERIC's 9
        ["NUMERIC(38, 0)", "decimal"], // 38 digits before the point (29 at most)
        ["NUMERIC(5, 6)", "decimal"], // a scale above the precision
        ["NUMERIC(0)", "decimal"],
        ["BIGNUMERIC(77, 2)", "decimal128"],
        ["BIGNUMERIC(76, 39)", "decimal128"],
        [`NUMERIC(${"9".repeat(400)}, 2)`, "decimal"], // beyond a double
      ])("%s", (type, logical) => {
        const entity = parsed(type);
        const field = entity.fields[0];
        expect(field.type).toBe(logical);
        expect(field.precision).toBeUndefined();
        expect(field.scale).toBeUndefined();
        expect(entity.importWarnings).toHaveLength(1);
        expect(entity.importWarnings![0]).toContain('Field "total"');
        expect(entity.importWarnings![0]).toContain("plain decimal");
      });

      it("a valid declaration, and a plain NUMERIC, raise none", () => {
        expect(parsed("NUMERIC(38, 9)").importWarnings ?? []).toEqual([]);
        expect(parsed("BIGNUMERIC(76, 38)").importWarnings ?? []).toEqual([]);
        expect(parsed("NUMERIC").importWarnings ?? []).toEqual([]);
      });

      it("the single-entity import carries the warning to the review (importSchema)", () => {
        const result = importSchema("CREATE TABLE t (\n  total NUMERIC(99999999999,2),\n  id STRING\n);", "bigquery-ddl");
        expect(result.success).toBe(true);
        if (!result.success) return;
        expect(result.data.warnings.filter((w) => w.includes("plain decimal"))).toHaveLength(1);
        expect(result.data.parsedEntity.fields.map((f) => f.name)).toEqual(["total", "id"]);
      });
    });

    it("no other type has any", () => {
      for (const type of ["STRING(36)", "INT64", "FLOAT64", "TIMESTAMP"]) {
        const field = fieldOf(type);
        expect(field.precision, type).toBeUndefined();
        expect(field.scale, type).toBeUndefined();
      }
    });
  });

  describe("table name extraction", () => {
    it("handles project.dataset.table name format", () => {
      const ddl = `CREATE TABLE my_project.my_dataset.my_table (
  id INT64
);`;
      const result = parseBigQueryDDL(ddl);
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data.name).toBe("my_table");
    });

    it("handles simple table name", () => {
      const ddl = `CREATE TABLE simple_table (
  id INT64
);`;
      const result = parseBigQueryDDL(ddl);
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data.name).toBe("simple_table");
    });

    it("handles CREATE OR REPLACE TABLE", () => {
      const ddl = `CREATE OR REPLACE TABLE my_table (
  id INT64
);`;
      const result = parseBigQueryDDL(ddl);
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data.name).toBe("my_table");
    });
  });

  describe("low confidence types", () => {
    it("returns low confidence for STRUCT type", () => {
      const ddl = `CREATE TABLE t (
  metadata STRUCT
);`;
      const result = parseBigQueryDDL(ddl);
      expect(result.success).toBe(true);
      if (!result.success) return;

      expect(result.data.fields[0].type).toBe("object");
      expect(result.data.fields[0].confidence).toBe("low");
    });

    it("returns low confidence for ARRAY type", () => {
      const ddl = `CREATE TABLE t (
  tags ARRAY<STRING>
);`;
      const result = parseBigQueryDDL(ddl);
      expect(result.success).toBe(true);
      if (!result.success) return;

      expect(result.data.fields[0].type).toBe("array");
      expect(result.data.fields[0].confidence).toBe("low");
    });

    it("returns low confidence for GEOGRAPHY type", () => {
      const ddl = `CREATE TABLE t (
  location GEOGRAPHY
);`;
      const result = parseBigQueryDDL(ddl);
      expect(result.success).toBe(true);
      if (!result.success) return;

      expect(result.data.fields[0].confidence).toBe("low");
    });
  });

  describe("error handling", () => {
    it("returns error for DDL without CREATE TABLE", () => {
      const result = parseBigQueryDDL("SELECT * FROM users;");
      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.error.code).toBe("PARSE_ERROR");
    });

    it("returns error for empty DDL", () => {
      const result = parseBigQueryDDL("");
      expect(result.success).toBe(false);
    });
  });

  describe("source format tracking", () => {
    it("sets sourceFormat to bigquery-ddl", () => {
      const ddl = `CREATE TABLE t (id INT64);`;
      const result = parseBigQueryDDL(ddl);
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data.sourceFormat).toBe("bigquery-ddl");
    });

    it("preserves original content", () => {
      const ddl = `CREATE TABLE t (id INT64);`;
      const result = parseBigQueryDDL(ddl);
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data.originalContent).toBe(ddl);
    });
  });
});
