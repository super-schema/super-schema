// tests/unit/lib/events/import/prototype-keys.test.ts
// A key that is the name of an `Object.prototype` property must never reach the AsyncAPI parser unless the parser copes with it. The probe
// behind `PARSER_UNSAFE_KEYS` (own-property.ts) ran every one of these names as a key in 34 places of a valid document; only `hasOwnProperty`
// crashed ("target.hasOwnProperty is not a function"). This sweep keeps the list honest: a parser upgrade that starts to crash on another
// name fails here, and so does a name that is refused although the parser would have read it.
import { describe, expect, it } from "vitest";
import { createAsyncApiParser } from "@/lib/event-specs/validation/asyncapi-parser-validator";
import { parseAsyncApiSource } from "@/lib/events/import/source";

const NAMES = Object.getOwnPropertyNames(Object.prototype);

/** One valid document (JSON text) with `name` as a key in a payload property and in an `x-` map. */
const documentWith = (name: string): string => `{
  "asyncapi": "3.0.0",
  "info": { "title": "Probe", "version": "1.0.0" },
  "channels": { "orders": { "address": "orders.v1", "messages": { "created": { "$ref": "#/components/messages/created" } } } },
  "operations": { "sendCreated": { "action": "send", "channel": { "$ref": "#/channels/orders" }, "messages": [{ "$ref": "#/channels/orders/messages/created" }] } },
  "x-ext": { "${name}": 1 },
  "components": { "messages": { "created": { "payload": { "type": "object", "properties": { "${name}": { "type": "string" }, "id": { "type": "string" } } } } } }
}`;

describe("every name of Object.prototype as a document key", () => {
  it("is either refused by the source reader or read by the AsyncAPI parser without a crash", async () => {
    const parser = createAsyncApiParser();
    const refused: string[] = [];
    const read: string[] = [];
    for (const name of NAMES) {
      const parsed = parseAsyncApiSource(documentWith(name));
      if (!parsed.success) {
        refused.push(name);
        expect(parsed.error.message, name).toContain(`The key "${name}"`);
        continue;
      }
      read.push(name);
      const found = await parser.validate(parsed.data);
      expect(found.filter((d) => String(d.code) === "uncaught-error").map((d) => String(d.message).split("\n")[0]), `${name} crashes the parser`).toEqual([]);
    }
    expect(refused.sort()).toEqual(["__proto__", "constructor", "hasOwnProperty"]);
    expect(read.sort()).toEqual(NAMES.filter((name) => !refused.includes(name)).sort());
  }, 120_000);

  it("the probe's one crash is real: the parser, given hasOwnProperty directly, reports an uncaught error", async () => {
    // (so `PARSER_UNSAFE_KEYS` is not a precaution against nothing: if the parser is ever fixed this fails, and the entry can go)
    const document = JSON.parse(documentWith("hasOwnProperty")) as Parameters<ReturnType<typeof createAsyncApiParser>["validate"]>[0];
    const found = await createAsyncApiParser().validate(document);
    expect(found.some((d) => String(d.code) === "uncaught-error" && /hasOwnProperty/.test(String(d.message)))).toBe(true);
  }, 120_000);
});
