import { describe, it, expect } from "vitest";
import { importSchema, bulkImport } from "@/services/import.service";

describe("Import Service", () => {
  const validAvro = JSON.stringify({
    type: "record",
    name: "User",
    fields: [
      { name: "id", type: "string" },
      { name: "age", type: "int" },
    ],
  });

  const validBigQuery = `CREATE TABLE users (
  id STRING NOT NULL,
  age INT64
);`;

  const validProto = `syntax = "proto3";
message User {
  string id = 1;
  int32 age = 2;
}`;

  describe("importSchema", () => {
    it("routes to Avro parser when format is specified", () => {
      const result = importSchema(validAvro, "avro");
      expect(result.success).toBe(true);
      if (!result.success) return;

      expect(result.data.parsedEntity.sourceFormat).toBe("avro");
      expect(result.data.parsedEntity.name).toBe("User");
      expect(result.data.parsedEntity.fields).toHaveLength(2);
    });

    it("routes to BigQuery parser when format is specified", () => {
      const result = importSchema(validBigQuery, "bigquery-ddl");
      expect(result.success).toBe(true);
      if (!result.success) return;

      expect(result.data.parsedEntity.sourceFormat).toBe("bigquery-ddl");
      expect(result.data.parsedEntity.name).toBe("users");
    });

    it("routes to Protobuf parser when format is specified", () => {
      const result = importSchema(validProto, "protobuf");
      expect(result.success).toBe(true);
      if (!result.success) return;

      expect(result.data.parsedEntity.sourceFormat).toBe("protobuf");
      expect(result.data.parsedEntity.name).toBe("User");
    });

    it("auto-detects Avro format from content", () => {
      const result = importSchema(validAvro);
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data.parsedEntity.sourceFormat).toBe("avro");
    });

    it("auto-detects BigQuery format from content", () => {
      const result = importSchema(validBigQuery);
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data.parsedEntity.sourceFormat).toBe("bigquery-ddl");
    });

    it("auto-detects Protobuf format from content", () => {
      const result = importSchema(validProto);
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data.parsedEntity.sourceFormat).toBe("protobuf");
    });

    it("returns error when format cannot be detected", () => {
      const result = importSchema("just some text");
      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.error.code).toBe("UNKNOWN_FORMAT");
    });

    it("returns warnings for low confidence fields", () => {
      const avroWithBytes = JSON.stringify({
        type: "record",
        name: "Data",
        fields: [{ name: "payload", type: "bytes" }],
      });
      const result = importSchema(avroWithBytes, "avro");
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data.warnings.length).toBeGreaterThan(0);
      expect(result.data.warnings[0]).toContain("low confidence");
    });

    it("returns parse errors from invalid content", () => {
      const result = importSchema("{invalid json", "avro");
      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.error.code).toBe("PARSE_ERROR");
    });
  });

  describe("bulkImport", () => {
    it("processes multiple files and collects results", () => {
      const files = [
        { content: validAvro, filename: "user.avsc" },
        { content: validBigQuery, filename: "orders.sql" },
        { content: validProto, filename: "event.proto" },
      ];

      const result = bulkImport(files);
      expect(result.success).toBe(true);
      if (!result.success) return;

      expect(result.data.parsed).toHaveLength(3);
      expect(result.data.errors).toHaveLength(0);
    });

    it("continues on parse errors and collects error list", () => {
      const files = [
        { content: validAvro, filename: "user.avsc" },
        { content: "invalid content", filename: "bad.txt" },
        { content: validBigQuery, filename: "orders.sql" },
      ];

      const result = bulkImport(files);
      expect(result.success).toBe(true);
      if (!result.success) return;

      expect(result.data.parsed).toHaveLength(2);
      expect(result.data.errors).toHaveLength(1);
      expect(result.data.errors[0].filename).toBe("bad.txt");
    });

    it("handles mixed formats correctly", () => {
      const files = [
        { content: validAvro, filename: "user.avsc" },
        { content: validProto, filename: "event.proto" },
      ];

      const result = bulkImport(files);
      expect(result.success).toBe(true);
      if (!result.success) return;

      expect(result.data.parsed[0].sourceFormat).toBe("avro");
      expect(result.data.parsed[1].sourceFormat).toBe("protobuf");
    });

    it("collects warnings from low confidence mappings", () => {
      const avroWithBytes = JSON.stringify({
        type: "record",
        name: "Data",
        fields: [{ name: "payload", type: "bytes" }],
      });
      const files = [{ content: avroWithBytes, filename: "data.avsc" }];

      const result = bulkImport(files);
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data.warnings.length).toBeGreaterThan(0);
    });

    it("handles empty file list", () => {
      const result = bulkImport([]);
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data.parsed).toHaveLength(0);
      expect(result.data.errors).toHaveLength(0);
    });
  });
});
