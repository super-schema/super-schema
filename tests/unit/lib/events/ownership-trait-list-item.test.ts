import { describe, it, expect } from "vitest";
import { assertOwnedBy } from "@/lib/events/ownership";
import { traitListItem } from "@/lib/events/list-items";

const checkout = { tenantId: "t", domainId: "d1", productId: "p1" };
const fraud = { tenantId: "t", domainId: "d2", productId: "p2" };
const updatedAt = new Date("2026-10-14T10:00:00.000Z");

describe("assertOwnedBy", () => {
  it("passes for the owner and returns FORBIDDEN otherwise", () => {
    expect(assertOwnedBy(checkout, checkout, 'Event "orders"').success).toBe(true);
    const r = assertOwnedBy(checkout, fraud, 'Event "orders"');
    expect(!r.success && r.error.code).toBe("FORBIDDEN");
    expect(!r.success && r.error.message).toMatch(/read-only/);
  });
});

describe("traitListItem", () => {
  it("maps a row to a list item with its kind, a summary and an ISO date", () => {
    expect(traitListItem({ id: "t", name: "CloudEvents", kind: "MESSAGE", spec: {}, updatedAt })).toEqual({
      id: "t", name: "CloudEvents", kind: "MESSAGE", summary: "", updatedAt: "2026-10-14T10:00:00.000Z",
    });
  });

  it("prefers the summary over the description and caps it at 200 characters", () => {
    expect(traitListItem({ id: "t", name: "A", kind: "OPERATION", spec: { summary: "S", description: "D" }, updatedAt }).summary).toBe("S");
    expect(traitListItem({ id: "t", name: "A", kind: "OPERATION", spec: { description: "D" }, updatedAt }).summary).toBe("D");
    expect(traitListItem({ id: "t", name: "A", kind: "OPERATION", spec: { description: "x".repeat(300) }, updatedAt }).summary).toHaveLength(200);
  });

  it("tolerates a malformed spec", () => {
    expect(traitListItem({ id: "t", name: "A", kind: "MESSAGE", spec: "nope", updatedAt }).summary).toBe("");
  });
});
