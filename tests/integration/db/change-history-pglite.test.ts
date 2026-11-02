// @vitest-environment node
/**
 * The change log of an entity against a real database (PGlite with every migration). The services write the rows (an entity's creation, its
 * fields' creates, edits, reorders and deletes), and the change log reads them back: a field's rows are written under the field's id or the
 * placeholder "pending", so they are found through the entity they name in their state. Another entity's rows, and the rows of a tenant that
 * does not own the entity, are not in it; a row no tenant owns is. The services, the audit writer and the query are the real ones.
 */
import { afterAll, describe, expect, it, vi } from "vitest";
import type { TestDb } from "../../helpers/pglite-db";

const holder = vi.hoisted(() => ({ db: undefined as undefined | TestDb }));
vi.mock("@/lib/db", async () => {
  holder.db = await (await import("../../helpers/pglite-db")).createPgliteDb();
  return { prisma: holder.db.prisma };
});

import { createEntity } from "@/services/entity.service";
import { createField, deleteField, reorderFields, updateField } from "@/services/field.service";
import { getChangeHistory } from "@/services/change-history.service";
import { createImportedEntities, type ImportedEntityInput } from "@/services/imported-entities";
import { ensureDefaultProductId } from "@/lib/org-defaults";
import { CreateEntityInputSchema } from "@/types/schemas/entity.schema";
import { CreateFieldInputSchema } from "@/types/schemas/field.schema";
import type { ServiceContext } from "@/types/service-context";

function db() {
  if (!holder.db) throw new Error("the test database is not ready");
  return holder.db.prisma;
}

afterAll(async () => {
  await holder.db?.close();
});

