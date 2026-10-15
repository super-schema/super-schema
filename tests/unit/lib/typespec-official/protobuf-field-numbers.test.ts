import { describe, it, expect, vi } from "vitest";
vi.mock("@/lib/db", () => ({ prisma: {} }));
import { injectProtobufFieldNumbers } from "@/lib/typespec-official/emitter.service";

describe("injectProtobufFieldNumbers", () => {
  it("targets the exact model (not a prefix match) and falls back to positions", () => {
    const src = "model OrderKey {\n  id: string;\n}\n\nmodel Order {\n  id: string;\n  total?: int32;\n}\n";
    expect(injectProtobufFieldNumbers(src, "Order", [{ name: "id", fieldNumber: 5 }, { name: "total", fieldNumber: null }])).toBe(
      "model OrderKey {\n  id: string;\n}\n\nmodel Order {\n  @field(5)\n  id: string;\n  @field(2)\n  total?: int32;\n}\n"
    );
  });
});
