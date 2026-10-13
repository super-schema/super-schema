import { describe, it, expect } from "vitest";
import { detectFormat } from "@/lib/importers/format-detector";

describe("Format Detector", () => {
  describe("detection by file extension", () => {
    it("detects Avro by .avsc extension", () => {
      expect(detectFormat("{}", "schema.avsc")).toBe("avro");
    });

    it("detects Avro by .avro extension", () => {
      expect(detectFormat("{}", "data.avro")).toBe("avro");
    });

    it("detects BigQuery DDL by .sql extension", () => {
      expect(detectFormat("", "table.sql")).toBe("bigquery-ddl");
    });

    it("detects BigQuery DDL by .ddl extension", () => {
      expect(detectFormat("", "create.ddl")).toBe("bigquery-ddl");
    });

    it("detects Protobuf by .proto extension", () => {
      expect(detectFormat("", "message.proto")).toBe("protobuf");
    });
  });

  describe("detection by content analysis", () => {
    it('detects Avro by content with "type": "record"', () => {
      const content = JSON.stringify({
        type: "record",
        name: "User",
        fields: [{ name: "id", type: "string" }],
      });
      expect(detectFormat(content)).toBe("avro");
    });

    it("detects BigQuery DDL by CREATE TABLE keyword", () => {
      const content = "CREATE TABLE my_dataset.my_table (\n  id INT64\n);";
      expect(detectFormat(content)).toBe("bigquery-ddl");
    });

    it("detects OpenAPI by content (JSON)", () => {
      const content = JSON.stringify({
        openapi: "3.0.0",
        info: { title: "Test", version: "1.0.0" },
        paths: { "/users": {} },
      });
      expect(detectFormat(content)).toBe("openapi");
    });

    it("detects OpenAPI by content (YAML)", () => {
      const content = `openapi: "3.0.0"
info:
  title: Test
  version: "1.0.0"
paths:
  /users: {}
`;
      expect(detectFormat(content)).toBe("openapi");
    });

    it("does not misdetect a plain YAML/JSON object without paths as OpenAPI", () => {
      const content = JSON.stringify({ openapi: "3.0.0", info: {} });
      expect(detectFormat(content)).not.toBe("openapi");
    });

    it('detects Protobuf by syntax = "proto3"', () => {
      const content = 'syntax = "proto3";\nmessage User {}';
      expect(detectFormat(content)).toBe("protobuf");
    });

    it("detects Protobuf by message keyword", () => {
      const content = "message User {\n  string name = 1;\n}";
      expect(detectFormat(content)).toBe("protobuf");
    });

    it("returns null for unrecognizable content", () => {
      expect(detectFormat("this is just plain text")).toBeNull();
    });

    it("returns null for empty content", () => {
      expect(detectFormat("")).toBeNull();
    });

    it("returns null for invalid JSON without record type", () => {
      expect(detectFormat('{"key": "value"}')).toBeNull();
    });
  });

  describe("extension takes precedence over content", () => {
    it("uses extension when provided even if content looks different", () => {
      expect(detectFormat("CREATE TABLE foo ()", "schema.avsc")).toBe("avro");
    });
  });
});
