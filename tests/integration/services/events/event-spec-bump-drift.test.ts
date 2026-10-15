import "dotenv/config"; // first: @/lib/db (pulled in by the services and loaders) reads DB_PROVIDER at import time
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import type { PayloadFormat, SchemaArtifact } from "@/lib/event-specs/types";
import type { ServiceContext } from "@/types/service-context";
import { ok } from "@/types/result";
import { toFrozenTrait, toResolvedChannel } from "@/lib/events/catalog-mapping";
import type { ArtifactRenderer } from "@/services/events/artifact-renderer";
import { createChannel } from "@/services/events/channel.service";
import { createEventSpec, findEventSpecsWithCatalogDrift } from "@/services/events/event-spec.service";
import { CHANNEL_SELECT, TRAIT_SELECT } from "@/services/events/event-spec-resolver";
import { previewEventSpecPublish } from "@/services/events/event-spec-publish.service";
import { createMessage } from "@/services/events/message.service";
import { createTrait } from "@/services/events/trait.service";
import { cleanupDomains, connectTestDb, createProductScope, TENANT, testContext, unwrap } from "./helpers";

/**
 * Final review B-I1 (R78): live Channel / Trait changes that break consumers are visible to the Event Spec bump classification,
 * and any live Channel / Trait drift shows on the "unpublished changes" badges. Everything the preview needs is inserted directly
 * (entity / message / event spec versions, live channel and trait edits) so no publish audit rows are written, and the artifacts
 * are rendered by a stub — the bump classification never looks at them.
 */
const h = vi.hoisted(() => ({ tenantId: "" }));
vi.mock("@/lib/active-tenant", () => ({ getActiveTenantId: async () => h.tenantId }));

import { loadEventSpecPage } from "@/features/events/event-specs/load-event-spec-page";
import { loadProductEventsData } from "@/features/events/workspace/load-events-tab-data";

let prisma: PrismaClient;
let ctx: ServiceContext;
beforeAll(async () => {
  prisma = connectTestDb();
  ctx = await testContext(prisma);
  h.tenantId = TENANT;
});
afterAll(async () => prisma.$disconnect());

type Scope = Awaited<ReturnType<typeof createProductScope>>;

const artifactFor = (format: PayloadFormat): SchemaArtifact =>
  format === "avro"
    ? { format, schema: { type: "record", name: "Order", fields: [{ name: "id", type: "string" }] } }
    : format === "json-schema"
      ? { format, dialect: "2020-12", schema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } }
      : { format, schema: 'syntax = "proto3";\nmessage Order {\n  string id = 1;\n}\n' };
const stubRenderer: ArtifactRenderer = { render: async (_subject, format) => ok({ warnings: [], artifact: artifactFor(format) }) };
const deps = { renderer: stubRenderer, validators: [] };

async function addEntityVersion(entityId: string, name: string, major: number, minor: number, sequence: number) {
  return prisma.entityVersion.create({
    data: {
      entityId, major, minor, sequence, changeKind: major === 1 && minor === 0 ? "INITIAL" : major === 1 ? "MINOR" : "MAJOR", publishedById: ctx.userId,
      resolvedSource: `model ${name} {\n  id: string;\n}\n`, fieldSnapshot: [{ name: "id", fieldNumber: 1 }],
    },
  });
}

async function frozenEntity(sc: Scope, name: string) {
  const entity = await sc.entity(name, [{ name: "id", type: "string" }]);
  const version = await addEntityVersion(entity.id, name, 1, 0, 1);
  await prisma.entity.update({ where: { id: entity.id }, data: { latestVersionId: version.id, hasUnpublishedChanges: false, version: 1 } });
  return { entity, version };
}

interface FixtureOptions {
  channel?: { format: string; formatDialect?: string };
  withTrait?: boolean;
  defaultContentType?: string;
  /** `old`: freeze channels / traits the way a version published before R78 might have (no profile / protocol / headers fields). */
  frozenShape?: "current" | "old";
}

/**
 * A product with an Avro channel, a frozen message version and an event spec whose latest version (2.0) is inserted directly:
 * its frozen channels / traits are exactly the live rows' resolved copies (what `publishEventSpec` writes).
 */
