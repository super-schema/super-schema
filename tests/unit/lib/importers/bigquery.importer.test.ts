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
      // The best of three runs: the first run pays for the JIT, and a garbage collection can take one run's time. A loop that grows faster
      // than the input is still seen: every run pays it.
      // Wall-clock bounds can still fail on a loaded machine (the best of three makes that rare); a super-linear loop fails every run.
      const timed = (options: string) => {
        const sql = `CREATE TABLE t (\n  c STRING ${options},\n  d INT64\n);`;
        let elapsed = Infinity;
        let result = parseBigQueryDDL(sql);
        for (let run = 0; run < 3; run++) {
          const started = performance.now();
          result = parseBigQueryDDL(sql);
          elapsed = Math.min(elapsed, performance.now() - started);
        }
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

  describe("comments outside string literals", () => {
    it("a trailing -- comment on a column line does not drop that column", () => {
      const result = parseBigQueryDDL(`CREATE TABLE orders (
  order_id STRING NOT NULL, -- unique key
  amount NUMERIC(12, 2), -- total in USD, before tax
  created_at TIMESTAMP
);`);
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data.fields.map((f) => f.name)).toEqual(["order_id", "amount", "created_at"]);
      expect(result.data.fields[0]).toMatchObject({ type: "string", nullable: false });
      expect(result.data.fields[1]).toMatchObject({ type: "decimal", precision: 12, scale: 2 });
    });

    it("a comment on the table line, on every column and after the statement imports every column", () => {
      const result = parseBigQueryDDL(`CREATE TABLE t ( -- the table
  a INT64 -- first
  , b STRING -- second
  , c BOOL NOT NULL -- third (a flag)
); -- done`);
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data.fields.map((f) => f.name)).toEqual(["a", "b", "c"]);
      expect(result.data.fields[2]).toMatchObject({ type: "boolean", nullable: false });
    });

    it("a parenthesis, a comma or a quote inside a comment is not DDL", () => {
      const result = parseBigQueryDDL(`CREATE TABLE t (
  a INT64, -- see ) the note
  b STRING, -- it's a "quote, and a comma
  c BOOL
);`);
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data.fields.map((f) => f.name)).toEqual(["a", "b", "c"]);
    });

    it("a -- inside a string default is text, and the comment after the default is still a comment", () => {
      const result = parseBigQueryDDL(`CREATE TABLE t (
  code STRING DEFAULT 'a -- b', -- real comment
  n INT64
);`);
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data.fields.map((f) => f.name)).toEqual(["code", "n"]);
      expect(result.data.fields[0]).toMatchObject({ type: "string", nullable: true });
    });

    it("# and /* */ comments are comments too (a block comment may run over lines)", () => {
      const result = parseBigQueryDDL(`CREATE TABLE t (
  note STRING # free text (not DDL)
  , amount NUMERIC /* money, in USD
  (not DDL either) */ NOT NULL
  , flag BOOL
);`);
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data.fields.map((f) => f.name)).toEqual(["note", "amount", "flag"]);
      expect(result.data.fields[1]).toMatchObject({ type: "decimal", nullable: false });
    });

    it("a comment that names CREATE TABLE before the statement is not the statement", () => {
      const result = parseBigQueryDDL(`-- CREATE TABLE draft (old)
CREATE TABLE real_table (
  id INT64
);`);
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data.name).toBe("real_table");
    });

    describe("it stays linear on comment text", () => {
      // The best of three runs: a garbage collection can take one run's time, a loop that grows faster than the input cannot be hidden.
      // Wall-clock bounds can still fail on a loaded machine (the best of three makes that rare); a super-linear loop fails every run.
      const timed = (sql: string) => {
        let elapsed = Infinity;
        let result = parseBigQueryDDL(sql);
        for (let run = 0; run < 3; run++) {
          const started = performance.now();
          result = parseBigQueryDDL(sql);
          elapsed = Math.min(elapsed, performance.now() - started);
        }
        return { elapsed, result };
      };

      it.each([
        ["20000 line comments, each with a parenthesis and a comma", `${"-- ) ,\n".repeat(20000)}  c INT64`],
        ["20000 block comments", `${"/* a ) , */ ".repeat(20000)}  c INT64`],
        ["an unclosed block comment of 20000 words after a column", `  c INT64 /* ${"word ".repeat(20000)}`],
      ])("%s finishes in under 100 ms and keeps the column", (_name, body) => {
        const { elapsed, result } = timed(`CREATE TABLE t (\n${body}\n);`);
        expect(elapsed).toBeLessThan(100);
        expect(result.success).toBe(true);
        if (!result.success) return;
        expect(result.data.fields.map((f) => f.name)).toEqual(["c"]);
      });
    });
  });

  describe("a backtick-quoted name is a name, not code", () => {
    const namesOf = (ddl: string) => {
      const result = parseBigQueryDDL(ddl);
      expect(result.success).toBe(true);
      if (!result.success) throw new Error("did not parse");
      return result.data.fields.map((f) => f.name);
    };

    // The odd column is not imported (its name is not a plain word, as before), but its neighbours are, and no bogus column appears from its text.
    it.each([
      ["a quote", "`customer's name` STRING,", ["id", "amount"]],
      ["a less-than sign", "`price<usd` NUMERIC,", ["id", "amount"]],
      ["a parenthesis", "`total (usd` NUMERIC,", ["id", "amount"]],
      ["a comment mark #", "`item #` STRING,", ["id", "amount"]],
      ["a comment mark --", "`cost--usd` NUMERIC,", ["id", "amount"]],
      ["a comma", "`a,b` STRING,", ["id", "amount"]],
    ])("a column named with %s does not change the columns around it", (_label, odd, expected) => {
      expect(namesOf(`CREATE TABLE t (\n  id INT64,\n  ${odd}\n  amount NUMERIC\n);`)).toEqual(expected);
    });

    it("a comment mark in a backtick name changes neither the table name nor the columns after it", () => {
      const result = parseBigQueryDDL("CREATE TABLE `proj.ds.orders` (\n  `item #` STRING,\n  qty INT64\n);");
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data.name).toBe("orders");
      expect(result.data.fields.map((f) => f.name)).toEqual(["qty"]);
    });
  });

  describe("the text before CREATE TABLE is not lexed", () => {
    it.each([
      ["prose on its own line", "Here's the table:\nCREATE TABLE t (\n  a STRING DEFAULT 'x', -- note (x)\n  b INT64\n);"],
      ["prose on the same line", "Here's the table: CREATE TABLE t (\n  a STRING DEFAULT 'x', -- note (x)\n  b INT64\n);"],
    ])("an apostrophe in %s does not hide a later comment (every column is kept)", (_label, ddl) => {
      const result = parseBigQueryDDL(ddl);
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data.name).toBe("t");
      expect(result.data.fields.map((f) => f.name)).toEqual(["a", "b"]);
    });

    it("a block comment before the statement that names CREATE TABLE is not the statement", () => {
      const result = parseBigQueryDDL("/*\nCREATE TABLE old_draft (\n  x INT64\n*/\nCREATE TABLE t (\n  id INT64\n);");
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data.name).toBe("t");
      expect(result.data.fields.map((f) => f.name)).toEqual(["id"]);
    });
  });

  describe("a comment mark in prose before CREATE TABLE does not stop the import", () => {
    it.each([
      ["an unclosed slash-star", "Use /* here to start\nCREATE TABLE t (\n  a INT64,\n  b STRING\n);"],
      ["a slash-star that closes only inside the statement", "Exported from path/*.sql\nCREATE TABLE t ( a INT64, b STRING /* note */ );"],
    ])("%s: the table and every column are kept", (_label, ddl) => {
      const result = parseBigQueryDDL(ddl);
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data.name).toBe("t");
      expect(result.data.fields.map((f) => f.name)).toEqual(["a", "b"]);
    });

    it("an unclosed slash-star in prose does not hand the statement to a CREATE TABLE inside a line comment", () => {
      const result = parseBigQueryDDL("-- CREATE TABLE draft (old)\nUse /* here\nCREATE TABLE t (\n  a INT64,\n  b INT64\n);");
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data.name).toBe("t");
      expect(result.data.fields.map((f) => f.name)).toEqual(["a", "b"]);
    });
  });

  describe("an unclosed string literal or backtick name in the column list is reported", () => {
    it("the columns after it are not imported, and the import says so", () => {
      const result = parseBigQueryDDL("CREATE TABLE t (\n  a STRING DEFAULT 'x,\n  b INT64\n);");
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data.fields.map((f) => f.name)).toEqual(["a"]);
      expect(result.data.importWarnings?.join("\n")).toMatch(/not closed/);
    });

    it("an unclosed backtick name keeps the columns before it and says so", () => {
      const result = parseBigQueryDDL("CREATE TABLE t (\n  id INT64,\n  `abc STRING,\n  x INT64\n);");
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data.fields.map((f) => f.name)).toEqual(["id"]);
      expect(result.data.importWarnings?.join("\n")).toMatch(/not closed/);
    });

    it("a closed literal that holds a comma raises no warning", () => {
      const result = parseBigQueryDDL("CREATE TABLE t (\n  a STRING DEFAULT 'x,',\n  b INT64\n);");
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data.fields.map((f) => f.name)).toEqual(["a", "b"]);
      expect(result.data.importWarnings).toBeUndefined();
    });
  });

  describe("a long run of spaces in a type is read in linear time", () => {
    // Wall-clock bound: see the note on the timed helper above (best of three; a super-linear loop fails every run).
    const timed = (sql: string) => {
      let elapsed = Infinity;
      let result = parseBigQueryDDL(sql);
      for (let run = 0; run < 3; run++) {
        const started = performance.now();
        result = parseBigQueryDDL(sql);
        elapsed = Math.min(elapsed, performance.now() - started);
      }
      return { elapsed, result };
    };

    it("10000 spaces inside NUMERIC(12, 2) finish in under 200 ms and keep the precision and scale", () => {
      const { elapsed, result } = timed(`CREATE TABLE t (\n  a NUMERIC(12${" ".repeat(10000)}, 2)\n);`);
      expect(elapsed).toBeLessThan(200);
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data.fields[0]).toMatchObject({ name: "a", precision: 12, scale: 2 });
    });

    it("20000 spaces after an unclosed ARRAY< finish in under 200 ms and the type stays an array", () => {
      const { elapsed, result } = timed(`CREATE TABLE t (\n  a ARRAY<STRING${" ".repeat(20000)}X\n);`);
      expect(elapsed).toBeLessThan(200);
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data.fields[0]).toMatchObject({ name: "a", type: "string", confidence: "low" });
    });
  });

  describe("DEFAULT clauses", () => {
    const columnsOf = (columns: string) => {
      const result = parseBigQueryDDL(`CREATE TABLE t (\n${columns}\n);`);
      expect(result.success).toBe(true);
      if (!result.success) throw new Error("did not parse");
      return result.data.fields;
    };

    it("NOT NULL DEFAULT 0 keeps the type, the confidence and the nullability", () => {
      const [qty] = columnsOf("  qty INT64 NOT NULL DEFAULT 0");
      expect(qty).toMatchObject({ name: "qty", type: "int64", nullable: false, confidence: "high", originalType: "INT64" });
    });

    it("a function default (CURRENT_TIMESTAMP()) keeps the type and the nullability", () => {
      const [ts] = columnsOf("  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP()");
      expect(ts).toMatchObject({ name: "created_at", type: "utcDateTime", nullable: false, originalType: "TIMESTAMP" });
    });

    it("DEFAULT written before NOT NULL is the same column", () => {
      const [qty] = columnsOf("  qty INT64 DEFAULT 0 NOT NULL");
      expect(qty).toMatchObject({ type: "int64", nullable: false });
    });

    it("a default without NOT NULL leaves the column nullable", () => {
      const [qty] = columnsOf("  qty INT64 DEFAULT 0");
      expect(qty).toMatchObject({ type: "int64", nullable: true, confidence: "high" });
    });

    it("a string default keeps the column whatever it holds: a quote, a comma, a parenthesis", () => {
      const fields = columnsOf(`  note STRING DEFAULT 'none',
  label STRING DEFAULT 'a, b (c',
  closing STRING DEFAULT ')',
  quoted STRING DEFAULT "it's, \\"quoted\\"",
  path STRING NOT NULL DEFAULT r'C:\\temp',
  last INT64`);
      expect(fields.map((f) => f.name)).toEqual(["note", "label", "closing", "quoted", "path", "last"]);
      expect(fields.map((f) => [f.type, f.nullable])).toEqual([
        ["string", true],
        ["string", true],
        ["string", true],
        ["string", true],
        ["string", false],
        ["int64", true],
      ]);
    });

    it("a default and an OPTIONS description on the same column", () => {
      const [x] = columnsOf(`  x STRING NOT NULL DEFAULT 'a, (b' OPTIONS(description="the x (not a default)")`);
      expect(x).toMatchObject({ type: "string", nullable: false, description: "the x (not a default)" });
    });

    it("a comparison, an array or a struct in a default does not change the column or the next one", () => {
      const fields = columnsOf(`  flag BOOL DEFAULT 1 < 2 NOT NULL,
  tags ARRAY<STRING> DEFAULT ['a', 'b'],
  point STRUCT<x INT64, y INT64> DEFAULT STRUCT(1, 2),
  n INT64`);
      expect(fields.map((f) => f.name)).toEqual(["flag", "tags", "point", "n"]);
      expect(fields[0]).toMatchObject({ type: "boolean", nullable: false });
      expect(fields[1]).toMatchObject({ type: "array", confidence: "low" });
      expect(fields[2]).toMatchObject({ type: "object", confidence: "low" });
      expect(fields[3]).toMatchObject({ type: "int64", nullable: true });
    });

    it("a typed STRUCT default whose angle brackets hold commas does not split the column", () => {
      const fields = columnsOf("  pt STRUCT<x INT64, y INT64> DEFAULT STRUCT<x INT64, y INT64>(1, 2),\n  n INT64");
      expect(fields.map((f) => f.name)).toEqual(["pt", "n"]);
      expect(fields[0]).toMatchObject({ type: "object", confidence: "low", originalType: "STRUCT<X INT64, Y INT64>" });
      expect(fields[1]).toMatchObject({ type: "int64", nullable: true });
    });

    it("a typed default with a space before its angle bracket, in lower case, is read the same", () => {
      const fields = columnsOf("  pt struct <x INT64, y INT64> default struct<x INT64, y INT64>(1, 2) not null,\n  n INT64");
      expect(fields.map((f) => f.name)).toEqual(["pt", "n"]);
      expect(fields[0]).toMatchObject({ type: "object", nullable: false });
    });

    it("an ARRAY of STRUCT default with brackets and commas keeps the column and its nullability", () => {
      const fields = columnsOf(
        "  tags ARRAY<STRUCT<a INT64, b STRING>> NOT NULL DEFAULT ARRAY<STRUCT<a INT64, b STRING>>[STRUCT<a INT64, b STRING>(1, 'x'), STRUCT<a INT64, b STRING>(2, 'y')],\n  n INT64",
      );
      expect(fields.map((f) => f.name)).toEqual(["tags", "n"]);
      expect(fields[0]).toMatchObject({ type: "array", nullable: false, originalType: "ARRAY<STRUCT<A INT64, B STRING>>" });
      expect(fields[1]).toMatchObject({ type: "int64", nullable: true });
    });

    it("nested angle brackets in a typed default, then NOT NULL, keep the column whole", () => {
      const fields = columnsOf("  s STRUCT<a ARRAY<INT64>, b INT64> DEFAULT STRUCT<a ARRAY<INT64>, b INT64>(ARRAY<INT64>[1, 2], 3) NOT NULL,\n  n INT64");
      expect(fields.map((f) => f.name)).toEqual(["s", "n"]);
      expect(fields[0]).toMatchObject({ type: "object", nullable: false });
    });

    it("comparisons in defaults do not hold later commas open", () => {
      const fields = columnsOf("  lo BOOL DEFAULT 1 < 2,\n  hi BOOL DEFAULT 3 > 2,\n  n INT64");
      expect(fields.map((f) => f.name)).toEqual(["lo", "hi", "n"]);
      expect(fields.map((f) => [f.type, f.nullable])).toEqual([
        ["boolean", true],
        ["boolean", true],
        ["int64", true],
      ]);
    });

    it("a string default on one line does not swallow the column after it", () => {
      const result = parseBigQueryDDL("CREATE TABLE t (a STRING DEFAULT 'x, y', b INT64);");
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data.fields.map((f) => f.name)).toEqual(["a", "b"]);
    });

    it("a clause on the line after the type (a definition over two lines) still applies", () => {
      const [status, other] = columnsOf("  status STRING\n    NOT NULL DEFAULT 'open',\n  other INT64");
      expect(status).toMatchObject({ name: "status", type: "string", nullable: false });
      expect(other).toMatchObject({ name: "other", type: "int64" });
    });

    it("a column whose name is a clause word (OPTIONS and CLUSTER are not reserved) is still a column", () => {
      const fields = columnsOf("  options STRING,\n  cluster BOOL NOT NULL,\n  nested STRUCT<a INT64, b STRING>,\n  n INT64");
      expect(fields.map((f) => f.name)).toEqual(["options", "cluster", "nested", "n"]);
      expect(fields[0]).toMatchObject({ type: "string", nullable: true });
      expect(fields[1]).toMatchObject({ type: "boolean", nullable: false });
      expect(fields[2]).toMatchObject({ type: "object", confidence: "low" });
    });

    it("a column named options followed by a STRUCT keeps its struct whole (its comma is not a separator)", () => {
      const fields = columnsOf("  options STRUCT<a INT64, b STRING>,\n  n INT64");
      expect(fields.map((f) => f.name)).toEqual(["options", "n"]);
    });

    it("a NOT NULL inside a STRUCT type belongs to the struct, not to the column", () => {
      const fields = columnsOf("  s STRUCT<a INT64 NOT NULL, b STRING>,\n  c INT64");
      expect(fields.map((f) => f.name)).toEqual(["s", "c"]);
      expect(fields[0]).toMatchObject({ type: "object", confidence: "low", nullable: true });
    });

    it("the shop sample (ARRAY and STRUCT types with commas, OPTIONS descriptions) imports every column", () => {
      const fields = columnsOf(`  order_id STRING NOT NULL OPTIONS(description="Primary identifier of the order"),
  placed_at TIMESTAMP NOT NULL OPTIONS(description="When the order was placed"),
  total NUMERIC(12, 2) OPTIONS(description="Order total in the shop currency"),
  items ARRAY<STRUCT<sku STRING, qty INT64>> OPTIONS(description="Line items"),
  shipping STRUCT<street STRING, city STRING>,
  tags ARRAY<STRING>`);
      expect(fields.map((f) => f.name)).toEqual(["order_id", "placed_at", "total", "items", "shipping", "tags"]);
      expect(fields[0]).toMatchObject({ type: "string", nullable: false, description: "Primary identifier of the order" });
      expect(fields[2]).toMatchObject({ type: "decimal", precision: 12, scale: 2 });
      expect(fields[3]).toMatchObject({ type: "array", description: "Line items" });
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