/** Rows are timestamped when written: a few milliseconds between two writes keep the order of the calls in the timestamps. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

let seq = 0;
const fresh = (label: string) => `${label}-${++seq}-${Math.random().toString(36).slice(2, 7)}`;

async function makeWorld() {
  const prisma = db();
  const owner = await prisma.user.create({ data: { email: `${fresh("owner")}@example.test` } });
  const tenant = await prisma.tenant.create({ data: { name: fresh("Tenant"), slug: fresh("tenant") } });
  const domain = await prisma.domain.create({ data: { tenantId: tenant.id, name: "Sales", slug: fresh("sales") } });
  const ctx: ServiceContext = { userId: owner.id, userRole: "AUTHOR", prisma };
  return { prisma, owner, tenant, domain, ctx };
}

type World = Awaited<ReturnType<typeof makeWorld>>;

async function newEntity(world: World, name: string): Promise<string> {
  const created = await createEntity(CreateEntityInputSchema.parse({ name, domainId: world.domain.id }), world.ctx);
  if (!created.success) throw new Error(created.error.message);
  await tick();
  return created.data.id;
}

async function newField(world: World, entityId: string, name: string): Promise<string> {
  const created = await createField(entityId, CreateFieldInputSchema.parse({ name, type: "string" }), world.ctx);
  if (!created.success) throw new Error(created.error.message);
  await tick();
  return created.data.id;
}

describe("the change log of an entity, read back from the database", () => {
  it("shows the entity's creation and its fields' creates, edits, reorders and deletes, newest first", async () => {
    const world = await makeWorld();
    const entityId = await newEntity(world, "Order");
    const customerId = await newField(world, entityId, "customer_id");
    const totalId = await newField(world, entityId, "total");

    const renamed = await updateField(customerId, { name: "customer_name" }, world.ctx);
    expect(renamed.success).toBe(true);
    await tick();
    const reordered = await reorderFields(entityId, [totalId, customerId], world.ctx);
    expect(reordered.success).toBe(true);
    await tick();
    const deleted = await deleteField(totalId, world.ctx);
    expect(deleted.success).toBe(true);

    const history = await getChangeHistory(entityId, world.ctx);
    expect(history.success).toBe(true);
    if (!history.success) return;
    const entries = history.data.entries;
    expect(entries.map((e) => `${e.action} ${e.entityType}`)).toEqual([
      "DELETE Field",
      "REORDER Field",
      "UPDATE Field",
      "CREATE Field",
      "CREATE Field",
      "CREATE Entity",
    ]);
    expect(entries.map((e) => e.changeType)).toEqual(["field_edit", "field_edit", "field_edit", "field_edit", "field_edit", "other"]);
  });

  it("leaves out another entity's rows and a row another tenant owns, and keeps a row no tenant owns", async () => {
    const world = await makeWorld();
    const orderId = await newEntity(world, "Order");
    const invoiceId = await newEntity(world, "Invoice");
    const orderFieldId = await newField(world, orderId, "customer_id");
    const invoiceFieldId = await newField(world, invoiceId, "amount");

    const other = await world.prisma.tenant.create({ data: { name: fresh("Other"), slug: fresh("other") } });
    const ownedElsewhere = await world.prisma.auditLog.create({
      data: {
        action: "UPDATE",
        entityType: "Field",
        entityId: orderFieldId,
        userId: world.owner.id,
        tenantId: other.id,
        beforeState: { id: orderFieldId, entityId: orderId, name: "customer_id" },
        afterState: { id: orderFieldId, entityId: orderId, name: "other_tenant" },
      },
    });
    const ownedByNobody = await world.prisma.auditLog.create({
      data: {
        action: "UPDATE",
        entityType: "Field",
        entityId: orderFieldId,
        userId: world.owner.id,
        beforeState: { id: orderFieldId, entityId: orderId, name: "customer_id" },
        afterState: { id: orderFieldId, entityId: orderId, name: "legacy" },
      },
    });

    const history = await getChangeHistory(orderId, world.ctx);
    expect(history.success).toBe(true);
    if (!history.success) return;
    const ids = history.data.entries.map((e) => e.id);
    expect(ids).toContain(`audit-${ownedByNobody.id}`);
    expect(ids).not.toContain(`audit-${ownedElsewhere.id}`);

    const invoice = await getChangeHistory(invoiceId, world.ctx);
    expect(invoice.success).toBe(true);
    if (!invoice.success) return;
    expect(invoice.data.entries.map((e) => `${e.action} ${e.entityType}`)).toEqual(["CREATE Field", "CREATE Entity"]);
    const invoiceRows = JSON.stringify(invoice.data.entries);
    expect(invoiceRows).toContain(invoiceFieldId);
    expect(invoiceRows).not.toContain(orderId);
    expect(invoiceRows).not.toContain(orderFieldId);
  });

  it("shows an entity created by an import, and the field of another entity that a later import links to it", async () => {
    const world = await makeWorld();
    const productId = await ensureDefaultProductId(world.domain.id, world.prisma);
    const productScope = { tenantId: world.tenant.id, domainId: world.domain.id, productId };
    const importEntities = (entities: ImportedEntityInput[]) =>
      world.prisma.$transaction((tx) =>
        createImportedEntities(tx, {
          entities,
          productScope,
          productId,
          ownerId: world.owner.id,
          isNameFree: async () => true,
          skip: () => {},
          refs: new Map(),
        })
      );

    // Order is imported first: its `customer` reference dangles (no Customer exists yet).
    const danglingCustomer = {
      name: "customer",
      type: "reference",
      nullable: true,
      isKey: false,
      description: "",
      classification: null,
      precision: null,
      scale: null,
      decorators: { referencedEntityName: "Customer", danglingRef: { ref: "../common/Customer.v1.json" } },
    };
    const [order] = await importEntities([{ name: "Order", fields: [danglingCustomer] }]);
    // Customer is imported afterwards: the dangling reference of Order is linked to it, and that edit is part of Order's history.
    const [customer] = await importEntities([{ name: "Customer", fields: [] }]);

    const customerHistory = await getChangeHistory(customer.id, world.ctx);
    expect(customerHistory.success).toBe(true);
    if (!customerHistory.success) return;
    expect(customerHistory.data.entries.map((e) => `${e.action} ${e.entityType}`)).toEqual(["CREATE Entity"]);

    const orderHistory = await getChangeHistory(order.id, world.ctx);
    expect(orderHistory.success).toBe(true);
    if (!orderHistory.success) return;
    expect(orderHistory.data.entries.map((e) => `${e.action} ${e.entityType}`)).toEqual(["UPDATE Field", "CREATE Entity"]);
  });
});
