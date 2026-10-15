import { describe, it, expect } from "vitest";
import { parse } from "yaml";
import { assembleAsyncApi3 } from "@/lib/event-specs/assemble";
import { canonicalizeDocumentOrder, toJson, toYaml } from "@/lib/event-specs/serialize";
import type { JsonObject } from "@/lib/event-specs/types";
import { checkoutServiceSpec } from "./fixtures/worked-example";

describe("serialize", () => {
  // C-I3: YAML 1.1 readers (PyYAML, Psych, SnakeYAML 1.1 mode) read `yes` / `no` / `on` / `off` / `y` / `n` as booleans,
  // `12:30` as a sexagesimal int and `2001-01-01` as a date; the keys `no` and `n` even collapse into one.
  describe("YAML 1.1 safety", () => {
    const hostile: JsonObject = {
      asyncapi: "3.0.0",
      info: { title: "yes", version: "1.0", description: "no" },
      channels: {
        no: { address: "on", description: "off" },
        yes: { address: "y" },
        n: { address: "010" },
        N: {},
        Y: {},
        "12:30": { address: "12:30:45" },
        "2001-01-01": { address: "2001-01-01" },
        "1_000": {},
        "0b11": {},
        "0x1f": {},
        "1e3": {},
        null: { address: "~" },
      },
    };

    it("quotes every key and value a YAML 1.1 parser would misread", () => {
      const yaml = toYaml(hostile);
      expect(yaml).toContain("title: 'yes'");
      expect(yaml).toContain("description: 'no'");
      expect(yaml).toContain("'no':");
      expect(yaml).toContain("'yes':");
      expect(yaml).toContain("'n':");
      expect(yaml).toContain("address: 'on'");
      expect(yaml).toContain("description: 'off'");
      expect(yaml).toContain("address: 'y'");
      expect(yaml).toContain("'12:30':");
      expect(yaml).toContain("address: '12:30:45'");
      expect(yaml).toContain("'2001-01-01':");
      // no %YAML directive: the text stays a plain YAML document
      expect(yaml).not.toContain("%YAML");
    });

    it("round-trips unchanged under a YAML 1.1 core-schema reader, and under 1.2", () => {
      const yaml = toYaml(hostile);
      expect(parse(yaml, { version: "1.1" })).toEqual(hostile);
      expect(parse(yaml, { version: "1.2" })).toEqual(hostile);
    });

    it("is deterministic and leaves ordinary documents (including the worked example) byte-stable", () => {
      expect(toYaml(hostile)).toBe(toYaml(structuredClone(hostile)));
      const assembled = assembleAsyncApi3(checkoutServiceSpec).document;
      const yaml = toYaml(assembled);
      expect(parse(yaml, { version: "1.1" })).toEqual(assembled);
      expect(yaml).toBe(toYaml(assembled));
    });
  });

  it("writes 2-space JSON with a trailing newline, preserving key order", () => {
    expect(toJson({ b: 1, a: { d: true, c: null } })).toBe(
      '{\n  "b": 1,\n  "a": {\n    "d": true,\n    "c": null\n  }\n}\n',
    );
  });

  it("writes YAML with single quotes, no anchors and no line folding", () => {
    const shared: JsonObject = { type: "string" };
    const long = "x".repeat(120);
    const doc: JsonObject = {
      info: { version: "2.0", description: long },
      a: { $ref: "#/components/messages/M" },
      k1: shared,
      k2: shared,
    };
    const yaml = toYaml(doc);
    expect(yaml).toBe(
      [
        "info:",
        "  version: '2.0'",
        `  description: ${long}`,
        "a:",
        "  $ref: '#/components/messages/M'",
        "k1:",
        "  type: string",
        "k2:",
        "  type: string",
        "",
      ].join("\n"),
    );
    expect(yaml).not.toContain("&");
    expect(parse(yaml)).toEqual(doc);
  });

  it("renders .proto payload text as a literal block that round-trips", () => {
    const proto = 'syntax = "proto3";\n\n// @RootNode\nmessage Order {\n  string id = 1;\n}\n';
    const yaml = toYaml({ schema: proto });
    expect(yaml.startsWith("schema: |")).toBe(true);
    expect(parse(yaml)).toEqual({ schema: proto });
  });

  describe("canonicalizeDocumentOrder", () => {
    // Postgres jsonb stores object keys shortest-first, then bytewise.
    const jsonbOrder = (value: JsonObject): JsonObject =>
      Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.length - b.length || (a < b ? -1 : 1)));

    it("restores the assembler's top-level and info order after a jsonb round trip; unknown keys follow", () => {
      const assembled = assembleAsyncApi3(checkoutServiceSpec).document;
      const scrambled = jsonbOrder({ ...assembled, info: jsonbOrder(assembled.info as JsonObject), "x-extra": { b: 1 } });
      expect(Object.keys(scrambled)).not.toEqual(Object.keys(assembled)); // the fixture really is out of order

      const canonical = canonicalizeDocumentOrder(scrambled);
      expect(Object.keys(canonical)).toEqual([...Object.keys(assembled), "x-extra"]);
      expect(Object.keys(canonical.info as JsonObject)).toEqual(Object.keys(assembled.info as JsonObject));
      expect(canonical).toEqual(scrambled); // order only: same content
    });

    it("leaves an already canonical assembler document untouched (pins the order lists to assemble.ts)", () => {
      const assembled = assembleAsyncApi3(checkoutServiceSpec).document;
      expect(toJson(canonicalizeDocumentOrder(assembled))).toBe(toJson(assembled));
      const withDefaults = assembleAsyncApi3({
        ...checkoutServiceSpec,
        defaultContentType: "application/json",
        info: { title: "t", version: "1", description: "d", contact: { name: "c" }, license: { name: "l" }, tags: [{ name: "x" }], externalDocs: { url: "https://x" } },
      }).document;
      expect(toJson(canonicalizeDocumentOrder(withDefaults))).toBe(toJson(withDefaults));
    });

    it("does not mutate its input and tolerates a non-object info", () => {
      const input: JsonObject = { components: {}, info: "oops", asyncapi: "3.0.0" };
      const out = canonicalizeDocumentOrder(input);
      expect(Object.keys(input)).toEqual(["components", "info", "asyncapi"]);
      expect(Object.keys(out)).toEqual(["asyncapi", "info", "components"]);
    });
  });
});
