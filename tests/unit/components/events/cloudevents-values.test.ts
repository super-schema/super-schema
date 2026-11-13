import { describe, expect, it } from "vitest";
import { cloudEventsValues } from "@/features/events/builder/cloudevents-values";
import { ENTITY_OPTIONS, sampleDocument } from "./builder-harness";

const scope = { tenantSlug: "acme", domainSlug: "payments", domainId: "d1", productSlug: "checkout", productId: "p1" };

describe("cloudEventsValues", () => {
  it("derives the content type from the representation and links the pinned payload version", () => {
    const doc = sampleDocument();
    const v = cloudEventsValues({ doc, message: doc.messages[0], entityOptions: ENTITY_OPTIONS, scope, origin: "https://schemas.example.com", now: new Date("2026-11-12T10:00:00.123Z") });
    expect(v.specversion).toEqual({ value: "1.0", kind: "fixed" });
    expect(v.datacontenttype).toMatchObject({ value: "avro/binary", kind: "derived" });
    expect(v.dataschema).toMatchObject({ value: "https://schemas.example.com/schemas/payments/checkout/ordercreated?version=1.0", kind: "derived" });
    expect(v.type.value).toBe("acme.payments.checkout.ordercreated");
    expect(v.time).toMatchObject({ value: "2026-11-12T10:00:00Z", kind: "example" });
  });
  it("prefers the message content type, then the event default, and says when the payload is not pinned", () => {
    const doc = { ...sampleDocument(), defaultContentType: "application/cloudevents+json" };
    const message = { ...doc.messages[0], payload: { entityId: "ent-2", entityVersionId: null } };
    const v = cloudEventsValues({ doc, message, entityOptions: ENTITY_OPTIONS });
    expect(v.datacontenttype.value).toBe("application/cloudevents+json");
    expect(v.dataschema).toMatchObject({ value: "/schemas/payments/checkout/ordercancelled", note: expect.stringMatching(/not pinned/) });
    expect(v.type).toBeUndefined();
    expect(cloudEventsValues({ doc, message: { ...message, contentType: "application/json" }, entityOptions: ENTITY_OPTIONS }).datacontenttype.value).toBe("application/json");
  });
});