async function publishedSpec(label: string, options: FixtureOptions = {}) {
  const sc = await createProductScope(prisma, ctx, label);
  const order = await frozenEntity(sc, "Order");
  let headers: { entity: { id: string }; v1: { id: string }; v2: { id: string }; v11: { id: string } } | undefined;
  let trait: { id: string; name: string } | undefined;
  if (options.withTrait) {
    const entity = await frozenEntity(sc, "CloudEventsHeaders");
    const v11 = await addEntityVersion(entity.entity.id, "CloudEventsHeaders", 1, 1, 2);
    const v2 = await addEntityVersion(entity.entity.id, "CloudEventsHeaders", 2, 0, 3);
    headers = { entity: entity.entity, v1: entity.version, v11, v2 };
    trait = unwrap(await createTrait({ level: "DOMAIN", domainId: sc.domain.id }, {
      name: `CloudEvents-${sc.s}`, kind: "MESSAGE", headers: { entityId: entity.entity.id, entityVersionId: entity.version.id },
    }, ctx));
  }
  const traitIds = trait ? [trait.id] : [];
  const message = unwrap(await createMessage(sc.product.id, {
    name: `OrderCreated-${sc.s}`, spec: { contentType: "avro/binary", traitIds }, payload: { entityId: order.entity.id, entityVersionId: order.version.id },
  }, ctx));
  const mv = await prisma.messageVersion.create({
    data: {
      messageId: message.id, major: 1, minor: 0, sequence: 1, changeKind: "INITIAL", publishedById: ctx.userId, payloadEntityVersionId: order.version.id,
      resolvedSpec: {
        name: message.name, spec: { contentType: "avro/binary", traitIds }, headers: null, key: null,
        payload: { entityId: order.entity.id, entityName: "Order", entityVersionId: order.version.id, label: "1.0", major: 1 },
      },
    },
  });
  await prisma.message.update({ where: { id: message.id }, data: { latestVersionId: mv.id, hasUnpublishedChanges: false } });

  const channelInput = { name: `orders-${sc.s}`, address: "payments.orders.v1", protocol: "kafka", format: "avro", ...options.channel };
  const channel = unwrap(await createChannel(sc.product.id, channelInput, ctx));
  const created = unwrap(await createEventSpec(sc.product.id, { name: `checkout-service-${sc.s}`, title: "checkout-service" }, ctx));
  const document = {
    info: { title: "checkout-service" },
    servers: [{ key: "kafka-prod", protocol: "kafka", host: "kafka-prod.internal:9092" }],
    ...(options.defaultContentType ? { defaultContentType: options.defaultContentType } : {}),
    operations: [{ key: "publishOrderCreated", action: "send", channelId: channel.id, messageVersionIds: [mv.id], traitIds: [] }],
  };

  const channelRow = await prisma.channel.findUniqueOrThrow({ where: { id: channel.id }, select: CHANNEL_SELECT });
  let frozenChannels: unknown[] = [toResolvedChannel(channelRow)];
  let frozenTraits: unknown[] = [];
  if (trait) frozenTraits = [toFrozenTrait(await prisma.trait.findUniqueOrThrow({ where: { id: trait.id }, select: TRAIT_SELECT }))];
  if (options.frozenShape === "old") {
    const without = (rows: unknown[], keys: string[]) =>
      (rows as Array<Record<string, unknown>>).map((row) => Object.fromEntries(Object.entries(row).filter(([k]) => !keys.includes(k))));
    frozenChannels = without(frozenChannels, ["profile", "protocol"]);
    frozenTraits = without(frozenTraits, ["headersEntityId", "headersEntityVersionId"]);
  }
  const version = await prisma.eventSpecVersion.create({
    data: {
      eventSpecId: created.id, major: 2, minor: 0, sequence: 2, changeKind: "MAJOR", publishedById: ctx.userId,
      document: { asyncapi: "3.0.0", info: { title: "checkout-service", version: "2.0" } },
      sourceDocument: document, frozenChannels: frozenChannels as never, frozenTraits: frozenTraits as never,
      messageVersionIds: [mv.id], compatReport: { reasons: [], diagnostics: [] },
    },
  });
  await prisma.eventSpec.update({ where: { id: created.id }, data: { document, latestVersionId: version.id, hasUnpublishedChanges: false } });
  return { sc, channel, channelInput, spec: created, document, trait, headers, order, mv };
}

