import { describe, it, expect, vi } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import { loadDraftSnapshot } from "@/services/events/event-spec-resolver";

/**
 * R67 — tenant / product isolation of the draft snapshot. The stub records every `where` AND honours the filters it is
 * given, like the database does: a row of another tenant (or another product's draft message) only comes back if the query
 * forgot to scope, so a regression fails both the recorded-where assertions and the behavioural ones.
 */

const OWN = { tenantId: "tenant-A", productId: "p-own" };

const specRow = (over: Record<string, unknown> = {}) => ({
  id: "s1", name: "checkout-service", specType: "asyncapi@3.0", ...OWN, domainId: "d1", updatedAt: new Date(0), hasUnpublishedChanges: true,
  latestVersionId: null, latestVersion: null, product: { slug: "checkout" },
  document: {
    info: { title: "x" }, servers: [],
    operations: [{ key: "op", action: "send", channelId: "c-own", messageVersionIds: ["mv-own", "draft-own", "draft-foreign"], traitIds: ["t-own"] }],
  },
  ...over,
});

const channelRow = (id: string, tenantId: string) => ({ id, tenantId, name: id, address: id, protocol: "kafka", format: "avro", formatDialect: null, spec: {}, product: { slug: "checkout" } });
const versionRow = (id: string, tenantId: string) => ({
  id, tenantId, messageId: `m-${id}`, major: 1, minor: 0, message: { name: id, product: { slug: "checkout" } },
  resolvedSpec: { name: id, spec: { traitIds: [] }, payload: { entityId: "e", entityName: "E", entityVersionId: "ev", label: "1.0", major: 1 }, headers: null, key: null },
});
const draftRow = (id: string, productId: string) => ({
  id, productId, name: id, spec: {}, payloadEntityId: "e", payloadEntityVersionId: null, headersEntityId: null, headersEntityVersionId: null,
  keyEntityId: null, keyEntityVersionId: null, product: { slug: "checkout" },
});
const traitRow = (id: string, tenantId: string) => ({
  id, tenantId, name: id, kind: "OPERATION", spec: {}, headersEntityId: null, headersEntityVersionId: null, tenant: { slug: "acme" }, domain: null, product: null,
});

type Where = { id: { in: string[] }; tenantId?: string; productId?: string; message?: { tenantId?: string } };

function stubDb(spec: ReturnType<typeof specRow>) {
  const calls: Record<"channel" | "messageVersion" | "message" | "trait", Where[]> = { channel: [], messageVersion: [], message: [], trait: [] };
  const channels = [channelRow("c-own", "tenant-A"), channelRow("c-foreign", "tenant-B")];
  const versions = [versionRow("mv-own", "tenant-A"), versionRow("mv-foreign", "tenant-B")];
  const drafts = [draftRow("draft-own", "p-own"), draftRow("draft-foreign", "p-other")];
  const traits = [traitRow("t-own", "tenant-A"), traitRow("t-foreign", "tenant-B")];
  const requested = (where: Where) => (r: { id: string }) => where.id.in.includes(r.id);
  const db = {
    eventSpec: { findUnique: vi.fn(async () => spec) },
    channel: {
      findMany: vi.fn(async ({ where }: { where: Where }) => {
        calls.channel.push(where);
        return channels.filter(requested(where)).filter((r) => where.tenantId === undefined || r.tenantId === where.tenantId);
      }),
    },
    messageVersion: {
      findMany: vi.fn(async ({ where }: { where: Where }) => {
        calls.messageVersion.push(where);
        return versions.filter(requested(where)).filter((r) => where.message?.tenantId === undefined || r.tenantId === where.message.tenantId);
      }),
    },
    message: {
      findMany: vi.fn(async ({ where }: { where: Where }) => {
        calls.message.push(where);
        return drafts.filter(requested(where)).filter((r) => where.productId === undefined || r.productId === where.productId);
      }),
    },
    trait: {
      findMany: vi.fn(async ({ where }: { where: Where }) => {
        calls.trait.push(where);
        return traits.filter(requested(where)).filter((r) => where.tenantId === undefined || r.tenantId === where.tenantId);
      }),
    },
  };
  return { db: db as unknown as PrismaClient, calls };
}

describe("loadDraftSnapshot — tenant / product isolation (R67)", () => {
  it("scopes channels, message versions and traits to the spec's tenant and draft messages to its product", async () => {
    const { db, calls } = stubDb(specRow());
    expect((await loadDraftSnapshot(db, "s1")).success).toBe(true);
    expect(calls.channel).toEqual([{ id: { in: ["c-own"] }, tenantId: "tenant-A" }]);
    expect(calls.messageVersion).toEqual([{ id: { in: ["mv-own", "draft-own", "draft-foreign"] }, message: { tenantId: "tenant-A" } }]);
    // only ids that are not message versions are looked up as drafts, and only in this product
    expect(calls.message).toEqual([{ id: { in: ["draft-own", "draft-foreign"] }, productId: "p-own" }]);
    expect(calls.trait).toEqual([{ id: { in: ["t-own"] }, tenantId: "tenant-A" }]);
  });

  it("resolves own-tenant ids; another product's draft message is reported unresolved at its draft pointer", async () => {
    const result = await loadDraftSnapshot(stubDb(specRow()).db, "s1");
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.channels.map((c) => c.id)).toEqual(["c-own"]);
    expect(result.data.messages.map((m) => [m.id, m.unpublished])).toEqual([["mv-own", false], ["draft-own", true]]);
    expect(result.data.traits.map((t) => t.id)).toEqual(["t-own"]);
    expect(result.data.unresolved.map((p) => p.pointer)).toEqual(["/operations/0/messageVersionIds/2"]); // draft-foreign (other product)
  });

  it("never resolves another tenant's channel / version / trait: every one is reported unresolved, nothing leaks into the snapshot", async () => {
    const foreign = specRow({
      document: {
        info: { title: "x" }, servers: [],
        operations: [{ key: "op", action: "send", channelId: "c-foreign", messageVersionIds: ["mv-foreign"], traitIds: ["t-foreign"] }],
      },
    });
    const result = await loadDraftSnapshot(stubDb(foreign).db, "s1");
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.channels).toEqual([]);
    expect(result.data.messages).toEqual([]);
    expect(result.data.traits).toEqual([]);
    expect(result.data.messageVersionInfo).toEqual({});
    expect(result.data.unresolved.map((p) => p.pointer).sort()).toEqual(
      ["/operations/0/channelId", "/operations/0/messageVersionIds/0", "/operations/0/traitIds/0"].sort()
    );
  });

  it("skips the draft and trait lookups when every message ref is a message version and no trait is referenced", async () => {
    const onlyVersions = specRow({
      document: { info: { title: "x" }, servers: [], operations: [{ key: "op", action: "send", channelId: "c-own", messageVersionIds: ["mv-own"], traitIds: [] }] },
    });
    const { db, calls } = stubDb(onlyVersions);
    expect((await loadDraftSnapshot(db, "s1")).success).toBe(true);
    expect(calls.message).toEqual([]);
    expect(calls.trait).toEqual([]);
  });
});
