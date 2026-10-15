import { describe, it, expect } from "vitest";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { AsyncApi3Adapter } from "@/lib/event-specs/adapter";
import type { EmitOutput, ResolvedEventSpec } from "@/lib/event-specs/types";
import { SPEC_6_2_CHECKOUT_YAML, checkoutServiceSpec, fraudScorerSpec } from "./fixtures/worked-example";

/**
 * Golden files for the spec §6.2 worked example. Regenerate deliberately with
 *   UPDATE_GOLDEN=1 npx vitest run tests/unit/lib/event-specs/golden.test.ts
 * and review the diff — a golden change is an output-contract change.
 */
const GOLDEN_DIR = path.join(__dirname, "__golden__");

function expectGolden(file: string, actual: string): void {
  const target = path.join(GOLDEN_DIR, file);
  if (process.env.UPDATE_GOLDEN === "1") {
    mkdirSync(GOLDEN_DIR, { recursive: true });
    writeFileSync(target, actual);
  }
  expect(actual).toBe(readFileSync(target, "utf8"));
}

async function emit(spec: ResolvedEventSpec): Promise<EmitOutput> {
  const res = await new AsyncApi3Adapter().emit(spec);
  if (!res.success) throw new Error(res.error.message);
  return res.data;
}

describe("golden: spec §6.2 worked example", () => {
  it("checkout-service@2.0 matches its YAML and JSON goldens", async () => {
    const out = await emit(checkoutServiceSpec);
    expect(out.diagnostics).toEqual([]);
    expectGolden("checkout-service.asyncapi.yaml", out.yaml);
    expectGolden("checkout-service.asyncapi.json", out.json);
  });

  it("checkout-service@2.0 is semantically the document printed in the spec", async () => {
    const out = await emit(checkoutServiceSpec);
    expect(parse(out.yaml)).toEqual(parse(SPEC_6_2_CHECKOUT_YAML));
  });

  it("fraud-scorer@1.0 matches its goldens and shares checkout's channels/components blocks", async () => {
    const out = await emit(fraudScorerSpec);
    expect(out.diagnostics).toEqual([]);
    expectGolden("fraud-scorer.asyncapi.yaml", out.yaml);
    expectGolden("fraud-scorer.asyncapi.json", out.json);

    const checkout = await emit(checkoutServiceSpec);
    expect(out.document.channels).toEqual(checkout.document.channels);
    expect(out.document.components).toEqual(checkout.document.components);
    expect(out.document.operations).toEqual({
      consumeOrderCreated: {
        action: "receive",
        channel: { $ref: "#/channels/orders" },
        messages: [{ $ref: "#/channels/orders/messages/OrderCreated" }],
      },
    });
  });

  it("is byte-stable across repeated emits", async () => {
    const [a, b] = await Promise.all([emit(checkoutServiceSpec), emit(structuredClone(checkoutServiceSpec))]);
    expect(b.yaml).toBe(a.yaml);
    expect(b.json).toBe(a.json);
  });
});
