import { describe, it, expect } from "vitest";
import { assertOwnedBy } from "@/lib/events/ownership";
import { channelListItem, eventSpecListItem, messageListItem, traitListItem } from "@/lib/events/list-items";

const checkout = { tenantId: "t", domainId: "d1", productId: "p1" };
const fraud = { tenantId: "t", domainId: "d2", productId: "p2" };
const updatedAt = new Date("2026-10-14T10:00:00.000Z");

describe("assertOwnedBy", () => {
  it("passes for the owner and returns FORBIDDEN otherwise", () => {
    expect(assertOwnedBy(checkout, checkout, 'Channel "orders"').success).toBe(true);
    const r = assertOwnedBy(checkout, fraud, 'Channel "orders"');
    expect(!r.success && r.error.code).toBe("FORBIDDEN");
    expect(!r.success && r.error.message).toMatch(/read-only/);
  });
});

describe("list items", () => {
  it("maps rows to list items with summaries and version labels", () => {
    expect(channelListItem({ id: "c", name: "orders", address: "a.b", protocol: "kafka", format: "avro", spec: { summary: "Orders" }, updatedAt })).toEqual({
      id: "c", name: "orders", summary: "Orders", updatedAt: "2026-10-14T10:00:00.000Z", address: "a.b", protocol: "kafka", format: "avro",
    });
    expect(
      messageListItem({ id: "m", name: "OrderCreated", spec: { description: "d" }, hasUnpublishedChanges: false, updatedAt, latestVersion: { major: 1, minor: 3 }, payloadEntity: { name: "Order" } })
    ).toMatchObject({ summary: "d", latestVersionLabel: "1.3", payloadEntityName: "Order" });
    expect(
      eventSpecListItem({ id: "s", name: "checkout-service", document: { info: { title: "x", description: "Spec" }, servers: [], operations: [{}, {}] }, hasUnpublishedChanges: true, updatedAt, latestVersion: null })
    ).toMatchObject({ summary: "Spec", latestVersionLabel: null, operationCount: 2 });
    expect(traitListItem({ id: "t", name: "CloudEvents", kind: "MESSAGE", spec: {}, updatedAt })).toMatchObject({ kind: "MESSAGE", summary: "" });
  });
});
