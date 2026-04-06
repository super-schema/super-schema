/**
 * Unit tests for RetentionPolicy schema, migration, and formatting
 */

import { describe, it, expect } from "vitest";
import {
  RetentionPolicySchema,
  migrateSimpleRetention,
  formatRetentionSummary,
  retentionPolicyToYears,
  type RetentionPolicy,
} from "@/types/schemas/retention-policy.schema";

// ---------------------------------------------------------------------------
// Schema validation
// ---------------------------------------------------------------------------

describe("RetentionPolicySchema", () => {
  it("validates a valid age-based policy", () => {
    const policy = {
      strategy: "age-based",
      period: 90,
      periodUnit: "days",
      referenceField: "created_at",
      action: "delete",
    };
    const result = RetentionPolicySchema.safeParse(policy);
    expect(result.success).toBe(true);
  });

  it("validates a valid condition-based policy", () => {
    const policy = {
      strategy: "condition-based",
      condition: "status = 'DELETED' AND created_at < NOW() - INTERVAL 1 YEAR",
      action: "archive",
      description: "GDPR cleanup",
    };
    const result = RetentionPolicySchema.safeParse(policy);
    expect(result.success).toBe(true);
  });

  it("validates a valid rolling-window policy", () => {
    const policy = {
      strategy: "rolling-window",
      period: 365,
      periodUnit: "days",
      referenceField: "event_date",
      action: "delete",
    };
    const result = RetentionPolicySchema.safeParse(policy);
    expect(result.success).toBe(true);
  });

  it("validates an indefinite policy", () => {
    const policy = {
      strategy: "indefinite",
      action: "notify-only",
      description: "Legal hold",
    };
    const result = RetentionPolicySchema.safeParse(policy);
    expect(result.success).toBe(true);
  });

  it("rejects invalid strategy", () => {
    const policy = {
      strategy: "unknown",
      action: "delete",
    };
    const result = RetentionPolicySchema.safeParse(policy);
    expect(result.success).toBe(false);
  });

  it("rejects invalid action", () => {
    const policy = {
      strategy: "age-based",
      action: "destroy",
    };
    const result = RetentionPolicySchema.safeParse(policy);
    expect(result.success).toBe(false);
  });

  it("rejects negative period", () => {
    const policy = {
      strategy: "age-based",
      period: -10,
      periodUnit: "days",
      action: "delete",
    };
    const result = RetentionPolicySchema.safeParse(policy);
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Migration
// ---------------------------------------------------------------------------

describe("migrateSimpleRetention", () => {
  it("migrates '30d' to age-based 30 days", () => {
    const result = migrateSimpleRetention("30d");
    expect(result.strategy).toBe("age-based");
    expect(result.period).toBe(30);
    expect(result.periodUnit).toBe("days");
    expect(result.referenceField).toBe("created_at");
    expect(result.action).toBe("delete");
  });

  it("migrates '7y' to age-based 7 years", () => {
    const result = migrateSimpleRetention("7y");
    expect(result.strategy).toBe("age-based");
    expect(result.period).toBe(7);
    expect(result.periodUnit).toBe("years");
  });

  it("migrates 'indefinite' to indefinite strategy", () => {
    const result = migrateSimpleRetention("indefinite");
    expect(result.strategy).toBe("indefinite");
    expect(result.action).toBe("notify-only");
  });

  it("migrates 'Indefinite' case-insensitive", () => {
    const result = migrateSimpleRetention("Indefinite");
    expect(result.strategy).toBe("indefinite");
  });

  it("migrates '90 days' verbose format", () => {
    const result = migrateSimpleRetention("90 days");
    expect(result.strategy).toBe("age-based");
    expect(result.period).toBe(90);
    expect(result.periodUnit).toBe("days");
  });

  it("migrates '3 years' verbose format", () => {
    const result = migrateSimpleRetention("3 years");
    expect(result.strategy).toBe("age-based");
    expect(result.period).toBe(3);
    expect(result.periodUnit).toBe("years");
  });

  it("falls back to indefinite for unrecognized format", () => {
    const result = migrateSimpleRetention("keep forever please");
    expect(result.strategy).toBe("indefinite");
    expect(result.description).toBe("keep forever please");
  });

  it("handles empty string as indefinite", () => {
    const result = migrateSimpleRetention("");
    expect(result.strategy).toBe("indefinite");
  });
});

// ---------------------------------------------------------------------------
// Summary formatter
// ---------------------------------------------------------------------------

describe("formatRetentionSummary", () => {
  it("formats age-based policy", () => {
    const policy: RetentionPolicy = {
      strategy: "age-based",
      period: 90,
      periodUnit: "days",
      referenceField: "created_at",
      action: "delete",
    };
    expect(formatRetentionSummary(policy)).toBe("Delete after 90 days (created_at)");
  });

  it("formats age-based with archive action", () => {
    const policy: RetentionPolicy = {
      strategy: "age-based",
      period: 7,
      periodUnit: "years",
      referenceField: "closed_at",
      action: "archive",
    };
    expect(formatRetentionSummary(policy)).toBe("Archive after 7 years (closed_at)");
  });

  it("formats condition-based policy", () => {
    const policy: RetentionPolicy = {
      strategy: "condition-based",
      condition: "status = 'DELETED'",
      action: "delete",
    };
    expect(formatRetentionSummary(policy)).toBe("Delete when status = 'DELETED'");
  });

  it("truncates long conditions", () => {
    const policy: RetentionPolicy = {
      strategy: "condition-based",
      condition: "status = 'DELETED' AND created_at < NOW() - INTERVAL 1 YEAR AND something_else = true",
      action: "archive",
    };
    const summary = formatRetentionSummary(policy);
    expect(summary).toContain("...");
    expect(summary.length).toBeLessThan(80);
  });

  it("formats rolling-window policy", () => {
    const policy: RetentionPolicy = {
      strategy: "rolling-window",
      period: 365,
      periodUnit: "days",
      referenceField: "event_date",
      action: "delete",
    };
    expect(formatRetentionSummary(policy)).toBe("Keep 365 days (event_date)");
  });

  it("formats indefinite policy", () => {
    const policy: RetentionPolicy = {
      strategy: "indefinite",
      action: "notify-only",
    };
    expect(formatRetentionSummary(policy)).toBe("Retain indefinitely");
  });
});

// ---------------------------------------------------------------------------
// retentionPolicyToYears
// ---------------------------------------------------------------------------

describe("retentionPolicyToYears", () => {
  it("converts days to years", () => {
    const policy: RetentionPolicy = {
      strategy: "age-based",
      period: 365,
      periodUnit: "days",
      action: "delete",
    };
    expect(retentionPolicyToYears(policy)).toBe(1);
  });

  it("converts years directly", () => {
    const policy: RetentionPolicy = {
      strategy: "age-based",
      period: 7,
      periodUnit: "years",
      action: "delete",
    };
    expect(retentionPolicyToYears(policy)).toBe(7);
  });

  it("converts months to years", () => {
    const policy: RetentionPolicy = {
      strategy: "age-based",
      period: 24,
      periodUnit: "months",
      action: "delete",
    };
    expect(retentionPolicyToYears(policy)).toBe(2);
  });

  it("returns null for indefinite", () => {
    const policy: RetentionPolicy = {
      strategy: "indefinite",
      action: "notify-only",
    };
    expect(retentionPolicyToYears(policy)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Emitter retention comments
// ---------------------------------------------------------------------------

describe("Emitter retention output", () => {
  it("BigQuery emitter includes retention comment for age-based policy", async () => {
    const { BigQueryEmitter } = await import("@/emitters/bigquery/bigquery.emitter");
    const { getDefaultPolicies } = await import("@/lib/type-mapping/default-mappings");

    const emitter = new BigQueryEmitter();
    const policies = getDefaultPolicies();
    const model = {
      entity: {
        id: "e1",
        name: "TestEntity",
        domain: "test",
        domainId: "d1",
        description: "",
        status: "DRAFT",
        version: 1,
        metadata: {
          retentionPolicy: {
            strategy: "age-based" as const,
            period: 90,
            periodUnit: "days" as const,
            referenceField: "created_at",
            action: "delete" as const,
          },
        },
      },
      fields: [
        {
          name: "id",
          type: "string" as const,
          nullable: false,
          isKey: true,
          description: "",
          aliases: [],
          decorators: {},
          sortOrder: 0,
        },
      ],
      relationships: [],
    };

    const result = emitter.emit(model, policies);
    expect(result.output).toContain("-- RETENTION: delete rows where created_at > 90 days");
  });

  it("OpenAPI emitter includes x-retention for condition-based policy", async () => {
    const { openApiEmitter } = await import("@/emitters/openapi");
    const { getDefaultPolicies } = await import("@/lib/type-mapping/default-mappings");

    const policies = getDefaultPolicies();
    const model = {
      entity: {
        id: "e1",
        name: "TestEntity",
        domain: "test",
        domainId: "d1",
        description: "",
        status: "DRAFT",
        version: 1,
        metadata: {
          retentionPolicy: {
            strategy: "condition-based" as const,
            condition: "status = 'DELETED'",
            action: "archive" as const,
          },
        },
      },
      fields: [
        {
          name: "id",
          type: "string" as const,
          nullable: false,
          isKey: true,
          description: "",
          aliases: [],
          decorators: {},
          sortOrder: 0,
        },
      ],
      relationships: [],
    };

    const result = openApiEmitter.emit(model, policies);
    expect(result.output).toContain("x-retention");
    expect(result.output).toContain("condition-based");
    expect(result.output).toContain("archive");
  });
});
