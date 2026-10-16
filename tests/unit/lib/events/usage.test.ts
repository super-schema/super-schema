import { describe, it, expect } from "vitest";
import { describeUsage, parseUsageSubject, usageRowList, type UsageLookups } from "@/lib/events/usage";

const at = { domainSlug: "payments", productSlug: "checkout" };
const lookups: UsageLookups = {
  entityVersions: {
    ev1: { label: "2.1", entity: { name: "Order", slug: "order", ...at } },
    evT: { label: "1.0", entity: { name: "Party", slug: "party", domainSlug: null, productSlug: null } },
  },
  eventSpecs: { s1: { id: "s1", name: "checkout-service", ...at } },
  eventSpecVersions: { sv1: { label: "2.0", eventSpec: { id: "s1", name: "checkout-service", ...at } } },
  traits: {
    t1: { id: "t1", name: "CloudEvents", domainSlug: null, productSlug: null },
    t2: { id: "t2", name: "Audit", domainSlug: "payments", productSlug: null },
  },
};
const ref = (fromKind: string, fromId: string, role = "PAYLOAD", isDraft = false) => ({ id: `${fromKind}-${fromId}`, fromKind, fromId, role, isDraft, toId: "target" });

describe("describeUsage", () => {
  it("labels every referencing kind and links to the event page / trait list that exist", () => {
    const targets = { target: "Order v2.1" };
    expect(describeUsage(ref("EVENT_SPEC_VERSION", "sv1", "PAYLOAD"), lookups, targets)).toMatchObject({
      label: "Event checkout-service v2.0", href: "/schemas/payments/checkout/events/s1", target: "Order v2.1", role: "PAYLOAD", isDraft: false,
    });
    expect(describeUsage(ref("EVENT_SPEC", "s1", "PAYLOAD", true), lookups, targets)).toMatchObject({
      label: "Event checkout-service (draft)", href: "/schemas/payments/checkout/events/s1", isDraft: true,
    });
    expect(describeUsage(ref("TRAIT", "t1", "HEADERS"), lookups, targets)).toMatchObject({
      label: "Trait CloudEvents", href: "/schemas/enterprise?tab=traits",
    });
    expect(describeUsage(ref("TRAIT", "t2", "HEADERS"), lookups, targets)).toMatchObject({
      label: "Trait Audit", href: "/schemas/payments?tab=traits",
    });
  });

  it("links entity referrers to the entity page (no ?version= until a read-only view exists), including tenant-level entities", () => {
    expect(describeUsage(ref("ENTITY_VERSION", "ev1", "FIELD"), lookups, {})).toMatchObject({
      label: "Entity Order v2.1", href: "/schemas/payments/checkout/order",
    });
    expect(describeUsage(ref("ENTITY_VERSION", "evT", "FIELD"), lookups, {})).toMatchObject({
      label: "Entity Party v1.0", href: "/schemas/enterprise/entities/party",
    });
  });

  it("keeps rows whose source disappeared (no link, no throw)", () => {
    expect(describeUsage(ref("EVENT_SPEC_VERSION", "gone"), lookups, {})).toMatchObject({ label: "Event version gone (deleted)", href: null, target: "target" });
    expect(describeUsage(ref("EVENT_SPEC", "gone"), lookups, {})).toMatchObject({ label: "Event gone (deleted)", href: null });
    expect(describeUsage(ref("ENTITY_VERSION", "gone", "FIELD"), lookups, {})).toMatchObject({ label: "Entity version gone (deleted)", href: null });
    expect(describeUsage(ref("TRAIT", "gone", "HEADERS"), lookups, {})).toMatchObject({ label: "Trait gone (deleted)", href: null });
    expect(describeUsage(ref("UNKNOWN_KIND", "x"), lookups, {})).toMatchObject({ label: "UNKNOWN_KIND x (deleted)", href: null });
  });

  it("an event without a product (no link target) reads as deleted rather than linking nowhere", () => {
    const orphan: UsageLookups = { ...lookups, eventSpecs: { s2: { id: "s2", name: "x", domainSlug: null, productSlug: null } } };
    expect(describeUsage(ref("EVENT_SPEC", "s2"), orphan, {})).toMatchObject({ label: "Event s2 (deleted)", href: null });
  });

  it("treats the legacy message kinds as ghosts: they have no table any more", () => {
    expect(describeUsage(ref("MESSAGE_VERSION", "mv1"), lookups, {})).toMatchObject({ label: "MESSAGE_VERSION mv1 (deleted)", href: null });
    expect(describeUsage(ref("MESSAGE", "m1"), lookups, {})).toMatchObject({ label: "MESSAGE m1 (deleted)", href: null });
  });

  it("falls back to the raw target id when the target label is unknown", () => {
    expect(describeUsage(ref("EVENT_SPEC", "s1"), lookups, {}).target).toBe("target");
  });
});

describe("parseUsageSubject", () => {
  it("accepts an entity subject with a non-empty id and strips extra keys", () => {
    expect(parseUsageSubject({ kind: "entity", entityId: "e1", extra: 1 })).toEqual({ success: true, data: { kind: "entity", entityId: "e1" } });
  });

  it("accepts an event subject with a non-empty id and strips extra keys", () => {
    expect(parseUsageSubject({ kind: "event", eventId: "x" })).toEqual({ success: true, data: { kind: "event", eventId: "x" } });
    expect(parseUsageSubject({ kind: "event", eventId: "x", entityId: "e1", extra: 1 })).toEqual({ success: true, data: { kind: "event", eventId: "x" } });
  });

  it("rejects untrusted shapes, including the retired message subject", () => {
    for (const bad of [null, undefined, "x", 1, [], {}, { kind: "entity" }, { kind: "entity", entityId: "" }, { kind: "entity", entityId: 3 }, { kind: "message", messageId: "m1" }, { kind: "trait", id: "t" }]) {
      const r = parseUsageSubject(bad);
      expect(r.success).toBe(false);
      expect(!r.success && r.error.code).toBe("VALIDATION_ERROR");
    }
  });

  it("rejects an event subject without a usable id, and a subject of the other kind's shape", () => {
    for (const bad of [
      { kind: "event" }, { kind: "event", eventId: "" }, { kind: "event", eventId: "   " }, { kind: "event", eventId: 3 }, { kind: "event", eventId: null },
      { kind: "event", entityId: "e1" }, { kind: "entity", eventId: "x" }, { kind: "events", eventId: "x" }, { kind: "product", id: "p1" },
    ]) {
      const r = parseUsageSubject(bad);
      expect(r.success).toBe(false);
      expect(!r.success && r.error.code).toBe("VALIDATION_ERROR");
    }
  });
});

describe("usageRowList", () => {
  const row = { id: "r1", fromKind: "EVENT_SPEC" as const, role: "MESSAGE", isDraft: true, target: "T v1.0", label: "Event c (draft)", href: null };

  it("is the rows themselves, carrying a truncated flag that is not one of the array's own entries", () => {
    const list = usageRowList([row], true);
    expect(list).toEqual([row]);
    expect(list.length).toBe(1);
    expect(list.truncated).toBe(true);
    expect(JSON.stringify(list)).toBe(JSON.stringify([row]));
    expect(usageRowList([], false).truncated).toBe(false);
  });
});
