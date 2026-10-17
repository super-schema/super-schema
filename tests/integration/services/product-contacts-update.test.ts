import "dotenv/config"; // first: @/lib/db (pulled in by product.service) reads DB_PROVIDER at import time
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient, Product } from "@/generated/prisma/client";
import type { ServiceContext } from "@/types/service-context";
import { updateProduct } from "@/services/product.service";
import { cleanupDomains, connectTestDb, stamp, TENANT, testContext } from "./events/helpers";

/**
 * The Edit contacts dialog sends ONLY engineeringLead / manager / teamEmails to `updateProduct`. These tests pin what the
 * service does with that input against the real database: the other product fields are left alone, an emptied field is
 * cleared, a mailbox is stored in its canonical form, and an invalid one writes nothing.
 */

let prisma: PrismaClient;
let ctx: ServiceContext;
const domainIds: string[] = [];
const tierIds: string[] = [];

beforeAll(async () => {
  prisma = connectTestDb();
  ctx = await testContext(prisma);
});

afterAll(async () => {
  try {
    await cleanupDomains(prisma, domainIds); // cascades to the products, which must go before their tier
    await prisma.productTier.deleteMany({ where: { id: { in: tierIds } } });
  } finally {
    await prisma.$disconnect();
  }
});

/** A product with every field filled in (a tier, an owner team, a description and all three contacts). */
async function seedProduct(): Promise<Product> {
  const s = stamp();
  const domain = await prisma.domain.create({ data: { name: `pcu-${s}`, slug: `pcu-${s}`, tenantId: TENANT } });
  domainIds.push(domain.id);
  const tier = await prisma.productTier.create({ data: { name: `PCU_TIER_${s}` } });
  tierIds.push(tier.id);
  return prisma.product.create({
    data: {
      domainId: domain.id,
      name: `Checkout ${s}`,
      slug: `checkout-${s}`,
      description: "Takes the money",
      tierId: tier.id,
      ownerTeam: "Payments Platform",
      engineeringLead: "Old Lead <old.lead@example.com>",
      manager: "old.manager@example.com",
      teamEmails: ["old.team@example.com", "Second Team <second.team@example.com>"],
    },
  });
}

/** Everything of the product except its contacts and `updatedAt`: what a contacts-only update must not change. */
function nonContactFields(p: Product) {
  return { id: p.id, domainId: p.domainId, name: p.name, slug: p.slug, description: p.description, tierId: p.tierId, ownerTeam: p.ownerTeam, isSystem: p.isSystem };
}

async function reload(id: string): Promise<Product> {
  return prisma.product.findUniqueOrThrow({ where: { id } });
}

describe("updating only a product's contacts (DB)", () => {
  it("changes the contacts and leaves the name, slug, description, tier and owner team untouched", async () => {
    const before = await seedProduct();

    const result = await updateProduct(
      before.id,
      { engineeringLead: "new.lead@example.com", manager: "New Manager <new.manager@example.com>", teamEmails: ["new.team@example.com"] },
      ctx
    );

    expect(result.success).toBe(true);
    const after = await reload(before.id);
    expect(after.engineeringLead).toBe("new.lead@example.com");
    expect(after.manager).toBe("New Manager <new.manager@example.com>");
    expect(after.teamEmails).toEqual(["new.team@example.com"]);
    expect(nonContactFields(after)).toEqual(nonContactFields(before));
    expect(after.tierId).not.toBeNull();
    expect(after.ownerTeam).toBe("Payments Platform");
    expect(after.description).toBe("Takes the money");
  }, 60_000);

  it("clears an emptied field: null or blank text sets the mailbox to null, an empty list sets the team to []", async () => {
    const before = await seedProduct();

    const result = await updateProduct(before.id, { engineeringLead: null, manager: "   ", teamEmails: [] }, ctx);

    expect(result.success).toBe(true);
    const after = await reload(before.id);
    expect(after.engineeringLead).toBeNull();
    expect(after.manager).toBeNull();
    expect(after.teamEmails).toEqual([]);
    expect(nonContactFields(after)).toEqual(nonContactFields(before));
  }, 60_000);

  it("clears one field without touching the other two contacts", async () => {
    const before = await seedProduct();

    const result = await updateProduct(before.id, { manager: null }, ctx);

    expect(result.success).toBe(true);
    const after = await reload(before.id);
    expect(after.manager).toBeNull();
    expect(after.engineeringLead).toBe(before.engineeringLead);
    expect(after.teamEmails).toEqual(before.teamEmails);
    expect(nonContactFields(after)).toEqual(nonContactFields(before));
  }, 60_000);

  it("stores `Jane Doe <jane@example.com>` in its canonical form, for the mailboxes and for every team address", async () => {
    const before = await seedProduct();

    const result = await updateProduct(
      before.id,
      {
        engineeringLead: '  "Jane Doe"   <jane@example.com> ',
        manager: '"Roe, Rick" <rick@example.com>',
        // Names are tidied, quotes only where needed, a repeated address (case-insensitive) collapses to its first spelling.
        teamEmails: ['"Platform   Team" <platform@example.com>', "ONCALL@example.com", "oncall@Example.com", "  "],
      },
      ctx
    );

    expect(result.success).toBe(true);
    const after = await reload(before.id);
    expect(after.engineeringLead).toBe("Jane Doe <jane@example.com>");
    expect(after.manager).toBe('"Roe, Rick" <rick@example.com>');
    expect(after.teamEmails).toEqual(["Platform Team <platform@example.com>", "ONCALL@example.com"]);
    if (!result.success) throw new Error("unreachable");
    expect(result.data.engineeringLead).toBe("Jane Doe <jane@example.com>");
  }, 60_000);

  it("refuses an invalid address with the field's message and writes nothing", async () => {
    const before = await seedProduct();

    const result = await updateProduct(before.id, { engineeringLead: "jane", manager: "mo@example.com", teamEmails: ["broken"] }, ctx);

    expect(result.success).toBe(false);
    if (result.success) throw new Error("unreachable");
    expect(result.error.code).toBe("VALIDATION_ERROR");
    const fieldErrors = (result.error.details as { fieldErrors: Record<string, string> }).fieldErrors;
    expect(Object.keys(fieldErrors).sort()).toEqual(["engineeringLead", "teamEmails"]);
    expect(fieldErrors.engineeringLead).toContain("jane");
    expect(fieldErrors.teamEmails).toContain("broken");

    const after = await reload(before.id);
    expect(after.engineeringLead).toBe(before.engineeringLead);
    expect(after.manager).toBe(before.manager); // the valid field of a refused request is not saved either
    expect(after.teamEmails).toEqual(before.teamEmails);
    expect(after.updatedAt).toEqual(before.updatedAt);
  }, 60_000);
});
