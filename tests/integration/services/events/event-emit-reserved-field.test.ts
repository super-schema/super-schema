import "dotenv/config"; // before any import that reaches @/lib/db, which reads DB_PROVIDER when first evaluated
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import { emptyEventDocument, type EventDocument } from "@/lib/events/document/types";
import { emitEventDraft } from "@/services/events/event-emit.service";
import { previewEventPublish, publishEvent } from "@/services/events/event-publish.service";
import type { ServiceContext } from "@/types/service-context";
import { cleanupDomains, connectTestDb, createProductScope, stamp, TENANT, testContext, unwrap } from "./helpers";

/**
 * An entity field named `hasOwnProperty` that is already in the database (created before the rule that refuses the name: here it is
 * inserted straight into the table) reaches the AsyncAPI document verbatim, and the AsyncAPI parser cannot read a document that has it as
 * a JSON Schema property. The REAL renderer (TypeSpec emitters), the REAL emit service and the REAL parser: the user gets one clear error
 * that names the field, the message and where to fix it, never the parser's crash text, and publish is blocked with it.
 */

let prisma: PrismaClient;
let ctx: ServiceContext;
let scope: Awaited<ReturnType<typeof createProductScope>>;
let entity: { id: string; name: string };
let version: { id: string };

const MESSAGE = (message: string) =>
  `The field "hasOwnProperty" in the payload of the message "${message}" is a built-in JavaScript name that AsyncAPI tools cannot read, so this document cannot be published with it. Rename the field in its entity.`;
const POINTER = (message: string) => `/components/messages/${message}/payload/schema/properties/hasOwnProperty`;
const LEAKS = /\n\s+at \S+ \(|node_modules|\/Users\/|\/home\/|TypeError|uncaught-error|ASYNCAPI_PARSER_CRASHED/;

beforeAll(async () => {
  prisma = connectTestDb();
  ctx = await testContext(prisma);
  scope = await createProductScope(prisma, ctx, "rf");
  const name = `Probe${stamp()}`;
  entity = await scope.entity(name, [{ name: "id", type: "string" }, { name: "hasOwnProperty", type: "string" }]);
  version = await prisma.entityVersion.create({
    data: {
      entityId: entity.id, major: 1, minor: 0, sequence: 1, changeKind: "INITIAL", publishedById: ctx.userId,
      resolvedSource: `model ${name} {\n  id: string;\n  hasOwnProperty: string;\n}\n`, fieldSnapshot: [{ name: "id", fieldNumber: 1 }, { name: "hasOwnProperty", fieldNumber: 2 }],
    },
  });
}, 180_000);

afterAll(async () => {
  await cleanupDomains(prisma, [scope?.domain.id]);
  await prisma.$disconnect();
});

type Format = "json-schema" | "avro" | "protobuf";

/** One Kafka channel in `format`, one message `probe-created` pinned to the entity (the published version, or its draft), one send operation. */
async function seedEvent(format: Format, pinned: boolean) {
  const document: EventDocument = {
    ...emptyEventDocument("probe-service"),
    servers: [{ key: "kafka-prod", protocol: "kafka", host: "kafka-prod.internal:9092" }],
    channels: [{ key: "orders", address: "probe.orders.v1", protocol: "kafka", serverKeys: ["kafka-prod"], format, ...(format === "json-schema" ? { formatDialect: "draft-07" } : {}), messageKeys: ["probe-created"] } as EventDocument["channels"][number]],
    messages: [{ key: "probe-created", payload: { entityId: entity.id, entityVersionId: pinned ? version.id : null }, traitKeys: [] }],
    operations: [{ key: "sendProbe", action: "send", channelKey: "orders", messageKeys: ["probe-created"], traitKeys: [] }],
  };
  return prisma.eventSpec.create({
    data: { name: `evt-${stamp()}`, tenantId: TENANT, domainId: scope.domain.id, productId: scope.product.id, document: document as unknown as Prisma.InputJsonValue },
  });
}

const errorsOf = <T extends { severity: string }>(list: T[]): T[] => list.filter((d) => d.severity === "error");

describe.sequential("an entity field named hasOwnProperty, through the real emit and publish path", () => {
  it("JSON Schema payload: the field reaches the document as a property and the emission returns ONE clear error that names it", async () => {
    const event = await seedEvent("json-schema", false);

    const out = unwrap(await emitEventDraft(event.id, scope.product.id, ctx));

    expect(errorsOf(out.diagnostics)).toEqual([
      { severity: "error", code: "PARSER_UNSAFE_KEY", message: MESSAGE("probe-created"), pointer: POINTER("probe-created") },
    ]);
    // the name arrives verbatim (not slugged to lower case, which the parser would read)
    expect(out.json).toContain('"hasOwnProperty": {');
    expect(JSON.stringify(out.diagnostics)).not.toMatch(LEAKS);
  }, 120_000);

  it("Avro and Protobuf payloads carry the name verbatim too, but as a VALUE, so the parser reads it: no error", async () => {
    for (const format of ["avro", "protobuf"] as const) {
      const event = await seedEvent(format, false);
      const out = unwrap(await emitEventDraft(event.id, scope.product.id, ctx));
      expect(errorsOf(out.diagnostics), format).toEqual([]);
      expect(out.json, format).toContain("hasOwnProperty");
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
