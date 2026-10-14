import { describe, it, expect } from "vitest";
import { parse } from "yaml";
import { toJson, toYaml } from "@/lib/event-specs/serialize";
import type { JsonObject } from "@/lib/event-specs/types";

describe("serialize", () => {
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
});
