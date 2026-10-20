/**
 * Guards a parser upgrade. `PARSER_UNSAFE_KEYS` (`own-property.ts`) is EMPIRICAL: the names of `Object.prototype` that the real
 * `@asyncapi/parser` crashes on when they are an object key anywhere in a document. Every one of those names is put in every place a
 * user-controlled key can sit, each document goes through the REAL parser, and the set that crashes must be exactly the list; the
 * validator's guard must flag the same names, in the same places, and nothing else.
 */
import { describe, expect, it, vi } from "vitest";
import { PARSER_UNSAFE_KEYS, RESERVED_KEYS } from "@/lib/event-specs/own-property";
import { AsyncApiParserValidator, findParserUnsafeKeys } from "@/lib/event-specs/validation/asyncapi-parser-validator";
import { createAsyncApiParser } from "@/lib/event-specs/validation/parser-core";
import { KEY_POSITIONS, parserInput } from "./fixtures/unsafe-key-documents";

const NAMES = Object.getOwnPropertyNames(Object.prototype);
const UPDATE_THE_LIST =
  "a parser upgrade changed which names crash: update PARSER_UNSAFE_KEYS (src/lib/event-specs/own-property.ts). " +
  "To LIFT a restriction (the parser, or a fixed copy of it, no longer crashes on that name): remove the name from that set; every refusal " +
  "(entity field names, entity / model / enum / event names, builder keys, importers, the validator's guard) is driven by it and goes away with " +
  "it. THEN update or delete the tests that pin that name: grep the repo for it. To ADD one: add it there.";

describe("every name of Object.prototype as a key, through the real AsyncAPI parser", () => {
  it("the names that crash the parser are exactly PARSER_UNSAFE_KEYS, in every position", async () => {
    expect(NAMES).toContain("hasOwnProperty"); // the sweep covers the one known crash
    const parser = createAsyncApiParser();
    const crashesAt = new Map<string, string[]>(); // name -> positions where the parser reports `uncaught-error`
    for (const position of KEY_POSITIONS) {
      for (const name of NAMES) {
        const found = await parser.validate(parserInput(position.build(name)));
        if (found.some((d) => String(d.code) === "uncaught-error")) crashesAt.set(name, [...(crashesAt.get(name) ?? []), position.label]);
      }
    }
    expect([...crashesAt.keys()].sort(), UPDATE_THE_LIST).toEqual([...PARSER_UNSAFE_KEYS].sort());
    // `hasOwnProperty` crashes wherever it sits (the resolver walks every object); `__proto__` only inside x- maps, bindings and arrays
    for (const name of [...PARSER_UNSAFE_KEYS].filter((key) => !RESERVED_KEYS.has(key))) {
      expect(crashesAt.get(name), `${name} crashed only in some positions`).toEqual(KEY_POSITIONS.map((p) => p.label));
    }
  }, 120_000);

  it("the guard flags exactly those names, at the key's own pointer, in every position", () => {
    const flagged = new Set<string>();
    for (const position of KEY_POSITIONS) {
      for (const name of NAMES) {
        const found = findParserUnsafeKeys(position.build(name));
        if (PARSER_UNSAFE_KEYS.has(name)) {
          expect(found.map((d) => [d.code, d.severity, d.pointer]), `${name} in ${position.label}`).toEqual([["PARSER_UNSAFE_KEY", "error", position.pointer(name)]]);
          flagged.add(name);
        } else {
          expect(found, `${name} in ${position.label} must not be flagged (the parser reads it)`).toEqual([]);
        }
      }
    }
    expect([...flagged].sort()).toEqual([...PARSER_UNSAFE_KEYS].sort());
  });

  it("validate() refuses each such document without calling the parser, and reads every other name through it", async () => {
    const validator = new AsyncApiParserValidator();
    const errors = async (document: object) => {
      const res = await validator.validate(document);
      if (!res.success) throw new Error(res.error.message);
      return res.data.filter((d) => d.severity === "error");
    };
    for (const position of KEY_POSITIONS) {
      for (const name of NAMES) {
        const out = await errors(position.build(name));
        const codes = out.map((d) => d.code);
        if (PARSER_UNSAFE_KEYS.has(name)) expect(codes, `${name} in ${position.label}`).toEqual(["PARSER_UNSAFE_KEY"]);
        else {
          expect(codes, `${name} in ${position.label}`).not.toContain("PARSER_UNSAFE_KEY");
          expect(codes, `${name} in ${position.label}`).not.toContain("ASYNCAPI_PARSER_CRASHED");
        }
      }
    }
  }, 120_000);
});

describe("the parser's crash is real", () => {
  it("given a name of the list directly, it reports an uncaught error (if the parser is ever fixed this fails and the entry can go)", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    for (const name of [...PARSER_UNSAFE_KEYS].filter((key) => !RESERVED_KEYS.has(key))) {
      const found = await createAsyncApiParser().validate(parserInput(KEY_POSITIONS[0].build(name)));
      expect(found.some((d) => String(d.code) === "uncaught-error" && String(d.message).includes(name)), name).toBe(true);
    }
    log.mockRestore();
  }, 120_000);
});
