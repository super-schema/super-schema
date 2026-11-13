import { describe, expect, it } from "vitest";
import { eventAttributeAlerts, itemAttributeAlerts } from "@/lib/metadata-attributes/alerts";
import type { MetadataAttributeDefinition } from "@/types/schemas/metadata-attribute";

const def = (over: Partial<MetadataAttributeDefinition>): MetadataAttributeDefinition => ({
  key: "x-owner", label: "Owner", description: "", valueSchema: { type: "string" }, targets: ["operation", "channel"], scope: "schema",
  placement: "field", requiredWhen: "always", ...over,
});

describe("itemAttributeAlerts", () => {
  it("warns for an operation that lacks an always-required attribute, and not for one that has it", () => {
    const alerts = itemAttributeAlerts("operation", [{ id: "a", name: "getOrder" }, { id: "b", name: "listOrders", extensions: { "x-owner": "p" } }], [def({})]);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ id: "operation-attr-METADATA_ATTRIBUTE_MISSING-x-owner-a", severity: "warning", title: 'Operation "getOrder" is missing x-owner' });
  });

  it("warns about an invalid value", () => {
    const alerts = itemAttributeAlerts("channel", [{ id: "c", name: "orders", extensions: { "x-owner": 5 } }], [def({})]);
    expect(alerts.map((a) => a.id)).toEqual(["channel-attr-METADATA_ATTRIBUTE_INVALID-x-owner-c"]);
  });

  it("ignores definitions that do not list the target and attributes that are not required", () => {
    expect(itemAttributeAlerts("message", [{ id: "m", name: "M" }], [def({})])).toEqual([]);
    expect(itemAttributeAlerts("operation", [{ id: "a", name: "x" }], [def({ requiredWhen: "never" })])).toEqual([]);
  });

  it("an event document: channels, messages and operations by key", () => {
    const doc = { channels: [{ key: "orders" }], messages: [{ key: "Created", extensions: {} }], operations: [{ key: "publish" }] };
    const alerts = eventAttributeAlerts(doc, [def({ targets: ["channel", "message", "operation"] })]);
    expect(alerts.map((a) => a.id)).toEqual([
      "channel-attr-METADATA_ATTRIBUTE_MISSING-x-owner-orders",
      "message-attr-METADATA_ATTRIBUTE_MISSING-x-owner-Created",
      "operation-attr-METADATA_ATTRIBUTE_MISSING-x-owner-publish",
    ]);
  });
});
