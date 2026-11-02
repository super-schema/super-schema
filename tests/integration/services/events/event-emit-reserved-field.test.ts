import "dotenv/config"; // before any import that reaches @/lib/db, which reads DB_PROVIDER when first evaluated
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import { PARSER_UNSAFE_KEYS, RESERVED_KEYS } from "@/lib/event-specs/own-property";
import { emptyEventDocument, type EventDocument } from "@/lib/events/document/types";
import { emitEventDraft } from "@/services/events/event-emit.service";
import { previewEventPublish, publishEvent } from "@/services/events/event-publish.service";
import type { ServiceContext } from "@/types/service-context";
import { cleanupDomains, connectTestDb, createProductScope, stamp, TENANT, testContext, unwrap } from "./helpers";

/**
 * An entity field (or an entity NAME) that is a parser-unsafe key and is already in the database (created before the rule that refuses it:
 * here it is inserted straight into the table) reaches the AsyncAPI document verbatim, and the AsyncAPI parser cannot read a document that has
 * it as a JSON Schema property or definition. The REAL renderer (TypeSpec emitters), the REAL emit service and the REAL parser: the user gets
 * one clear error that names the field (or the entity), the message and where to fix it, never the parser's crash text, and publish is
 * blocked with it.
 *
 * The name is taken from the one list (`PARSER_UNSAFE_KEYS`); when that list is lifted down to nothing, delete this file (the sweep test says so).
 */

/** The parser-unsafe name that is also a legal TypeSpec identifier (`__proto__` is not a name the generators write bare). */
const UNSAFE = [...PARSER_UNSAFE_KEYS].find((key) => !RESERVED_KEYS.has(key)) as string;

let prisma: PrismaClient;
let ctx: ServiceContext;
let scope: Awaited<ReturnType<typeof createProductScope>>;
let entity: { id: string; name: string };
let version: { id: string };
/** An entity that is NAMED `UNSAFE`, and a holder entity whose `address` field refers to it. */
let named: { id: string };
let holder: { id: string; versionId: string };

