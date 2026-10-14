import { describe, it, expect } from "vitest";
import { resolveEventSpecDocument } from "@/lib/event-specs/resolve";
import type { EventSpecDocument } from "@/lib/event-specs/types";
import {
  checkoutServiceDocument,
  checkoutServiceSpec,
  cloudEventsTrait,
  ordersChannel,
  workedExampleCatalog,
} from "./fixtures/worked-example";

describe("resolveEventSpecDocument (EventSpecDocument → ResolvedEventSpec)", () => {
  it("maps the §6.2 checkout-service draft onto the resolved model", () => {
    const res = resolveEventSpecDocument(checkoutServiceDocument, workedExampleCatalog, {
      productSlug: "checkout",
      version: "2.0",
    });
    expect(res).toEqual({ success: true, data: checkoutServiceSpec });
  });

  it("carries reply, bindings, summary and local components across", () => {
    const doc: EventSpecDocument = {
      info: { title: "rr", description: "request/reply" },
      defaultContentType: "application/json",
      servers: [],
      operations: [
        {
          key: "ask",
          action: "send",
          channelId: ordersChannel.id,
          messageVersionIds: [],
          traitIds: [],
          summary: "Ask",
          bindings: { kafka: { groupId: { type: "string" } } },
          reply: { channelId: ordersChannel.id, messageVersionIds: [] },
        },
      ],
      components: { correlationIds: { byId: { location: "$message.header#/ce_id" } } },
    };
    const res = resolveEventSpecDocument(doc, workedExampleCatalog, { productSlug: "checkout", version: "0.1" });
    expect(res.success).toBe(true);
    if (!res.success) return;
    expect(res.data.info).toEqual({ title: "rr", description: "request/reply", version: "0.1" });
    expect(res.data.defaultContentType).toBe("application/json");
    expect(res.data.operations[0]).toEqual({
      key: "ask",
      action: "send",
      channelRef: ordersChannel.id,
      messageRefs: [],
      traitRefs: [],
      summary: "Ask",
      bindings: { kafka: { groupId: { type: "string" } } },
      reply: { channelRef: ordersChannel.id, messageRefs: [] },
    });
    expect(res.data.components).toEqual({ correlationIds: { byId: { location: "$message.header#/ce_id" } } });
    expect(res.data.channels.map((c) => c.id)).toEqual([ordersChannel.id]);
  });

  it("reports every unresolved reference together", () => {
    const doc: EventSpecDocument = {
      info: { title: "broken" },
      servers: [],
      operations: [
        {
          key: "a",
          action: "send",
          channelId: "nope",
          messageVersionIds: ["missing"],
          traitIds: [cloudEventsTrait.id],
        },
      ],
    };
    const res = resolveEventSpecDocument(doc, workedExampleCatalog, { productSlug: "checkout", version: "1.0" });
    expect(res.success).toBe(false);
    if (res.success) return;
    expect(res.error.code).toBe("UNRESOLVED_REFERENCES");
    expect((res.error.details as { problems: unknown[] }).problems).toEqual([
      { pointer: "/operations/0/channelId", message: 'Channel "nope" not found' },
      { pointer: "/operations/0/messageVersionIds/0", message: 'Message version "missing" not found' },
      {
        pointer: "/operations/0/traitIds/0",
        message: 'Trait "trait-cloudevents" is a MESSAGE trait, expected OPERATION',
      },
    ]);
  });
});
