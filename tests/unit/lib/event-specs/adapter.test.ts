import { describe, it, expect, vi } from "vitest";
import { parse } from "yaml";
import { ok, err, type Result } from "@/types/result";
import { AsyncApi3Adapter, getEventSpecAdapter } from "@/lib/event-specs/adapter";
import { GENERIC_VALIDATION_FAILURE } from "@/lib/event-specs/validator";
import type { EventSpecValidator } from "@/lib/event-specs/validator";
import type { Diagnostic } from "@/lib/event-specs/types";
import { checkoutServiceSpec } from "./fixtures/worked-example";
import { message, operation, spec } from "./fixtures/builders";

/** Stand-in for the Story 18.5 @asyncapi/parser validator: same interface, canned output. */
class FakeParserValidator implements EventSpecValidator {
  readonly name = "asyncapi-parser";
  constructor(private readonly result: Result<Diagnostic[]> | Error) {}
  async validate(): Promise<Result<Diagnostic[]>> {
    if (this.result instanceof Error) throw this.result;
    return this.result;
  }
}

describe("AsyncApi3Adapter", () => {
  it("has specType asyncapi@3.0 and is returned by getEventSpecAdapter", () => {
    const res = getEventSpecAdapter("asyncapi@3.0");
    expect(res.success && res.data.specType).toBe("asyncapi@3.0");
    const unknown = getEventSpecAdapter("openapi@3.1");
    expect(unknown.success).toBe(false);
    if (!unknown.success) expect(unknown.error.code).toBe("UNSUPPORTED_SPEC_TYPE");
  });

  it("emit returns the document plus JSON and YAML that parse back to it", async () => {
    const res = await new AsyncApi3Adapter().emit(checkoutServiceSpec);
    expect(res.success).toBe(true);
    if (!res.success) return;
    expect(res.data.diagnostics).toEqual([]);
    expect(JSON.parse(res.data.json)).toEqual(res.data.document);
    expect(parse(res.data.yaml)).toEqual(res.data.document);
  });

  it("merges assembler and validator diagnostics, ordered", async () => {
    const parserWarning: Diagnostic = {
      severity: "warning",
      code: "asyncapi-info-contact",
      message: "add contact",
      pointer: "/info",
    };
    const adapter = new AsyncApi3Adapter({ validators: [new FakeParserValidator(ok([parserWarning]))] });
    const draft = spec({
      channels: checkoutServiceSpec.channels,
      messages: [message({ id: "m", name: "M", unpublished: true })],
      operations: [operation({ key: "o", channelRef: checkoutServiceSpec.channels[0].id, messageRefs: ["m"] })],
    });
    const res = await adapter.emit(draft);
    expect(res.success && res.data.diagnostics.map((d) => d.code)).toEqual([
      "asyncapi-info-contact",
      "UNPUBLISHED_MESSAGE",
    ]);
  });

  it("runs every configured validator in order", async () => {
    const a: Diagnostic = { severity: "error", code: "A", message: "a", pointer: "/a" };
    const b: Diagnostic = { severity: "error", code: "B", message: "b", pointer: "/b" };
    const adapter = new AsyncApi3Adapter({
      validators: [new FakeParserValidator(ok([b])), new FakeParserValidator(ok([a]))],
    });
    expect(await adapter.validate({})).toEqual({ success: true, data: [a, b] });
  });

  it("propagates a validator failure as an err Result", async () => {
    const failing = new AsyncApi3Adapter({
      validators: [new FakeParserValidator(err({ code: "PARSER_UNAVAILABLE", message: "x" }))],
    });
    const res = await failing.emit(checkoutServiceSpec);
    expect(res.success).toBe(false);
    if (!res.success) expect(res.error.code).toBe("PARSER_UNAVAILABLE");
  });

  it("turns a throwing validator into VALIDATOR_FAILED instead of throwing, with a generic message and the original logged server-side", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const raw = new Error("parser exploded: connection string postgres://admin:s3cret@10.0.0.5/db at /srv/app/node_modules/spectral.js:42");
      const throwing = new AsyncApi3Adapter({ validators: [new FakeParserValidator(raw)] });
      const res = await throwing.validate({});
      expect(res).toEqual({ success: false, error: { code: "VALIDATOR_FAILED", message: GENERIC_VALIDATION_FAILURE } });
      expect(JSON.stringify(res)).not.toMatch(/s3cret|exploded|10\.0\.0\.5|spectral|asyncapi-parser/);
      expect(consoleError).toHaveBeenCalledTimes(1);
      expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('validator "asyncapi-parser"'), raw);
      expect(String(consoleError.mock.calls[0][0])).toContain("VALIDATOR_FAILED");

      // A non-Error throw is sanitized the same way (and the thrown value is logged as is).
      const primitive = new AsyncApi3Adapter({ validators: [{ name: "custom", validate: () => Promise.reject("raw string with s3cret") }] });
      const emitted = await primitive.emit(checkoutServiceSpec);
      expect(emitted).toEqual({ success: false, error: { code: "VALIDATOR_FAILED", message: GENERIC_VALIDATION_FAILURE } });
      expect(consoleError).toHaveBeenLastCalledWith(expect.stringContaining('validator "custom"'), "raw string with s3cret");
    } finally {
      consoleError.mockRestore();
    }
  });

  it("import is not implemented yet", async () => {
    const res = await new AsyncApi3Adapter().import("asyncapi: 3.0.0");
    expect(res.success).toBe(false);
    if (!res.success) expect(res.error.code).toBe("NOT_IMPLEMENTED");
  });
});
