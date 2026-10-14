import { describe, it, expect } from "vitest";
import { parse } from "yaml";
import { ok, err, type Result } from "@/types/result";
import { AsyncApi3Adapter, getEventSpecAdapter } from "@/lib/event-specs/adapter";
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

  it("turns a throwing validator into VALIDATOR_FAILED instead of throwing", async () => {
    const throwing = new AsyncApi3Adapter({ validators: [new FakeParserValidator(new Error("boom"))] });
    const res = await throwing.validate({});
    expect(res).toEqual({
      success: false,
      error: { code: "VALIDATOR_FAILED", message: 'Validator "asyncapi-parser" threw: boom' },
    });
  });

  it("import is not implemented yet", async () => {
    const res = await new AsyncApi3Adapter().import("asyncapi: 3.0.0");
    expect(res.success).toBe(false);
    if (!res.success) expect(res.error.code).toBe("NOT_IMPLEMENTED");
  });
});
