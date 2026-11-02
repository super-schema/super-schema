import "dotenv/config"; // before any import that reaches @/lib/db, which reads DB_PROVIDER when first evaluated
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import { PARSER_UNSAFE_KEYS } from "@/lib/event-specs/own-property";
import { createEntity, updateEntity } from "@/services/entity.service";
import { createEvent, renameEvent } from "@/services/events/event.service";
import { createTrait } from "@/services/events/trait.service";
import type { ServiceContext } from "@/types/service-context";
import { cleanupDomains, connectTestDb, createProductScope, stamp, testContext } from "./events/helpers";

/**
 * The name registry is the one choke point of every create and rename of an entity, an event and a trait (`writeWithUniqueName`): a name that
 * is a parser-unsafe key (`PARSER_UNSAFE_KEYS`) is refused there with one message, through the REAL services and the real database. An asset
 * that already has the name (inserted straight into the table here, as data from before the rule) stays editable.
 */

const [UNSAFE] = [...PARSER_UNSAFE_KEYS];
const MESSAGE = `"${UNSAFE}" is a reserved name: AsyncAPI documents cannot contain it. Choose another name.`;

let prisma: PrismaClient;
let ctx: ServiceContext;
let scope: Awaited<ReturnType<typeof createProductScope>>;

beforeAll(async () => {
  prisma = connectTestDb();
  ctx = await testContext(prisma);
  scope = await createProductScope(prisma, ctx, "rn");
}, 60_000);

afterAll(async () => {
  await cleanupDomains(prisma, [scope?.domain.id]);
  await prisma.$disconnect();
});

const failure = <T>(r: { success: boolean; error?: { code: string; message: string } } & T) => (r.success ? null : r.error);

describe("entities", { concurrent: false }, () => {
  it("creating an entity named like a parser-unsafe key is refused, and nothing is created", async () => {
    const result = await createEntity({ name: UNSAFE, domainId: scope.domain.id, description: "" }, ctx);
    expect(failure(result)).toEqual({ code: "VALIDATION_ERROR", message: MESSAGE });
    expect(await prisma.entity.count({ where: { domainId: scope.domain.id, name: UNSAFE } })).toBe(0);
  }, 60_000);

  it("a look-alike name is fine", async () => {
    const result = await createEntity({ name: `${UNSAFE}${stamp()}`, domainId: scope.domain.id, description: "" }, ctx);
    expect(result.success).toBe(true);
  }, 60_000);

  it("renaming an entity TO that name is refused, and the entity keeps its name", async () => {
    const entity = await scope.entity(`Plain${stamp()}`);
    const result = await updateEntity(entity.id, { name: UNSAFE }, ctx);
    expect(failure(result)).toEqual({ code: "VALIDATION_ERROR", message: MESSAGE });
    expect((await prisma.entity.findUniqueOrThrow({ where: { id: entity.id } })).name).toBe(entity.name);
  }, 60_000);

  it("an entity that ALREADY has the name (data from before the rule) can still be edited, and keeps it", async () => {
    const legacy = await scope.entity(UNSAFE);
    expect((await updateEntity(legacy.id, { description: "still editable" }, ctx)).success).toBe(true);
    expect((await updateEntity(legacy.id, { name: UNSAFE, description: "same name" }, ctx)).success).toBe(true);
    expect((await prisma.entity.findUniqueOrThrow({ where: { id: legacy.id } })).name).toBe(UNSAFE);
  }, 60_000);
});

describe("events and traits", { concurrent: false }, () => {
  it("creating an event named like a parser-unsafe key is refused; renaming one to it too", async () => {
    expect(failure(await createEvent(scope.product.id, { name: UNSAFE }, ctx))).toEqual({ code: "VALIDATION_ERROR", message: MESSAGE });
    const created = await createEvent(scope.product.id, { name: `evt-${stamp()}` }, ctx);
    if (!created.success) throw new Error(created.error.message);
    const renamed = await renameEvent(created.data.id, UNSAFE, { level: "PRODUCT", productId: scope.product.id }, ctx);
    expect(failure(renamed)).toEqual({ code: "VALIDATION_ERROR", message: MESSAGE });
  }, 60_000);

  it("creating a trait named like a parser-unsafe key is refused", async () => {
    const result = await createTrait({ level: "DOMAIN", domainId: scope.domain.id }, { name: UNSAFE, kind: "OPERATION", spec: { summary: "x" } }, ctx);
    expect(failure(result)).toEqual({ code: "VALIDATION_ERROR", message: MESSAGE });
  }, 60_000);
});
