import { describe, it, expect } from "vitest";
import { detectFormat, detectFormatDetailed } from "@/lib/importers/format-detector";

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

  // Story 15.6: .json / .yaml / .yml carry several formats, so they are sniffed by content.
  describe(".json / .yaml / .yml files are sniffed by content", () => {
    const avro = JSON.stringify({ type: "record", name: "User", fields: [{ name: "id", type: "string" }] });
    const jsonSchema = JSON.stringify({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: { id: { type: "string" } },
    });
    const openApiYaml = `openapi: "3.1.0"\ninfo:\n  title: T\n  version: "1"\npaths:\n  /a: {}\n`;
    const jsonSchemaYaml = `$schema: https://json-schema.org/draft/2020-12/schema\ntitle: Order\ntype: object\nproperties:\n  id:\n    type: string\n`;

    it("detects Avro in a .json file", () => {
      expect(detectFormat(avro, "user.json")).toBe("avro");
    });

    it("detects JSON Schema in a .json file", () => {
      expect(detectFormat(jsonSchema, "user.schema.json")).toBe("json-schema");
    });

    it("detects OpenAPI in a .yaml / .yml file", () => {
      expect(detectFormat(openApiYaml, "api.yaml")).toBe("openapi");
      expect(detectFormat(openApiYaml, "api.yml")).toBe("openapi");
    });

    it("detects a YAML JSON Schema, with or without a file name", () => {
      expect(detectFormat(jsonSchemaYaml, "order.yml")).toBe("json-schema");
      expect(detectFormat(jsonSchemaYaml)).toBe("json-schema");
      expect(detectFormat("type: object\nproperties:\n  id:\n    type: string\n", "order.yaml")).toBe(
        "json-schema"
      );
    });

    it("does not treat arbitrary YAML as a schema", () => {
      expect(detectFormat("name: my-service\nreplicas: 3\n", "deploy.yaml")).toBeNull();
    });
  });

  // M5: a YAML document over the size cap (512 KiB) is not parsed, so it is "not detected"; the reason (its size) must reach the person, who
  // otherwise reads "could not detect the format" for a perfectly good OpenAPI file.
  describe("a YAML document over the size cap", () => {
    const pad = `# ${"x".repeat(600 * 1024)}\n`;
    const bigOpenApi = `openapi: "3.1.0"\ninfo:\n  title: T\n  version: "1"\npaths:\n  /a: {}\n${pad}`;
    const bigJsonSchema = `$schema: https://json-schema.org/draft/2020-12/schema\ntype: object\nproperties:\n  id:\n    type: string\n${pad}`;

    it("is not detected, and detectFormatDetailed says why (the size limit, in the parser's words)", () => {
      for (const content of [bigOpenApi, bigJsonSchema]) {
        expect(detectFormat(content, "api.yaml")).toBeNull();
        const detailed = detectFormatDetailed(content, "api.yaml");
        expect(detailed.format).toBeNull();
        expect(detailed.reason).toBe("YAML documents are limited to 512 KiB; convert to JSON for larger schemas");
      }
    });

    it("has no reason when the format is detected, nor for content that is simply not a schema", () => {
      expect(detectFormatDetailed(`openapi: "3.1.0"\ninfo:\n  title: T\n  version: "1"\npaths:\n  /a: {}\n`, "a.yaml")).toEqual({ format: "openapi" });
      expect(detectFormatDetailed("name: my-service\nreplicas: 3\n", "deploy.yaml")).toEqual({ format: null });
      expect(detectFormatDetailed("hello", undefined)).toEqual({ format: null });
    });

    it("detectFormat keeps its answer (the detailed one only adds the reason)", () => {
      expect(detectFormat("syntax = \"proto3\";\nmessage A { string a = 1; }\n", "a.proto")).toBe("protobuf");
    });
  });
});
