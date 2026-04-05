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

  // Seed default emitter configs (idempotent)
  const defaultEmitters = [
    { name: "bigquery", format: "SQL", version: "1.0.0", description: "Google BigQuery SQL DDL emitter" },
    { name: "avro", format: "JSON", version: "1.0.0", description: "Apache Avro schema emitter" },
    { name: "openapi", format: "YAML", version: "1.0.0", description: "OpenAPI 3.0 specification emitter" },
  ];

  for (const d of defaultEmitters) {
    const existing = await prisma.emitterConfig.findUnique({
      where: { emitterName: d.name },
    });
    if (!existing) {
      await prisma.emitterConfig.create({
        data: {
          emitterName: d.name,
          enabled: true,
          targetFormat: d.format,
          version: d.version,
          description: d.description,
          updatedBy: "system",
        },
      });
      console.log(`Created default emitter config: ${d.name}`);
    } else {
      console.log(`Emitter config already exists: ${d.name}`);
    }
  }

  // Seed default classification levels (idempotent)
  const defaultClassifications = [
    { name: "PII", displayColor: "#DC2626", bgColor: "#DC262620", textColor: "#DC2626", description: "Personally Identifiable Information", sortOrder: 1 },
    { name: "SENSITIVE", displayColor: "#D97706", bgColor: "#D9770620", textColor: "#D97706", description: "Sensitive business data", sortOrder: 2 },
    { name: "INTERNAL", displayColor: "#2563EB", bgColor: "#2563EB20", textColor: "#2563EB", description: "Internal use only", sortOrder: 3 },
    { name: "PUBLIC", displayColor: "#16A34A", bgColor: "#16A34A20", textColor: "#16A34A", description: "Public data", sortOrder: 4 },
  ];

  for (const cls of defaultClassifications) {
    const existing = await prisma.classificationLevel.findFirst({
      where: { name: cls.name },
    });
    if (!existing) {
      await prisma.classificationLevel.create({
        data: { ...cls, isSystem: true },
      });
      console.log(`Created default classification: ${cls.name}`);
    } else {
      console.log(`Classification already exists: ${cls.name}`);
    }
  }

  await prisma.$disconnect();
  console.log("Seed complete.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