const REASON = "is a built-in JavaScript name that AsyncAPI tools cannot read, so this document cannot be published with it.";
const MESSAGE = (message: string) => `The field "${UNSAFE}" in the payload of the message "${message}" ${REASON} Rename the field in its entity.`;
const POINTER = (message: string) => `/components/messages/${message}/payload/schema/properties/${UNSAFE}`;
const NAME_MESSAGE = `The name "${UNSAFE}" ${REASON} Rename the entity (or model).`;
const NAME_POINTER = (message: string) => `/components/messages/${message}/payload/schema/definitions/${UNSAFE}`;
const LEAKS = /\n\s+at \S+ \(|node_modules|\/Users\/|\/home\/|TypeError|uncaught-error|ASYNCAPI_PARSER_CRASHED/;

beforeAll(async () => {
  prisma = connectTestDb();
  ctx = await testContext(prisma);
  scope = await createProductScope(prisma, ctx, "rf");
  const name = `Probe${stamp()}`;
  entity = await scope.entity(name, [{ name: "id", type: "string" }, { name: UNSAFE, type: "string" }]);
  version = await prisma.entityVersion.create({
    data: {
      entityId: entity.id, major: 1, minor: 0, sequence: 1, changeKind: "INITIAL", publishedById: ctx.userId,
      resolvedSource: `model ${name} {\n  id: string;\n  ${UNSAFE}: string;\n}\n`, fieldSnapshot: [{ name: "id", fieldNumber: 1 }, { name: UNSAFE, fieldNumber: 2 }],
    },
  });

  // an entity called `UNSAFE` (a legal TypeSpec model name), frozen as version 1.0, and a holder whose version pins it (a FIELD edge)
  named = await scope.entity(UNSAFE, [{ name: "street", type: "string" }]);
  const namedVersion = await prisma.entityVersion.create({
    data: {
      entityId: named.id, major: 1, minor: 0, sequence: 1, changeKind: "INITIAL", publishedById: ctx.userId,
      resolvedSource: `model ${UNSAFE} {\n  street: string;\n}\n`, fieldSnapshot: [{ name: "street", fieldNumber: 1 }],
    },
  });
  const holderName = `Holder${stamp()}`;
  const holderEntity = await scope.entity(holderName, [{ name: "id", type: "string" }]);
  const holderVersion = await prisma.entityVersion.create({
    data: {
      entityId: holderEntity.id, major: 1, minor: 0, sequence: 1, changeKind: "INITIAL", publishedById: ctx.userId,
      resolvedSource: `model ${holderName} {\n  id: string;\n  address: ${UNSAFE};\n}\n`, fieldSnapshot: [{ name: "id", fieldNumber: 1 }, { name: "address", fieldNumber: 2 }],
    },
  });
  await prisma.schemaReference.create({
    data: { fromKind: "ENTITY_VERSION", fromId: holderVersion.id, role: "FIELD", toKind: "ENTITY_VERSION", toId: namedVersion.id },
  });
  holder = { id: holderEntity.id, versionId: holderVersion.id };
}, 180_000);

afterAll(async () => {
  await cleanupDomains(prisma, [scope?.domain.id]);
  await prisma.$disconnect();
});

type Format = "json-schema" | "avro" | "protobuf";

/** One Kafka channel in `format`, one message `probe-created` pinned to `target` (the published version, or the entity's draft), one send operation. */
async function seedEvent(format: Format, pinned: boolean, target: { entityId: string; versionId: string } = { entityId: entity.id, versionId: version.id }) {
  const document: EventDocument = {
    ...emptyEventDocument("probe-service"),
    servers: [{ key: "kafka-prod", protocol: "kafka", host: "kafka-prod.internal:9092" }],
    channels: [{ key: "orders", address: "probe.orders.v1", protocol: "kafka", serverKeys: ["kafka-prod"], format, ...(format === "json-schema" ? { formatDialect: "draft-07" } : {}), messageKeys: ["probe-created"] } as EventDocument["channels"][number]],
    messages: [{ key: "probe-created", payload: { entityId: target.entityId, entityVersionId: pinned ? target.versionId : null }, traitKeys: [] }],
    operations: [{ key: "sendProbe", action: "send", channelKey: "orders", messageKeys: ["probe-created"], traitKeys: [] }],
  };
  return prisma.eventSpec.create({
    data: { name: `evt-${stamp()}`, tenantId: TENANT, domainId: scope.domain.id, productId: scope.product.id, document: document as unknown as Prisma.InputJsonValue },
  });
}

const errorsOf = <T extends { severity: string }>(list: T[]): T[] => list.filter((d) => d.severity === "error");

describe("an entity field named like a parser-unsafe key, through the real emit and publish path", { concurrent: false }, () => {
  it("JSON Schema payload: the field reaches the document as a property and the emission returns ONE clear error that names it", async () => {
    const event = await seedEvent("json-schema", false);

    const out = unwrap(await emitEventDraft(event.id, scope.product.id, ctx));

    expect(errorsOf(out.diagnostics)).toEqual([
      { severity: "error", code: "PARSER_UNSAFE_KEY", message: MESSAGE("probe-created"), pointer: POINTER("probe-created") },
    ]);
    // the name arrives verbatim (not slugged to lower case, which the parser would read)
    expect(out.json).toContain(`"${UNSAFE}": {`);
    expect(JSON.stringify(out.diagnostics)).not.toMatch(LEAKS);
  }, 120_000);

  it("Avro and Protobuf payloads carry the name verbatim too, but as a VALUE, so the parser reads it: no error", async () => {
    for (const format of ["avro", "protobuf"] as const) {
      const event = await seedEvent(format, false);
      const out = unwrap(await emitEventDraft(event.id, scope.product.id, ctx));
      expect(errorsOf(out.diagnostics), format).toEqual([]);
      expect(out.json, format).toContain(UNSAFE);
    }
  }, 120_000);

  it("publish is blocked with that diagnostic, nothing is written, and the preview shows the same blocker", async () => {
    const event = await seedEvent("json-schema", true);
    const blocker = { kind: "VALIDATION_ERROR", pointer: POINTER("probe-created"), message: MESSAGE("probe-created") };

    const result = await publishEvent(event.id, scope.product.id, {}, ctx);

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe("PUBLISH_BLOCKED");
    expect((result.error.details as { blockers: unknown[] }).blockers).toEqual([blocker]);
    expect(JSON.stringify(result.error)).not.toMatch(LEAKS);
    expect(await prisma.eventSpecVersion.count({ where: { eventSpecId: event.id } })).toBe(0);
    expect((await prisma.eventSpec.findUniqueOrThrow({ where: { id: event.id } })).latestVersionId).toBeNull();

    const analysis = unwrap(await previewEventPublish(event.id, scope.product.id, ctx));
    expect(analysis.blockers).toEqual([blocker]);
  }, 120_000);
});

describe("an entity NAMED like a parser-unsafe key, referenced from a payload", { concurrent: false }, () => {
  it("JSON Schema payload: the name is a definition key, and the user is told to rename the ENTITY, not a field", async () => {
    const event = await seedEvent("json-schema", true, { entityId: holder.id, versionId: holder.versionId });

    const out = unwrap(await emitEventDraft(event.id, scope.product.id, ctx));

    expect(errorsOf(out.diagnostics)).toEqual([
      { severity: "error", code: "PARSER_UNSAFE_KEY", message: NAME_MESSAGE, pointer: NAME_POINTER("probe-created") },
    ]);
    expect(JSON.stringify(out.diagnostics)).not.toMatch(LEAKS);
  }, 120_000);

  it("publish is blocked with that message", async () => {
    const event = await seedEvent("json-schema", true, { entityId: holder.id, versionId: holder.versionId });

    const result = await publishEvent(event.id, scope.product.id, {}, ctx);

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe("PUBLISH_BLOCKED");
    expect((result.error.details as { blockers: unknown[] }).blockers).toEqual([{ kind: "VALIDATION_ERROR", pointer: NAME_POINTER("probe-created"), message: NAME_MESSAGE }]);
    expect(await prisma.eventSpecVersion.count({ where: { eventSpecId: event.id } })).toBe(0);
  }, 120_000);
});
