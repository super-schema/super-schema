import "dotenv/config"; // first: @/lib/db (pulled in by the services) reads DB_PROVIDER at import time
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import { diagnostic } from "@/lib/event-specs/diagnostics";
import type { EventSpecValidator } from "@/lib/event-specs/validator";
import type { JsonObject } from "@/lib/event-specs/types";
import type { ServiceContext } from "@/types/service-context";
import { ok, err } from "@/types/result";
import { createArtifactRenderer, type ArtifactRenderer } from "@/services/events/artifact-renderer";
import { createChannel, updateChannel } from "@/services/events/channel.service";
import { createEventSpec, updateEventSpecDocument } from "@/services/events/event-spec.service";
import { emitEventSpec } from "@/services/events/event-spec-emit.service";
import { listEventSpecVersions, previewEventSpecPublish, publishEventSpec } from "@/services/events/event-spec-publish.service";
import { createMessage, deleteMessage } from "@/services/events/message.service";
import { createForeignTenant } from "./foreign-tenant";
import { cleanupDomains, connectTestDb, createProductScope, testContext, unwrap } from "./helpers";

let prisma: PrismaClient;
let ctx: ServiceContext;
let renderer: ArtifactRenderer;
beforeAll(async () => {
  prisma = connectTestDb();
  ctx = await testContext(prisma);
  renderer = createArtifactRenderer({ db: prisma });
});
afterAll(async () => prisma.$disconnect());

type Scope = Awaited<ReturnType<typeof createProductScope>>;

const addressOf = (doc: JsonObject | null, channelKey: string) => ((doc?.channels as JsonObject)[channelKey] as JsonObject).address;
const ownerOf = (sc: Scope) => ({ level: "PRODUCT" as const, productId: sc.product.id });
const blockerKinds = (r: { blockers: Array<{ kind: string }> }) => r.blockers.map((b) => b.kind);
const failure = <T>(r: { success: boolean; error?: T }) => (r.success ? null : (r.error as T));

/**
 * `publishEntity`, `publishMessage` and every spec publish write an immutable PUBLISH_VERSION audit row into the shared dev DB, so the
 * entity and message versions are inserted directly (the resolver reads only `resolvedSource` / the frozen pins); the suite publishes
 * an event spec only where the test is about publishing an event spec.
 */
async function frozenEntity(sc: Scope, name: string) {
  const entity = await sc.entity(name, [{ name: "id", type: "string" }]);
  const version = await prisma.entityVersion.create({
    data: {
      entityId: entity.id, major: 1, minor: 0, sequence: 1, changeKind: "INITIAL", publishedById: ctx.userId,
      resolvedSource: `model ${name} {\n  id: string;\n}\n`, fieldSnapshot: [{ name: "id", fieldNumber: 1 }],
    },
  });
  await prisma.entity.update({ where: { id: entity.id }, data: { latestVersionId: version.id, hasUnpublishedChanges: false, version: 1 } });
  return { entity, version };
}

/** A product with a pinned-payload draft message, a Kafka/Avro channel and an empty event spec. */
async function fixture(label = "evt") {
  const sc = await createProductScope(prisma, ctx, label);
  const order = await frozenEntity(sc, "Order");
  const message = unwrap(await createMessage(sc.product.id, {
    name: `OrderCreated-${sc.s}`, spec: { contentType: "avro/binary", traitIds: [] }, payload: { entityId: order.entity.id, entityVersionId: order.version.id },
  }, ctx));
  const channelInput = { name: `orders-${sc.s}`, address: "payments.orders.v1", protocol: "kafka", format: "avro" };
  const channel = unwrap(await createChannel(sc.product.id, channelInput, ctx));
  const spec = unwrap(await createEventSpec(sc.product.id, { name: `checkout-service-${sc.s}`, title: "checkout-service" }, ctx));
  const doc = (messageRef: string, channelId = channel.id) => ({
    info: { title: "checkout-service" },
    servers: [{ key: "kafka-prod", protocol: "kafka", host: "kafka-prod.internal:9092" }],
    operations: [{ key: "publishOrderCreated", action: "send", channelId, messageVersionIds: [messageRef], traitIds: [] }],
  });
  /** Freeze message version 1.0 (direct insert: no audit row), like `publishMessage` would. */
  const freezeMessage = async () => {
    const mv = await prisma.messageVersion.create({
      data: {
        messageId: message.id, major: 1, minor: 0, sequence: 1, changeKind: "INITIAL", publishedById: ctx.userId, payloadEntityVersionId: order.version.id,
        resolvedSpec: {
          name: message.name, spec: { contentType: "avro/binary", traitIds: [] }, headers: null, key: null,
          payload: { entityId: order.entity.id, entityName: "Order", entityVersionId: order.version.id, label: "1.0", major: 1 },
        },
      },
    });
    await prisma.message.update({ where: { id: message.id }, data: { latestVersionId: mv.id, hasUnpublishedChanges: false } });
    return mv;
  };
  return { sc, order, message, channelInput, channel, spec, doc, freezeMessage, owner: ownerOf(sc), deps: { renderer } };
}

