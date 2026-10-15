import { describe, it, expect, vi } from "vitest";
import { toResolvedChannel, messageSourceFromVersion, toFrozenTrait } from "@/lib/events/catalog-mapping";
import { resolveSnapshot, type DraftSnapshot } from "@/services/events/event-spec-resolver";
import type { ArtifactRenderer, ArtifactSubject } from "@/services/events/artifact-renderer";
import type { PayloadFormat } from "@/lib/event-specs/types";
import { err, ok } from "@/types/result";

const channel = toResolvedChannel({
  id: "c1", name: "orders", address: "payments.orders.v1", protocol: "kafka", format: "avro", formatDialect: null, spec: {}, product: { slug: "checkout" },
});
const message = messageSourceFromVersion({
  id: "mv1", messageId: "m1", major: 1, minor: 0,
  resolvedSpec: {
    name: "OrderCreated", spec: { traitIds: ["t1"] },
    payload: { entityId: "e1", entityName: "Order", entityVersionId: "ev-order", label: "1.0", major: 1 },
    headers: { entityId: "e3", entityName: "Headers", entityVersionId: "ev-headers", label: "1.0", major: 1 },
    key: { entityId: "e2", entityName: "OrderKey", entityVersionId: "ev-key", label: "1.0", major: 1 },
  },
  message: { name: "OrderCreated", product: { slug: "checkout" } },
});
const trait = toFrozenTrait({
  id: "t1", name: "CloudEvents", kind: "MESSAGE", spec: {}, headersEntityId: "e9", headersEntityVersionId: "ev-trait-headers",
  tenant: { slug: "acme" }, domain: null, product: null,
});

function snapshot(over: Partial<DraftSnapshot> = {}): DraftSnapshot {
  return {
    spec: {
      id: "s1", name: "checkout-service", specType: "asyncapi@3.0", tenantId: "t", domainId: "d", productId: "p", productSlug: "checkout",
      updatedAt: new Date(0), hasUnpublishedChanges: true, latestVersionId: null,
    },
    document: {
      info: { title: "checkout-service" }, servers: [],
      operations: [{ key: "publish", action: "send", channelId: "c1", messageVersionIds: ["mv1"], traitIds: [] }],
    },
    latest: null,
    channels: [channel],
    traits: [trait],
    messages: message ? [message] : [],
    messageVersionInfo: {},
    unresolved: [],
    ...over,
  };
}

const schemaFor = (subject: ArtifactSubject, format: PayloadFormat) => ({
  format,
  schema: format === "protobuf" ? "syntax = 'proto3';" : { type: format === "avro" ? "record" : "object", name: subject.kind === "version" ? subject.entityVersionId : subject.entityId },
});

describe("resolveSnapshot", () => {
  it("renders payload + Kafka key in the channel's format and headers / trait headers as JSON Schema, then resolves the spec", async () => {
    const render = vi.fn(async (subject: ArtifactSubject, format: PayloadFormat) => ok({ artifact: schemaFor(subject, format), warnings: [] }));
    const out = await resolveSnapshot(snapshot(), { render } as ArtifactRenderer, "draft");

    expect(out.diagnostics).toEqual([]);
    expect(render.mock.calls.map(([s, f]) => `${s.kind === "version" ? s.entityVersionId : s.entityId}:${f}`).sort()).toEqual([
      "ev-headers:json-schema", "ev-key:avro", "ev-order:avro", "ev-trait-headers:json-schema",
    ]);
    expect(out.resolved?.info).toEqual({ title: "checkout-service", version: "draft" });
    const resolvedMessage = out.resolved?.messages[0];
    expect(resolvedMessage?.payloads).toHaveLength(1);
    expect(resolvedMessage?.keys).toHaveLength(1);
    expect(resolvedMessage?.headers?.format).toBe("json-schema");
    expect(out.resolved?.traits[0].headers?.format).toBe("json-schema");
  });

  it("maps BOTH renderer failure shapes to error diagnostics (wrapped combine/emit errors with details.cause, and loader codes) and still resolves", async () => {
    const render: ArtifactRenderer["render"] = async (subject, format) => {
      const id = subject.kind === "version" ? subject.entityVersionId : subject.entityId;
      if (id === "ev-order") {
        return err({
          code: "ARTIFACT_RENDER_FAILED", message: "Order@1.0 → avro: Unknown identifier Ghost", details: { cause: "TYPESPEC_COMBINE_FAILED" },
          suggestedFix: "Pin the referenced entity.",
        });
      }
      if (id === "ev-key") return err({ code: "UNPUBLISHED_REFERENCE", message: 'Entity "Address" has no published version', details: { cause: "UNPUBLISHED_REFERENCE" } });
      if (id === "ev-headers") return err({ code: "NOT_FOUND", message: 'Entity version "ev-headers" not found' });
      return ok({ artifact: schemaFor(subject, format), warnings: ["Duplicate declaration of Address (first wins)"] });
    };
    const out = await resolveSnapshot(snapshot(), { render }, "draft");

    expect(out.resolved).not.toBeNull(); // the assembler reports the missing artifacts itself; the render causes are listed too
    expect(out.diagnostics).toHaveLength(4); // order follows async completion; emitEventSpec normalizes
    expect(out.diagnostics).toEqual(expect.arrayContaining([
      {
        severity: "error", code: "ARTIFACT_RENDER_FAILED", pointer: "",
        message: "Message OrderCreated payload (avro): Order@1.0 → avro: Unknown identifier Ghost [TYPESPEC_COMBINE_FAILED] Fix: Pin the referenced entity.",
      },
      { severity: "error", code: "UNPUBLISHED_REFERENCE", pointer: "", message: 'Message OrderCreated key (avro): Entity "Address" has no published version' },
      { severity: "error", code: "NOT_FOUND", pointer: "", message: 'Message OrderCreated headers (json-schema): Entity version "ev-headers" not found' },
      { severity: "warning", code: "TYPESPEC_DUPLICATE_DECLARATION", pointer: "", message: "Trait CloudEvents headers: Duplicate declaration of Address (first wins)" },
    ]));
  });

  it("short-circuits on unresolved draft references without rendering anything", async () => {
    const render = vi.fn();
    const out = await resolveSnapshot(
      snapshot({ unresolved: [{ pointer: "/operations/0/channelId", message: 'Channel "gone" not found' }] }),
      { render } as unknown as ArtifactRenderer,
      "draft"
    );
    expect(render).not.toHaveBeenCalled();
    expect(out).toEqual({
      resolved: null,
      diagnostics: [{ severity: "error", code: "UNRESOLVED_REFERENCE", message: 'Draft reference: Channel "gone" not found', pointer: "/operations/0/channelId" }],
    });
  });

  it("does not render an unpinned key / headers (null subjects) and plans nothing for unreferenced messages", async () => {
    const render = vi.fn(async (subject: ArtifactSubject, format: PayloadFormat) => ok({ artifact: schemaFor(subject, format), warnings: [] }));
    const bare = messageSourceFromVersion({
      id: "mv1", messageId: "m1", major: 1, minor: 0,
      resolvedSpec: { name: "OrderCreated", spec: { traitIds: [] }, payload: { entityId: "e1", entityName: "Order", entityVersionId: "ev-order", label: "1.0", major: 1 }, headers: null, key: null },
      message: { name: "OrderCreated", product: { slug: "checkout" } },
    });
    const out = await resolveSnapshot(snapshot({ messages: bare ? [bare] : [], traits: [] }), { render } as ArtifactRenderer, "draft");
    expect(render).toHaveBeenCalledTimes(1);
    expect(out.resolved?.messages[0].keys).toBeUndefined();
  });
});
