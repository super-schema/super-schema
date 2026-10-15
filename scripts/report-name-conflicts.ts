// Report assets whose names collide along a tenant ∪ domain ∪ product line
// (Story 13.3).   npm run db:name-conflicts
//
// Read-only. Run before relying on line-uniqueness to see pre-existing
// duplicates that the dropped per-domain DB constraints used to allow.

import "dotenv/config";
import { prisma } from "@/lib/db";
import { findNameConflicts } from "@/services/name-registry.service";

async function main() {
  const tenants = await prisma.tenant.findMany({ select: { id: true, name: true } });
  let total = 0;
  for (const t of tenants) {
    const conflicts = await findNameConflicts(prisma, t.id);
    total += conflicts.length;
    for (const c of conflicts) {
      console.log(`[${t.name}] "${c.name}": ${c.assets.map((a) => `${a.kind}#${a.id} (domain=${a.domainId ?? "-"}, product=${a.productId ?? "-"})`).join(", ")}`);
    }
  }
  console.log(`${total} name conflict group(s).`);
  await prisma.$disconnect();
}
void main();