/** A context whose `$transaction` runs `before` first (the unlocked plan has finished by then) and can wrap the tx client. */
function hookedContext(hooks: { before?: () => Promise<void>; wrapTx?: <T extends object>(tx: T) => T }): ServiceContext {
  let ran = false;
  return {
    ...ctx,
    prisma: new Proxy(prisma, {
      get(target, prop) {
        if (prop === "$transaction") {
          return async (fn: (tx: never) => Promise<unknown>, options?: unknown) => {
            if (!ran) {
              ran = true;
              await hooks.before?.();
            }
            return (target.$transaction as (...a: unknown[]) => Promise<unknown>).call(target, (tx: object) => fn((hooks.wrapTx ? hooks.wrapTx(tx) : tx) as never), options);
          };
        }
        const value: unknown = Reflect.get(target, prop, target);
        return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    }),
  };
}

const WRITE_METHODS = new Set(["create", "createMany", "update", "updateMany", "delete", "deleteMany", "upsert"]);

/** Records every raw statement and every model write a transaction issues, in order. */
function recordTx(log: string[]): <T extends object>(tx: T) => T {
  return <T extends object>(tx: T): T =>
    new Proxy(tx, {
      get(target, prop) {
        const value: unknown = Reflect.get(target, prop, target);
        if (prop === "$queryRaw") {
          return (strings: TemplateStringsArray, ...values: unknown[]) => {
            log.push(`raw ${strings.join("?").replace(/\s+/g, " ").trim()}`);
            return (value as (...a: unknown[]) => unknown).call(target, strings, ...values);
          };
        }
        if (typeof value === "object" && value !== null && typeof prop === "string" && !prop.startsWith("$")) {
          return new Proxy(value, {
            get(delegate, method) {
              const fn: unknown = Reflect.get(delegate, method, delegate);
              if (typeof fn !== "function") return fn;
              return (...args: unknown[]) => {
                if (typeof method === "string" && WRITE_METHODS.has(method)) log.push(`write ${prop}.${method}`);
                return (fn as (...a: unknown[]) => unknown).apply(delegate, args);
              };
            },
          });
        }
        return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    });
}

describe.sequential("event spec publish (spec §6.1, §7.4, D8, D11, R66, R67)", () => {
  it("blocks on draft messages, publishes 1.0, republishes a live channel change as MAJOR, keeps stored documents immutable", async () => {
    let domainId: string | undefined;
    try {
      const f = await fixture();
      domainId = f.sc.domain.id;
      const { sc, message, channel, spec, doc, owner, deps } = f;

      unwrap(await updateEventSpecDocument(spec.id, doc(message.id), owner, ctx));
      const blocked = unwrap(await previewEventSpecPublish(spec.id, sc.product.id, ctx, deps));
      expect(blockerKinds(blocked)).toEqual(["UNPUBLISHED_MESSAGE"]);
      expect(blocked).toMatchObject({ isFirstPublish: true, initialLabel: "1.0" });
      const refused = await publishEventSpec(spec.id, sc.product.id, {}, ctx, deps);
      expect(failure(refused)).toMatchObject({ code: "PUBLISH_BLOCKED" });
      expect(await prisma.eventSpecVersion.count({ where: { eventSpecId: spec.id } })).toBe(0);

      const mv = await f.freezeMessage();
      unwrap(await updateEventSpecDocument(spec.id, doc(mv.id), owner, ctx));
      expect(unwrap(await previewEventSpecPublish(spec.id, sc.product.id, ctx, deps))).toMatchObject({ isFirstPublish: true, blockers: [] });
      const v1 = unwrap(await publishEventSpec(spec.id, sc.product.id, { changeSummary: "first" }, ctx, deps));
      expect(v1).toMatchObject({ label: "1.0", changeKind: "INITIAL", sequence: 1, changeSummary: "first", publishedByName: expect.anything() });
      const stored = await prisma.eventSpecVersion.findUniqueOrThrow({ where: { id: v1.id } });
      expect((stored.document as JsonObject).info).toMatchObject({ title: "checkout-service", version: "1.0" });
      expect(stored.messageVersionIds).toEqual([mv.id]);
      expect(stored.publishedById).toBe(ctx.userId);
      expect(stored.sourceDocument).toMatchObject({ operations: [{ key: "publishOrderCreated", channelId: channel.id, messageVersionIds: [mv.id] }] });
      expect((stored.frozenChannels as Array<{ id: string; address: string }>).map((c) => [c.id, c.address])).toEqual([[channel.id, "payments.orders.v1"]]);
      expect(stored.frozenTraits).toEqual([]);
      expect(stored.compatReport).toMatchObject({ reasons: [] });
      const refs = await prisma.schemaReference.findMany({ where: { fromKind: "EVENT_SPEC_VERSION", fromId: v1.id } });
      expect(refs.map((r) => [r.role, r.toKind, r.toId, r.isDraft])).toEqual([["MESSAGE", "MESSAGE_VERSION", mv.id, false]]);
      expect(await prisma.eventSpec.findUniqueOrThrow({ where: { id: spec.id } })).toMatchObject({ latestVersionId: v1.id, hasUnpublishedChanges: false });
      // The draft's own (isDraft = true) edge survives the publish.
      expect((await prisma.schemaReference.findMany({ where: { fromKind: "EVENT_SPEC", fromId: spec.id } })).map((r) => [r.toId, r.isDraft])).toEqual([[mv.id, true]]);

      const again = await publishEventSpec(spec.id, sc.product.id, {}, ctx, deps);
      expect(failure(again)).toMatchObject({ code: "PUBLISH_BLOCKED" });
      expect(JSON.stringify(failure(again)?.details)).toContain("NO_CHANGES");

      // D8: a live channel change makes the spec publishable and is classified MAJOR (address change).
      unwrap(await updateChannel(channel.id, { ...f.channelInput, address: "payments.orders.v2" }, owner, ctx));
      const majorPreview = unwrap(await previewEventSpecPublish(spec.id, sc.product.id, ctx, deps));
      expect(majorPreview).toMatchObject({ suggestedBump: "MAJOR", latestLabel: "1.0", candidateLabels: { MAJOR: "2.0", MINOR: "1.1" }, blockers: [] });
      expect(majorPreview.reasons.join(" ")).toContain('address changed from "payments.orders.v1" to "payments.orders.v2"');
      expect(failure(await publishEventSpec(spec.id, sc.product.id, { bump: "MINOR" }, ctx, deps))).toMatchObject({ code: "BUMP_TOO_LOW" });
      expect(await prisma.eventSpecVersion.count({ where: { eventSpecId: spec.id } })).toBe(1);
      const v2 = unwrap(await publishEventSpec(spec.id, sc.product.id, {}, ctx, deps));
      expect(v2).toMatchObject({ label: "2.0", changeKind: "MAJOR", sequence: 2 });
      expect((await prisma.eventSpecVersion.findUniqueOrThrow({ where: { id: v2.id } })).compatReport).toMatchObject({ reasons: majorPreview.reasons });

      // Published documents are never regenerated (spec §7.2 step 1) and are immutable rows.
      const old = unwrap(await emitEventSpec(spec.id, { versionLabel: "1.0" }, ctx));
      expect(addressOf(old.document, channel.name)).toBe("payments.orders.v1");
      const latest = unwrap(await emitEventSpec(spec.id, { versionLabel: "2.0" }, ctx));
      expect(addressOf(latest.document, channel.name)).toBe("payments.orders.v2");
      await expect(prisma.eventSpecVersion.update({ where: { id: v1.id }, data: { changeSummary: "x" } })).rejects.toThrow(/immutable/);
      expect(unwrap(await listEventSpecVersions(spec.id, sc.product.id, ctx)).map((v) => v.label)).toEqual(["2.0", "1.0"]);
      expect((await prisma.schemaReference.findMany({ where: { fromKind: "EVENT_SPEC_VERSION", fromId: v1.id } })).map((r) => r.toId)).toEqual([mv.id]);

      // Unresolved references (a deleted channel the draft still names) block together, nothing is written and nothing crashes.
      await prisma.eventSpec.update({
        where: { id: spec.id },
        data: { hasUnpublishedChanges: true, document: { ...doc(mv.id), operations: [{ key: "op", action: "send", channelId: "gone", messageVersionIds: [mv.id], traitIds: [] }] } },
      });
      const unresolved = unwrap(await previewEventSpecPublish(spec.id, sc.product.id, ctx, deps));
      expect(blockerKinds(unresolved)).toContain("UNRESOLVED_REFERENCE");
      expect(unresolved.blockers.find((b) => b.kind === "UNRESOLVED_REFERENCE")).toMatchObject({ pointer: "/operations/0/channelId" });
      expect(failure(await publishEventSpec(spec.id, sc.product.id, {}, ctx, deps))).toMatchObject({ code: "PUBLISH_BLOCKED" });
      expect(await prisma.eventSpecVersion.count({ where: { eventSpecId: spec.id } })).toBe(2);
    } finally {
      await cleanupDomains(prisma, [domainId]);
    }
  }, 240_000);

  it("reports every blocker together (draft message, name conflict, validation error) and writes nothing", async () => {
    let domainId: string | undefined;
    try {
      const f = await fixture();
      domainId = f.sc.domain.id;
      const { sc, message, spec, doc, owner } = f;
      unwrap(await updateEventSpecDocument(spec.id, doc(message.id), owner, ctx));
      // A line-level name clash: a trait in the same domain carrying the spec's name.
      await prisma.trait.create({ data: { name: spec.name, kind: "OPERATION", tenantId: sc.domain.tenantId, domainId: sc.domain.id } });
      const failingValidator: EventSpecValidator = {
        name: "fake", validate: async () => ok([diagnostic("error", "FAKE_RULE", "channel address is not allowed", "/channels")]),
      };
      const deps = { renderer, validators: [failingValidator] };

      const preview = unwrap(await previewEventSpecPublish(spec.id, sc.product.id, ctx, deps));
      expect(blockerKinds(preview)).toEqual(["UNPUBLISHED_MESSAGE", "VALIDATION_ERROR", "NAME_CONFLICT"]);
      expect(preview.blockers[1]).toMatchObject({ message: "FAKE_RULE: channel address is not allowed", pointer: "/channels" });

      const refused = await publishEventSpec(spec.id, sc.product.id, {}, ctx, deps);
      const details = failure(refused)?.details as { blockers: Array<{ kind: string }> };
      expect(failure(refused)?.code).toBe("PUBLISH_BLOCKED");
      expect(details.blockers.map((b) => b.kind)).toEqual(["UNPUBLISHED_MESSAGE", "VALIDATION_ERROR", "NAME_CONFLICT"]);
      expect(await prisma.eventSpecVersion.count({ where: { eventSpecId: spec.id } })).toBe(0);
      expect(await prisma.eventSpec.findUniqueOrThrow({ where: { id: spec.id } })).toMatchObject({ latestVersionId: null, hasUnpublishedChanges: true });
    } finally {
      await cleanupDomains(prisma, [domainId]);
    }
  }, 240_000);

  it("shows only sanitized render / validator failures (R67) and still blocks on a renderer UNRESOLVED_REFERENCE", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let domainId: string | undefined;
    try {
      const f = await fixture();
      domainId = f.sc.domain.id;
      const { sc, spec, doc, owner } = f;
      const mv = await f.freezeMessage();
      unwrap(await updateEventSpecDocument(spec.id, doc(mv.id), owner, ctx));

      // An unexpected renderer failure: raw tsp output (a temp path and a secret) is replaced by a generic text and logged.
      const secret = "tsp crashed at /private/var/folders/ab/cd/superschema-tsp-xyz/main.tsp password=hunter2";
      const crashing: ArtifactRenderer = { render: async () => err({ code: "EMITTER_FAILED", message: secret }) };
      const crashed = unwrap(await previewEventSpecPublish(spec.id, sc.product.id, ctx, { renderer: crashing }));
      expect(crashed.blockers.length).toBeGreaterThan(0);
      expect(crashed.blockers.every((b) => b.kind === "VALIDATION_ERROR")).toBe(true);
      expect(crashed.blockers[0].message).toContain("Artifact render failed");
      expect(JSON.stringify(crashed)).not.toMatch(/hunter2|superschema-tsp|\/private\/var/);
      expect(consoleError.mock.calls.flat().join(" ")).toContain("hunter2");

      // A renderer error whose code collides with the draft-reference code must still block (its text is safe to show).
      const unresolvedRender: ArtifactRenderer = {
        render: async () => err({ code: "UNRESOLVED_REFERENCE", message: "Field owner references entity Customer, which cannot be resolved" }),
      };
      const blocked = unwrap(await previewEventSpecPublish(spec.id, sc.product.id, ctx, { renderer: unresolvedRender }));
      expect(blocked.blockers.some((b) => b.kind === "VALIDATION_ERROR" && b.message.includes("cannot be resolved"))).toBe(true);
      expect(failure(await publishEventSpec(spec.id, sc.product.id, {}, ctx, { renderer: unresolvedRender }))).toMatchObject({ code: "PUBLISH_BLOCKED" });

      // A validator that throws: the parser's raw text never leaves the service (generic message, original logged).
      const boom: EventSpecValidator = { name: "boom", validate: async () => { throw new Error("parser exploded: connection string postgres://admin:s3cret@db"); } };
      for (const result of [
        await previewEventSpecPublish(spec.id, sc.product.id, ctx, { renderer, validators: [boom] }),
        await publishEventSpec(spec.id, sc.product.id, {}, ctx, { renderer, validators: [boom] }),
      ]) {
        expect(failure(result)).toMatchObject({ code: "VALIDATOR_FAILED" });
        expect(JSON.stringify(result)).not.toMatch(/s3cret|exploded/);
      }
      expect(consoleError.mock.calls.flat().join(" ")).toContain("s3cret");
      expect(await prisma.eventSpecVersion.count({ where: { eventSpecId: spec.id } })).toBe(0);
    } finally {
      consoleError.mockRestore();
      await cleanupDomains(prisma, [domainId]);
    }
  }, 240_000);

  it("enforces product ownership (R66): another product's / tenant's spec is FORBIDDEN, unknown ids NOT_FOUND, nothing written or leaked", async () => {
    let foreign: Awaited<ReturnType<typeof createForeignTenant>> | undefined;
    const domainIds: string[] = [];
    try {
      const owning = await fixture("own");
      const other = await createProductScope(prisma, ctx, "oth");
      domainIds.push(owning.sc.domain.id, other.domain.id);
      foreign = await createForeignTenant(prisma, ctx);
      const foreignSpec = await prisma.eventSpec.create({
        data: {
          name: `ForeignSpec-${foreign.tenant.slug}`, tenantId: foreign.tenant.id, domainId: foreign.domain.id, productId: foreign.product.id,
          document: { info: { title: "foreign-secret-title" }, servers: [], operations: [] },
        },
      });

      // A publishable spec with an already-published version (inserted directly: no audit row) whose publisher / document a leak would show.
      const mv = await owning.freezeMessage();
      unwrap(await updateEventSpecDocument(owning.spec.id, owning.doc(mv.id), owning.owner, ctx));
      const published = await prisma.eventSpecVersion.create({
        data: {
          eventSpecId: owning.spec.id, major: 1, minor: 0, sequence: 1, changeKind: "INITIAL", publishedById: ctx.userId,
          document: { asyncapi: "3.0.0", info: { title: "checkout-service", version: "1.0" } },
          sourceDocument: owning.doc(mv.id), frozenChannels: [], frozenTraits: [], messageVersionIds: [mv.id],
        },
      });
      // Pointed at as the latest version, so an unguarded publish would succeed as 1.1 (a missing check writes, it does not just collide).
      await prisma.eventSpec.update({ where: { id: owning.spec.id }, data: { latestVersionId: published.id } });

      const attempt = async (specId: string, productId: string, code: string, leaks: string[]) => {
        const results = [
          await publishEventSpec(specId, productId, {}, ctx, owning.deps),
          await previewEventSpecPublish(specId, productId, ctx, owning.deps),
          await listEventSpecVersions(specId, productId, ctx),
        ];
        for (const r of results) {
          expect(failure(r)?.code).toBe(code);
          expect(failure(r) && "details" in (failure(r) as object)).toBe(false);
          for (const leak of leaks) expect(JSON.stringify(r)).not.toContain(leak);
        }
      };
      const owningLeaks = [owning.spec.name, owning.message.name, owning.channel.name, "payments.orders.v1", mv.id, ctx.userId];
      const foreignLeaks = [foreignSpec.name, "foreign-secret-title"];

      await attempt(owning.spec.id, other.product.id, "FORBIDDEN", owningLeaks); // same tenant, another product
      await attempt(owning.spec.id, foreign.product.id, "FORBIDDEN", owningLeaks); // a product of another tenant
      await attempt(foreignSpec.id, owning.sc.product.id, "FORBIDDEN", foreignLeaks); // another tenant's spec
      await attempt("no-such-spec", owning.sc.product.id, "NOT_FOUND", owningLeaks);
      await attempt(owning.spec.id, "no-such-product", "NOT_FOUND", owningLeaks);

      // Nothing was written: no new versions, drafts untouched.
      expect(await prisma.eventSpecVersion.count({ where: { eventSpecId: owning.spec.id } })).toBe(1);
      expect(await prisma.eventSpec.findUniqueOrThrow({ where: { id: owning.spec.id } })).toMatchObject({ latestVersionId: published.id, hasUnpublishedChanges: true });
      expect(await prisma.eventSpecVersion.count({ where: { eventSpecId: foreignSpec.id } })).toBe(0);
      expect(await prisma.eventSpec.findUniqueOrThrow({ where: { id: foreignSpec.id } })).toMatchObject({ latestVersionId: null, hasUnpublishedChanges: true });

      // The owning product still reads its own spec.
      expect(unwrap(await previewEventSpecPublish(owning.spec.id, owning.sc.product.id, ctx, owning.deps))).toMatchObject({ isFirstPublish: false, latestLabel: "1.0", blockers: [] });
      expect(unwrap(await listEventSpecVersions(owning.spec.id, owning.sc.product.id, ctx)).map((v) => [v.id, v.label])).toEqual([[published.id, "1.0"]]);
    } finally {
      await cleanupDomains(prisma, domainIds);
      await foreign?.cleanup();
    }
  }, 240_000);

  it("takes event_specs FOR UPDATE, then messages FOR SHARE (ORDER BY id), verifies, and only then writes", async () => {
    let domainId: string | undefined;
    try {
      const f = await fixture();
      domainId = f.sc.domain.id;
      const { sc, spec, doc, owner, deps } = f;
      const mv = await f.freezeMessage();
      unwrap(await updateEventSpecDocument(spec.id, doc(mv.id), owner, ctx));

      const log: string[] = [];
      const published = unwrap(await publishEventSpec(spec.id, sc.product.id, {}, hookedContext({ wrapTx: recordTx(log) }), deps));
      expect(published.label).toBe("1.0");

      const specLock = log.findIndex((l) => /^raw SELECT "id" FROM "event_specs" WHERE "id" = \? FOR UPDATE$/.test(l));
      const messageLock = log.findIndex((l) => /^raw SELECT "id" FROM "messages" WHERE "id" IN \(.*\) ORDER BY "id" FOR SHARE$/.test(l));
      const firstWrite = log.findIndex((l) => l.startsWith("write "));
      expect(specLock).toBe(0);
      expect(messageLock).toBeGreaterThan(specLock);
      expect(firstWrite).toBeGreaterThan(messageLock);
      expect(log[firstWrite]).toBe("write eventSpecVersion.create");
      // No other lock statement: in particular the messages are never taken FOR UPDATE (that is the delete path's lock).
      expect(log.filter((l) => l.startsWith("raw "))).toHaveLength(2);
      expect(log.slice(firstWrite).every((l) => l.startsWith("write "))).toBe(true);
    } finally {
      await cleanupDomains(prisma, [domainId]);
    }
  }, 240_000);

  it("re-verifies under the lock: a spec edit, a live channel edit, or a removed pinned message after the plan aborts with a retryable CONFLICT and writes nothing", async () => {
    let domainId: string | undefined;
    try {
      const f = await fixture();
      domainId = f.sc.domain.id;
      const { sc, spec, doc, owner, deps, channel, message } = f;
      const mv = await f.freezeMessage();
      unwrap(await updateEventSpecDocument(spec.id, doc(mv.id), owner, ctx));

      // 1. The draft is edited after the plan.
      const edited = await publishEventSpec(spec.id, sc.product.id, {}, hookedContext({
        before: async () => {
          unwrap(await updateEventSpecDocument(spec.id, { ...doc(mv.id), info: { title: "checkout-service", summary: "edited mid-publish" } }, owner, ctx));
        },
      }), deps);
      expect(failure(edited)).toMatchObject({ code: "CONFLICT", message: "The event spec changed while publishing." });

      // 2. A live channel is edited after the plan (the document was rendered with the old address).
      const channelEdited = await publishEventSpec(spec.id, sc.product.id, {}, hookedContext({
        before: async () => {
          unwrap(await updateChannel(channel.id, { ...f.channelInput, address: "payments.orders.v9" }, owner, ctx));
        },
      }), deps);
      expect(failure(channelEdited)).toMatchObject({ code: "CONFLICT" });

      // 3. A pinned message is deleted after the plan (spec versions pinning it do not exist yet, so the delete is allowed).
      const removed = await publishEventSpec(spec.id, sc.product.id, {}, hookedContext({
        before: async () => {
          unwrap(await deleteMessage(message.id, owner, ctx));
        },
      }), deps);
      expect(failure(removed)).toMatchObject({ code: "CONFLICT", message: "A message pinned by this spec was removed; reload and retry" });

      expect(await prisma.eventSpecVersion.count({ where: { eventSpecId: spec.id } })).toBe(0);
      expect(await prisma.eventSpec.findUniqueOrThrow({ where: { id: spec.id } })).toMatchObject({ latestVersionId: null, hasUnpublishedChanges: true });
      // The deleted message is now an unresolved reference: reported as a blocker, never a crash.
      const afterDelete = unwrap(await previewEventSpecPublish(spec.id, sc.product.id, ctx, deps));
      expect(blockerKinds(afterDelete)).toContain("UNRESOLVED_REFERENCE");
    } finally {
      await cleanupDomains(prisma, [domainId]);
    }
  }, 240_000);

  it("maps an FK / unique failure raised inside the publish transaction to CONFLICT, not IN_USE", async () => {
    let domainId: string | undefined;
    try {
      const f = await fixture();
      domainId = f.sc.domain.id;
      const { sc, spec, doc, owner, deps } = f;
      const mv = await f.freezeMessage();
      unwrap(await updateEventSpecDocument(spec.id, doc(mv.id), owner, ctx));
      for (const code of ["P2003", "P2002", "P2034"]) {
        const racing: ServiceContext = {
          ...ctx,
          prisma: new Proxy(prisma, {
            get(target, prop) {
              if (prop === "$transaction") return async () => { throw Object.assign(new Error(`constraint ${code}`), { code }); };
              const value: unknown = Reflect.get(target, prop, target);
              return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
            },
          }),
        };
        const result = await publishEventSpec(spec.id, sc.product.id, {}, racing, deps);
        expect(failure(result)).toMatchObject({ code: "CONFLICT" });
      }
      expect(await prisma.eventSpecVersion.count({ where: { eventSpecId: spec.id } })).toBe(0);
    } finally {
      await cleanupDomains(prisma, [domainId]);
    }
  }, 240_000);

  it("serializes concurrent publishes of one spec (exactly one wins)", async () => {
    let domainId: string | undefined;
    try {
      const f = await fixture();
      domainId = f.sc.domain.id;
      const { sc, spec, doc, owner, deps } = f;
      const mv = await f.freezeMessage();
      unwrap(await updateEventSpecDocument(spec.id, doc(mv.id), owner, ctx));

      const results = await Promise.all([
        publishEventSpec(spec.id, sc.product.id, {}, ctx, deps),
        publishEventSpec(spec.id, sc.product.id, {}, ctx, deps),
      ]);
      expect(results.filter((r) => r.success)).toHaveLength(1);
      const loser = results.find((r) => !r.success);
      expect(["PUBLISH_BLOCKED", "CONFLICT"]).toContain(failure(loser ?? { success: true })?.code);
      expect(await prisma.eventSpecVersion.count({ where: { eventSpecId: spec.id } })).toBe(1);
      expect(await prisma.eventSpec.findUniqueOrThrow({ where: { id: spec.id } })).toMatchObject({ hasUnpublishedChanges: false });
    } finally {
      await cleanupDomains(prisma, [domainId]);
    }
  }, 240_000);

  it("publishes a cross-product consumer spec against another product's channel and message; the pinned message then cannot be deleted", async () => {
    const domainIds: string[] = [];
    try {
      const producer = await fixture("prod");
      const consumer = await createProductScope(prisma, ctx, "cons");
      domainIds.push(producer.sc.domain.id, consumer.domain.id);
      const mv = await producer.freezeMessage();
      const consumerSpec = unwrap(await createEventSpec(consumer.product.id, { name: `fraud-scorer-${consumer.s}`, title: "fraud-scorer" }, ctx));
      unwrap(await updateEventSpecDocument(consumerSpec.id, {
        info: { title: "fraud-scorer" }, servers: [],
        operations: [{ key: "consumeOrderCreated", action: "receive", channelId: producer.channel.id, messageVersionIds: [mv.id], traitIds: [] }],
      }, ownerOf(consumer), ctx));

      const v1 = unwrap(await publishEventSpec(consumerSpec.id, consumer.product.id, {}, ctx, producer.deps));
      expect(v1).toMatchObject({ label: "1.0", changeKind: "INITIAL" });
      const stored = await prisma.eventSpecVersion.findUniqueOrThrow({ where: { id: v1.id } });
      expect(stored.messageVersionIds).toEqual([mv.id]);
      expect((stored.frozenChannels as Array<{ id: string; productSlug: string }>).map((c) => [c.id, c.productSlug])).toEqual([[producer.channel.id, producer.sc.product.slug]]);

      // The producer's owner may not publish the consumer's spec (R66), and the producer's message is now pinned by a published spec.
      expect(failure(await publishEventSpec(consumerSpec.id, producer.sc.product.id, {}, ctx, producer.deps))).toMatchObject({ code: "FORBIDDEN" });
      expect(failure(await deleteMessage(producer.message.id, producer.owner, ctx))).toMatchObject({ code: "IN_USE" });
    } finally {
      await cleanupDomains(prisma, domainIds);
    }
  }, 240_000);
});
