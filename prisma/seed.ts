import "dotenv/config";
import { PrismaClient } from "../src/generated/prisma/client";
import { createDbAdapter } from "../src/lib/db-adapter";
import { ensureBootstrapAdmin, planSeedAdmin } from "../src/lib/admin-bootstrap";
import { ensureBundledTraits } from "../src/services/events/bundled-traits.service";

async function main() {
  const prisma = new PrismaClient({ adapter: createDbAdapter() });

  // The administrator (access-control design, decision 7): BOOTSTRAP_ADMIN_EMAIL + BOOTSTRAP_ADMIN_PASSWORD when set; otherwise the
  // development default admin@admin.com / admin, but NEVER when NODE_ENV is "production" (there, `npm run admin:create` or the two
  // variables make the first administrator). Idempotent. Nothing makes a user an administrator because they registered first.
  const plan = planSeedAdmin(process.env);
  if (plan.kind === "invalid") throw new Error(plan.message);
  if (plan.kind === "none") {
    console.log(
      "No administrator created: NODE_ENV is production and BOOTSTRAP_ADMIN_EMAIL / BOOTSTRAP_ADMIN_PASSWORD are not set. " +
        "Set both and run the seed again, or run `npm run admin:create`."
    );
  } else {
    const result = await ensureBootstrapAdmin({ email: plan.email, password: plan.password }, prisma);
    if (result.status === "refused") {
      // A configured administrator that cannot be made is the operator's mistake and stops the seed; the development default only warns.
      if (plan.kind === "configured") throw new Error(result.message);
      console.warn(`Development administrator ${plan.email} left as it is: ${result.message}`);
    } else if (result.status === "unchanged") {
      console.log(`Administrator already exists: ${plan.email}`);
    } else {
      const what = result.status === "created" ? "Created" : "Granted the administrator role to";
      console.log(
        plan.kind === "development-default"
          ? `${what} test user: ${plan.email} / ${plan.password}`
          : `${what} administrator: ${plan.email}`
      );
    }
  }

  // Seed system domains (idempotent)
  const systemDomains = [
    {
      name: "Public",
      slug: "public",
      description:
        "Shared domain for general-purpose entities accessible to all users",
      isSystem: true,
    },
    {
      name: "Playground",
      slug: "playground",
      description:
        "Sandbox domain for developers to experiment with entity creation",
      isSystem: true,
    },
  ];

  // Ensure the default tenant exists (root of the org hierarchy).
  const DEFAULT_TENANT_ID = "tenant_default";
  await prisma.tenant.upsert({
    where: { id: DEFAULT_TENANT_ID },
    update: {},
    create: {
      id: DEFAULT_TENANT_ID,
      name: "Default Tenant",
      slug: "default",
      description: "Auto-created default tenant",
      isSystem: true,
    },
  });

  // Its built-in message properties too. The migrations create this tenant but install no built-in traits: `npm run db:deploy` does, and so
  // does ensureDefaultTenantId when it creates a tenant. A database migrated with `prisma migrate deploy` (the e2e release runner) and then
  // seeded would otherwise have none. A failure is reported and the seed goes on (the next db:deploy installs them).
  const traits = await ensureBundledTraits(prisma, DEFAULT_TENANT_ID);
  if (traits.success) {
    console.log(
      traits.data.created.length
        ? `Created the built-in message properties in ${DEFAULT_TENANT_ID}: ${traits.data.created.join(", ")}`
        : `The built-in message properties are already in ${DEFAULT_TENANT_ID}`
    );
  } else {
    console.error(`The built-in message properties were not installed in ${DEFAULT_TENANT_ID} (${traits.error.code}): run npm run db:deploy`);
  }

  for (const domain of systemDomains) {
    const existing = await prisma.domain.findUnique({
      where: { name_tenantId: { name: domain.name, tenantId: DEFAULT_TENANT_ID } },
    });
    if (!existing) {
      await prisma.domain.create({
        data: { ...domain, tenantId: DEFAULT_TENANT_ID },
      });
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

  // Seed default business concepts (idempotent)
  const defaultConcepts = [
    {
      name: "Customer Identifier",
      domain: "Identity",
      definition: "A unique identifier assigned to each customer across all systems",
      synonyms: ["cust_id", "customer_number", "CustomerNo", "customer_id", "customerId"],
      canonicalType: "string",
      classification: "PII",
      tags: ["identity", "customer"],
    },
    {
      name: "Customer Name",
      domain: "Identity",
      definition: "The full legal name of a customer",
      synonyms: ["cust_name", "customer_name", "CustomerName", "full_name", "fullName"],
      canonicalType: "string",
      classification: "PII",
      tags: ["identity", "customer"],
    },
    {
      name: "Email Address",
      domain: "Identity",
      definition: "A valid email address used for communication and authentication",
      synonyms: ["email", "email_addr", "emailAddress", "e_mail", "contact_email"],
      canonicalType: "string",
      classification: "PII",
      tags: ["identity", "contact"],
    },
    {
      name: "Phone Number",
      domain: "Identity",
      definition: "A phone number including country code for customer contact",
      synonyms: ["phone", "phone_number", "phoneNumber", "tel", "telephone", "mobile"],
      canonicalType: "string",
      classification: "PII",
      tags: ["identity", "contact"],
    },
    {
      name: "Transaction Amount",
      domain: "Finance",
      definition: "The monetary value of a financial transaction",
      synonyms: ["amount", "txn_amount", "transaction_amt", "transactionAmount", "tx_amount"],
      canonicalType: "decimal",
      classification: "SENSITIVE",
      tags: ["financial", "transaction"],
    },
    {
      name: "Currency Code",
      domain: "Finance",
      definition: "ISO 4217 three-letter currency code (e.g., USD, EUR, GBP)",
      synonyms: ["currency", "currency_code", "currencyCode", "ccy", "curr_cd"],
      canonicalType: "string",
      classification: null,
      tags: ["financial", "reference"],
    },
    {
      name: "Transaction Date",
      domain: "Finance",
      definition: "The date and time when a financial transaction occurred",
      synonyms: ["txn_date", "transaction_date", "transactionDate", "tx_dt", "trade_date"],
      canonicalType: "datetime",
      classification: null,
      tags: ["financial", "temporal"],
    },
    {
      name: "Account Balance",
      domain: "Finance",
      definition: "The current monetary balance of a financial account",
      synonyms: ["balance", "acct_balance", "accountBalance", "current_balance", "bal"],
      canonicalType: "decimal",
      classification: "SENSITIVE",
      tags: ["financial", "account"],
    },
    {
      name: "Account Number",
      domain: "Finance",
      definition: "A unique identifier for a financial account",
      synonyms: ["acct_no", "account_number", "accountNumber", "acct_num", "account_id"],
      canonicalType: "string",
      classification: "SENSITIVE",
      tags: ["financial", "account", "identity"],
    },
    {
      name: "Product Name",
      domain: "Commerce",
      definition: "The display name of a product or service offering",
      synonyms: ["product_name", "productName", "prod_name", "item_name", "product_title"],
      canonicalType: "string",
      classification: null,
      tags: ["commerce", "product"],
    },
    {
      name: "Product SKU",
      domain: "Commerce",
      definition: "Stock Keeping Unit - a unique product identifier for inventory management",
      synonyms: ["sku", "product_sku", "productSku", "stock_code", "item_code"],
      canonicalType: "string",
      classification: null,
      tags: ["commerce", "product", "inventory"],
    },
    {
      name: "Product Price",
      domain: "Commerce",
      definition: "The retail or wholesale price of a product",
      synonyms: ["price", "unit_price", "productPrice", "list_price", "retail_price"],
      canonicalType: "decimal",
      classification: null,
      tags: ["commerce", "product", "financial"],
    },
    {
      name: "Created Timestamp",
      domain: "Core",
      definition: "The date and time when a record was first created in the system",
      synonyms: ["created_at", "createdAt", "create_date", "created_date", "creation_time"],
      canonicalType: "timestamp",
      classification: null,
      tags: ["temporal", "audit"],
    },
    {
      name: "Updated Timestamp",
      domain: "Core",
      definition: "The date and time when a record was last modified",
      synonyms: ["updated_at", "updatedAt", "modify_date", "modified_date", "last_modified"],
      canonicalType: "timestamp",
      classification: null,
      tags: ["temporal", "audit"],
    },
    {
      name: "Record Status",
      domain: "Core",
      definition: "The lifecycle status of a record (e.g., ACTIVE, INACTIVE, DELETED)",
      synonyms: ["status", "record_status", "recordStatus", "state", "is_active"],
      canonicalType: "string",
      classification: null,
      tags: ["lifecycle", "audit"],
    },
  ];

  for (const concept of defaultConcepts) {
    const existing = await prisma.businessConcept.findUnique({
      where: { name: concept.name },
    });
    if (!existing) {
      await prisma.businessConcept.create({
        data: {
          name: concept.name,
          domain: concept.domain,
          definition: concept.definition,
          synonyms: concept.synonyms,
          canonicalType: concept.canonicalType,
          classification: concept.classification,
          tags: concept.tags,
        },
      });
      console.log(`Created business concept: ${concept.name}`);
    } else {
      console.log(`Business concept already exists: ${concept.name}`);
    }
  }

  await prisma.$disconnect();
  console.log("Seed complete.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