const preview = async (f: { sc: Scope; spec: { id: string } }) => unwrap(await previewEventSpecPublish(f.spec.id, f.sc.product.id, ctx, deps));
const setChannel = (id: string, data: Record<string, unknown>) => prisma.channel.update({ where: { id }, data });

/** What the Events list tab and the spec page show for this spec's badge. */
async function badges(f: { sc: Scope; spec: { id: string } }) {
  const list = await loadProductEventsData({
    tenantId: TENANT, domainId: f.sc.domain.id, productId: f.sc.product.id, domainSlug: f.sc.domain.slug, productSlug: f.sc.product.slug,
  });
  const page = await loadEventSpecPage({ domainSlug: f.sc.domain.slug, productSlug: f.sc.product.slug, specId: f.spec.id });
  return { list: list.events.eventSpecs.find((s) => s.id === f.spec.id)?.hasUnpublishedChanges, page: page?.spec.hasUnpublishedChanges };
}

describe.sequential("event spec bump classification and drift badges (R78, final review B-I1)", () => {
  it("a shared channel changing Avro -> JSON Schema (and dialect, protocol) is MAJOR with reasons; documentation-only edits stay MINOR; the badges follow every live drift", async () => {
    const domainIds: string[] = [];
    try {
      const f = await publishedSpec("r78c");
      domainIds.push(f.sc.domain.id);

      // Nothing changed since 2.0: no changes, no drift, no badge anywhere.
      const unchanged = await preview(f);
      expect(unchanged.blockers.map((b) => b.kind)).toEqual(["NO_CHANGES"]);
      expect(unchanged).toMatchObject({ latestLabel: "2.0", suggestedBump: "MINOR", reasons: [] });
      expect([...(await findEventSpecsWithCatalogDrift(prisma, TENANT, [f.spec.id]))]).toEqual([]);
      expect(await badges(f)).toEqual({ list: false, page: false });

      // A documentation-only live change is a change (badge, publishable) but not a breaking one: MINOR, no reasons.
      await setChannel(f.channel.id, { spec: { description: "Orders, now documented" } });
      const docsOnly = await preview(f);
      expect(docsOnly).toMatchObject({ blockers: [], suggestedBump: "MINOR", reasons: [], candidateLabels: { MAJOR: "3.0", MINOR: "2.1" } });
      expect([...(await findEventSpecsWithCatalogDrift(prisma, TENANT, [f.spec.id]))]).toEqual([f.spec.id]);
      expect(await badges(f)).toEqual({ list: true, page: true });
      await setChannel(f.channel.id, { spec: {} });
      expect(await badges(f)).toEqual({ list: false, page: false });

      // The B-I1 repro: Avro -> JSON Schema used to preview MINOR with no reasons (and publish 2.1).
      await setChannel(f.channel.id, { format: "json-schema", formatDialect: "draft-07" });
      const format = await preview(f);
      expect(format).toMatchObject({ suggestedBump: "MAJOR", latestLabel: "2.0", candidateLabels: { MAJOR: "3.0", MINOR: "2.1" } });
      expect(format.reasons).toEqual([`Channel ${f.channelInput.name}: format avro → json-schema`]);
      expect(await badges(f)).toEqual({ list: true, page: true });

      // The dialect of a JSON Schema channel is part of the contract too (frozen copy 2.0 was Avro: compare against a 2020-12 one).
      const json = await publishedSpec("r78d", { channel: { format: "json-schema", formatDialect: "draft-07" } });
      domainIds.push(json.sc.domain.id);
      await setChannel(json.channel.id, { formatDialect: "2020-12" });
      const dialect = await preview(json);
      expect(dialect.suggestedBump).toBe("MAJOR");
      expect(dialect.reasons).toEqual([`Channel ${json.channelInput.name}: JSON Schema dialect draft-07 → 2020-12`]);

      const proto = await publishedSpec("r78p");
      domainIds.push(proto.sc.domain.id);
      await setChannel(proto.channel.id, { protocol: "pulsar" });
      const protocol = await preview(proto);
      expect(protocol.suggestedBump).toBe("MAJOR");
      expect(protocol.reasons).toEqual([`Channel ${proto.channelInput.name}: protocol kafka → pulsar`]);
    } finally {
      await cleanupDomains(prisma, domainIds);
    }
  }, 120_000);

  it("a trait's headers pin moving to another entity major is MAJOR with a reason; within the same major it is MINOR; the badges follow", async () => {
    let domainId: string | undefined;
    try {
      const f = await publishedSpec("r78t", { withTrait: true });
      domainId = f.sc.domain.id;
      const { trait, headers } = f;
      if (!trait || !headers) throw new Error("fixture did not create the trait");
      expect((await preview(f)).blockers.map((b) => b.kind)).toEqual(["NO_CHANGES"]);

      await prisma.trait.update({ where: { id: trait.id }, data: { headersEntityVersionId: headers.v11.id } });
      const within = await preview(f);
      expect(within).toMatchObject({ blockers: [], suggestedBump: "MINOR" });
      expect(within.reasons).toEqual([`Trait ${trait.name}: headers pin moved from v1.0 to v1.1`]);
      expect(await badges(f)).toEqual({ list: true, page: true });

      await prisma.trait.update({ where: { id: trait.id }, data: { headersEntityVersionId: headers.v2.id } });
      const major = await preview(f);
      expect(major).toMatchObject({ blockers: [], suggestedBump: "MAJOR", candidateLabels: { MAJOR: "3.0", MINOR: "2.1" } });
      expect(major.reasons).toEqual([`Trait ${trait.name}: headers pin moved from CloudEventsHeaders v1.0 to v2.0 (new major)`]);

      // Removing the headers entity is MAJOR as well (the preview is then blocked or not by the pin rules, never silently MINOR).
      await prisma.trait.update({ where: { id: trait.id }, data: { headersEntityId: null, headersEntityVersionId: null } });
      const removed = await preview(f);
      expect(removed.suggestedBump).toBe("MAJOR");
      expect(removed.reasons).toEqual([`Trait ${trait.name}: headers entity removed (was CloudEventsHeaders v1.0)`]);
    } finally {
      await cleanupDomains(prisma, [domainId]);
    }
  }, 120_000);

  it("a changed spec defaultContentType is MAJOR with a reason (aligned with a Message's contentType)", async () => {
    let domainId: string | undefined;
    try {
      const f = await publishedSpec("r78x", { defaultContentType: "application/json" });
      domainId = f.sc.domain.id;
      expect((await preview(f)).blockers.map((b) => b.kind)).toEqual(["NO_CHANGES"]);
      await prisma.eventSpec.update({
        where: { id: f.spec.id },
        data: { document: { ...f.document, defaultContentType: "application/avro" }, hasUnpublishedChanges: true },
      });
      const changed = await preview(f);
      expect(changed).toMatchObject({ suggestedBump: "MAJOR", candidateLabels: { MAJOR: "3.0", MINOR: "2.1" } });
      expect(changed.reasons).toEqual(['defaultContentType changed from "application/json" to "application/avro"']);
    } finally {
      await cleanupDomains(prisma, [domainId]);
    }
  }, 120_000);

  it("a version frozen in an older shape (no channel profile / protocol, no trait headers fields) gets no false MAJOR", async () => {
    let domainId: string | undefined;
    try {
      const f = await publishedSpec("r78o", { withTrait: true, frozenShape: "old" });
      domainId = f.sc.domain.id;
      // The live rows carry fields the old copies lack, so the spec is publishable (D8) — but nothing breaking is inferred from that:
      // what an old frozen copy does not record is unknown, never compared, so even a live format change reads as MINOR here.
      const old = await preview(f);
      expect(old.blockers).toEqual([]);
      expect(old).toMatchObject({ suggestedBump: "MINOR", reasons: [] });
      await setChannel(f.channel.id, { format: "protobuf" });
      const changed = await preview(f);
      expect(changed).toMatchObject({ suggestedBump: "MINOR", reasons: [] });
    } finally {
      await cleanupDomains(prisma, [domainId]);
    }
  }, 120_000);
});
