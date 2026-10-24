import { describe, it, expect } from "vitest";
import { parseBigQueryDDL } from "@/lib/importers/bigquery.importer";

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
