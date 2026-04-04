import { describe, it, expect } from "vitest";
import { avroEmitter } from "@/emitters/avro/avro.emitter";
import { getDefaultPolicies } from "@/lib/type-mapping/default-mappings";
import type {
  SuperSchemaModel,
  SuperSchemaField,
} from "@/types/super-schema-model";
import type { MappingPolicy } from "@/types/super-schema-model";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const defaultPolicies: MappingPolicy[] = getDefaultPolicies();

function makeField(overrides: Partial<SuperSchemaField>): SuperSchemaField {
  return {
    name: "test_field",
    type: "string",
    nullable: false,
    isKey: false,
    description: "",
    aliases: [],
    decorators: {},
    sortOrder: 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Round-trip integration test
// ---------------------------------------------------------------------------

describe("Avro Emitter — integration: round-trip", () => {
  it("emits valid Avro schema from a realistic entity, validates it, and verifies structure", () => {
    const model: SuperSchemaModel = {
      entity: {
        id: "ent-payment-001",
        name: "payment_transaction",
        domain: "payments",
        domainId: "dom-payments",
        description: "Represents a financial payment transaction",
        status: "active",
        version: 3,
        metadata: {
          tags: ["finance", "core"],
        },
      },
      fields: [
        makeField({
          name: "transaction_id",
          type: "string",
          nullable: false,
          isKey: true,
          description: "Unique transaction identifier",
          sortOrder: 0,
        }),
        makeField({
          name: "amount",
          type: "decimal",
          precision: 19,
          scale: 4,
          nullable: false,
          description: "Transaction amount",
          sortOrder: 1,
        }),
        makeField({
          name: "currency_code",
          type: "string",
          nullable: false,
          description: "ISO 4217 currency code",
          aliases: ["currency", "ccy"],
          sortOrder: 2,
        }),
        makeField({
          name: "status",
          type: "enum",
          nullable: false,
          description: "Current transaction status",
          sortOrder: 3,
          complexType: {
            nestedFields: [
              { name: "PENDING", type: "string" },
              { name: "COMPLETED", type: "string" },
              { name: "FAILED", type: "string" },
              { name: "REFUNDED", type: "string" },
            ],
          },
        }),
        makeField({
          name: "tags",
          type: "array",
          nullable: true,
          description: "Optional tags",
          sortOrder: 4,
          complexType: { arrayElementType: "string" },
        }),
        makeField({
          name: "metadata",
          type: "map",
          nullable: true,
          description: "Additional metadata key-value pairs",
          sortOrder: 5,
          complexType: { mapKeyType: "string", mapValueType: "string" },
        }),
        makeField({
          name: "created_at",
          type: "utcDateTime",
          nullable: false,
          description: "When the transaction was created",
          sortOrder: 6,
        }),
        makeField({
          name: "settlement_date",
          type: "plainDate",
          nullable: true,
          description: "Date of settlement",
          sortOrder: 7,
        }),
        makeField({
          name: "is_recurring",
          type: "boolean",
          nullable: false,
          description: "Whether this is a recurring payment",
          sortOrder: 8,
        }),
        makeField({
          name: "retry_count",
          type: "integer",
          nullable: false,
          description: "Number of retry attempts",
          sortOrder: 9,
        }),
      ],
      relationships: [],
    };

    // Step 1: Emit
    const result = avroEmitter.emit(model, defaultPolicies);
    expect(result.targetFormat).toBe("avro");
    expect(result.output).toBeTruthy();

    // Step 2: Validate
    const validation = avroEmitter.validate(result.output);
    expect(validation.valid).toBe(true);
    expect(validation.errors).toHaveLength(0);

    // Step 3: Verify structure
    const schema = JSON.parse(result.output);
    expect(schema.type).toBe("record");
    expect(schema.name).toBe("PaymentTransaction");
    expect(schema.namespace).toBe("com.superschema.payments");
    expect(schema.doc).toBe("Represents a financial payment transaction");
    expect(schema.fields).toHaveLength(10);

    // Verify specific field mappings
    const fields = schema.fields as Record<string, unknown>[];

    // transaction_id — string
    expect(fields[0].name).toBe("transaction_id");
    expect(fields[0].type).toBe("string");
    expect(fields[0].doc).toBe("Unique transaction identifier");

    // amount — decimal
    expect(fields[1].name).toBe("amount");
    expect(fields[1].type).toEqual({
      type: "bytes",
      logicalType: "decimal",
      precision: 19,
      scale: 4,
    });

    // currency_code — string with aliases
    expect(fields[2].name).toBe("currency_code");
    expect(fields[2].type).toBe("string");
    expect(fields[2].aliases).toEqual(["currency", "ccy"]);

    // status — enum
    expect(fields[3].name).toBe("status");
    expect(fields[3].type).toEqual({
      type: "enum",
      name: "StatusEnum",
      symbols: ["PENDING", "COMPLETED", "FAILED", "REFUNDED"],
    });

    // tags — nullable array
    expect(fields[4].name).toBe("tags");
    expect(fields[4].type).toEqual([
      "null",
      { type: "array", items: "string" },
    ]);
    expect(fields[4].default).toBeNull();

    // metadata — nullable map
    expect(fields[5].name).toBe("metadata");
    expect(fields[5].type).toEqual([
      "null",
      { type: "map", values: "string" },
    ]);

    // created_at — timestamp-millis
    expect(fields[6].name).toBe("created_at");
    expect(fields[6].type).toEqual({
      type: "long",
      logicalType: "timestamp-millis",
    });

    // settlement_date — nullable date
    expect(fields[7].name).toBe("settlement_date");
    expect(fields[7].type).toEqual([
      "null",
      { type: "int", logicalType: "date" },
    ]);

    // is_recurring — boolean
    expect(fields[8].name).toBe("is_recurring");
    expect(fields[8].type).toBe("boolean");

    // retry_count — long
    expect(fields[9].name).toBe("retry_count");
    expect(fields[9].type).toBe("long");
  });
});

// ---------------------------------------------------------------------------
// Full pipeline: entity -> emit -> validate
// ---------------------------------------------------------------------------

describe("Avro Emitter — integration: full pipeline", () => {
  it("produces valid, deterministic output across multiple runs", () => {
    const model: SuperSchemaModel = {
      entity: {
        id: "ent-user-001",
        name: "user_profile",
        domain: "identity",
        domainId: "dom-identity",
        description: "User profile entity",
        status: "active",
        version: 1,
        metadata: {},
      },
      fields: [
        makeField({
          name: "user_id",
          type: "string",
          isKey: true,
          sortOrder: 0,
          description: "Unique user ID",
        }),
        makeField({
          name: "display_name",
          type: "string",
          nullable: true,
          sortOrder: 1,
          description: "Display name",
        }),
        makeField({
          name: "email",
          type: "string",
          sortOrder: 2,
          description: "Email address",
          aliases: ["email_address"],
        }),
        makeField({
          name: "signup_date",
          type: "plainDate",
          sortOrder: 3,
          description: "Account creation date",
        }),
        makeField({
          name: "last_login",
          type: "utcDateTime",
          nullable: true,
          sortOrder: 4,
        }),
      ],
      relationships: [],
    };

    // Emit twice
    const result1 = avroEmitter.emit(model, defaultPolicies);
    const result2 = avroEmitter.emit(model, defaultPolicies);

    // Deterministic
    expect(result1.output).toBe(result2.output);

    // Both validate
    expect(avroEmitter.validate(result1.output).valid).toBe(true);
    expect(avroEmitter.validate(result2.output).valid).toBe(true);

    // Verify structure
    const schema = JSON.parse(result1.output);
    expect(schema.name).toBe("UserProfile");
    expect(schema.namespace).toBe("com.superschema.identity");
    expect(schema.fields).toHaveLength(5);
  });
});
