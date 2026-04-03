import "dotenv/config";
import { PrismaClient } from "../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { hashSync } from "bcryptjs";

async function main() {
  const adapter = new PrismaPg({
    connectionString: process.env.DATABASE_URL!,
  });
  const prisma = new PrismaClient({ adapter });

  // Seed test admin user (idempotent)
  const testUser = await prisma.user.findUnique({
    where: { email: "admin@admin.com" },
  });
  if (!testUser) {
    await prisma.user.create({
      data: {
        email: "admin@admin.com",
        name: "Admin",
        password: hashSync("admin", 12),
      },
    });
    console.log("Created test user: admin@admin.com / admin");
  } else {
    console.log("Test user already exists: admin@admin.com");
  }

  // Seed system domains (idempotent)
  const systemDomains = [
    {
      name: "Public",
      description:
        "Shared domain for general-purpose entities accessible to all users",
      isSystem: true,
    },
    {
      name: "Playground",
      description:
        "Sandbox domain for developers to experiment with entity creation",
      isSystem: true,
    },
  ];

  for (const domain of systemDomains) {
    const existing = await prisma.domain.findUnique({
      where: { name: domain.name },
    });
    if (!existing) {
      await prisma.domain.create({ data: domain });
      console.log(`Created system domain: ${domain.name}`);
    } else {
      console.log(`System domain already exists: ${domain.name}`);
    }
  }

  await prisma.$disconnect();
  console.log("Seed complete.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
