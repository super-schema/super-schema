// A key the AsyncAPI parser cannot read (`hasOwnProperty`, see `PARSER_UNSAFE_KEYS`) is a reserved name for every local document key:
// the parser of a saved document, slugging, renaming and the importer's key allocation all refuse it, like `constructor`.
import { describe, expect, it } from "vitest";
import { renameKey, slugKey, uniqueKey } from "@/lib/events/document/keys";
import { parseEventDocument } from "@/lib/events/document/parse";
import type { EventDocument } from "@/lib/events/document/types";
import { assignKeys, isUsableKey } from "@/lib/events/import/keys";
import type { ImportWarning } from "@/lib/events/import/types";
import { slice1Minimal } from "./fixtures/slice1-documents";

type Problem = { pointer: string; message: string };
function problemsOf(value: unknown): Problem[] {
  const r = parseEventDocument(value);
  return r.success ? [] : (r.error.details as { problems: Problem[] }).problems;
}
const reserved = (value: unknown, pointer: string): Problem | undefined => problemsOf(value).find((p) => p.pointer === pointer);

function withTraits(): EventDocument {
  const d = slice1Minimal();
  d.traits.push({ key: "Envelope", kind: "MESSAGE", spec: {} });
  return d;
}

describe("parseEventDocument", () => {
  it.each([
    ["a server", "/servers/0/key", (d: EventDocument) => { d.servers[0].key = "hasOwnProperty"; }],
    ["a channel", "/channels/0/key", (d: EventDocument) => { d.channels[0].key = "hasOwnProperty"; }],
    ["a message", "/messages/0/key", (d: EventDocument) => { d.messages[0].key = "hasOwnProperty"; }],
    ["a trait", "/traits/1/key", (d: EventDocument) => { d.traits[1].key = "hasOwnProperty"; }],
    ["an operation", "/operations/0/key", (d: EventDocument) => { d.operations[0].key = "hasOwnProperty"; }],
  ])("a saved document whose %s key is hasOwnProperty comes back as a problem at the key, not a crash", (_what, pointer, change) => {
    const d = withTraits();
    change(d);
    expect(reserved(d, pointer)).toEqual({ pointer, message: 'Key "hasOwnProperty" is reserved — choose another key' });
  });

  it("a security scheme named hasOwnProperty is refused at its pointer", () => {
    const d = slice1Minimal();
    d.components = { securitySchemes: JSON.parse('{"hasOwnProperty":{"type":"plain"}}') as never };
    expect(reserved(d, "/components/securitySchemes/hasOwnProperty")?.message).toBe('Security scheme key "hasOwnProperty" is reserved — choose another key');
  });

  it("the look-alikes are fine, and a padded key is checked trimmed", () => {
    for (const key of ["hasownproperty", "HasOwnProperty", "hasOwnProperty2"]) {
      const d = slice1Minimal();
      d.operations[0].key = key;
      expect(problemsOf(d), key).toEqual([]);
    }
    const d = slice1Minimal();
    d.operations[0].key = "  hasOwnProperty ";
    expect(reserved(d, "/operations/0/key")?.message).toBe('Key "hasOwnProperty" is reserved — choose another key');
  });
});

describe("keys", () => {
  it("slugKey never returns the name, so a title of hasOwnProperty gets a usable key", () => {
    expect(slugKey("hasOwnProperty")).toBe("hasOwnProperty-1");
    expect(slugKey("  hasOwnProperty  ")).toBe("hasOwnProperty-1");
    expect(slugKey("hasOwnProperty 2")).toBe("hasOwnProperty-2");
    expect(slugKey("HasOwnProperty")).toBe("HasOwnProperty");
    expect(uniqueKey(slugKey("hasOwnProperty"), ["hasOwnProperty-1"])).toBe("hasOwnProperty-1-2");
  });

  it("renameKey refuses it, and keeps accepting its look-alikes", () => {
    const d = slice1Minimal();
    expect(renameKey(d, "channel", "orders", "hasOwnProperty")).toMatchObject({ success: false, error: { message: '"hasOwnProperty" is not a valid key' } });
    expect(renameKey(d, "channel", "orders", "hasownproperty").success).toBe(true);
  });
});

describe("the importer's key allocation", () => {
  it("isUsableKey refuses it", () => {
    expect(isUsableKey("hasOwnProperty")).toBe(false);
    expect(isUsableKey("hasOwnProperty2")).toBe(true);
  });

  it("assignKeys gives such a key a generated one, with the usual warning", () => {
    const warnings: ImportWarning[] = [];
    const out = assignKeys([{ id: "a", key: "hasOwnProperty", pointer: "/channels/hasOwnProperty" }], new Set<string>(), "channel", (w) => warnings.push(w));
    expect(out.get("a")).toBe("hasOwnProperty-1");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ code: "KEY_ADJUSTED", pointer: "/channels/hasOwnProperty" });
  });
});
