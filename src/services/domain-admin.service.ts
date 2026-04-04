/**
 * Domain Admin Service — domain workspace management with policy templates.
 *
 * Handles domain CRUD for admin panel, policy template application,
 * and inheritance tracking. Uses in-memory store for MVP.
 */

import { ok, err } from "@/types/result";
import type { Result } from "@/types/result";
import type { ServiceContext } from "@/types/service-context";
import {
  PolicyTemplateSchema,
  CreateDomainAdminInputSchema,
  UpdateDomainAdminInputSchema,
  type PolicyTemplate,
  type DomainWithStats,
  type InheritedMetadata,
  type CreateDomainAdminInput,
  type UpdateDomainAdminInput,
} from "@/types/schemas/domain-policy";

// ---------------------------------------------------------------------------
// In-memory domain store (MVP)
// ---------------------------------------------------------------------------

export interface DomainRecord {
  id: string;
  name: string;
  description: string;
  policyTemplate: PolicyTemplate | null;
  isSystem: boolean;
  createdAt: Date;
  updatedAt: Date;
}

let domainStore: DomainRecord[] = [];
let entityCountMap: Map<string, number> = new Map();
let nextId = 1;

export function _resetDomainAdminStore(): void {
  domainStore = [];
  entityCountMap = new Map();
  nextId = 1;
}

export function _seedDomainAdminStore(domains: DomainRecord[]): void {
  domainStore = [...domains];
}

export function _setEntityCount(domainId: string, count: number): void {
  entityCountMap.set(domainId, count);
}

export function _getDomainAdminStore(): DomainRecord[] {
  return domainStore;
}

// ---------------------------------------------------------------------------
// getDomains — fetch all domains with stats (Admin only)
// ---------------------------------------------------------------------------

export async function getDomainsAdmin(
  ctx: ServiceContext
): Promise<Result<DomainWithStats[]>> {
  if (ctx.userRole !== "ADMIN") {
    return err({
      code: "FORBIDDEN",
      message: "Requires ADMIN role",
      suggestedFix: "Contact your administrator",
    });
  }

  const results: DomainWithStats[] = domainStore.map((d) => ({
    id: d.id,
    name: d.name,
    description: d.description,
    policyTemplate: d.policyTemplate,
    policyTemplateStatus: d.policyTemplate ? "Configured" : "No template",
    entityCount: entityCountMap.get(d.id) ?? 0,
    isSystem: d.isSystem,
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
  }));

  return ok(results);
}

// ---------------------------------------------------------------------------
// getDomainById
// ---------------------------------------------------------------------------

export async function getDomainAdminById(
  id: string,
  _ctx: ServiceContext
): Promise<Result<DomainRecord>> {
  const domain = domainStore.find((d) => d.id === id);
  if (!domain) {
    return err({
      code: "NOT_FOUND",
      message: `Domain with ID "${id}" not found`,
      suggestedFix: "Verify the domain ID.",
    });
  }
  return ok(domain);
}

// ---------------------------------------------------------------------------
// createDomain — Admin only
// ---------------------------------------------------------------------------

export async function createDomainAdmin(
  input: CreateDomainAdminInput,
  ctx: ServiceContext
): Promise<Result<DomainRecord>> {
  if (ctx.userRole !== "ADMIN") {
    return err({
      code: "FORBIDDEN",
      message: "Requires ADMIN role",
      suggestedFix: "Contact your administrator",
    });
  }

  const parsed = CreateDomainAdminInputSchema.safeParse(input);
  if (!parsed.success) {
    return err({
      code: "VALIDATION_ERROR",
      message: parsed.error.issues[0].message,
      suggestedFix: "Check the domain input fields.",
    });
  }

  // Validate policy template if provided
  if (parsed.data.policyTemplate) {
    const ptResult = PolicyTemplateSchema.safeParse(parsed.data.policyTemplate);
    if (!ptResult.success) {
      return err({
        code: "VALIDATION_ERROR",
        message: "Invalid policy template structure",
        suggestedFix: "Ensure policyTemplate matches the expected schema.",
      });
    }
  }

  // Enforce unique name (case-insensitive)
  const duplicate = domainStore.find(
    (d) => d.name.toLowerCase() === parsed.data.name.toLowerCase()
  );
  if (duplicate) {
    return err({
      code: "DUPLICATE",
      message: `A domain named "${parsed.data.name}" already exists`,
      suggestedFix: "Choose a different domain name.",
    });
  }

  const domain: DomainRecord = {
    id: `domain-${nextId++}`,
    name: parsed.data.name,
    description: parsed.data.description ?? "",
    policyTemplate: parsed.data.policyTemplate ?? null,
    isSystem: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  domainStore.push(domain);
  return ok(domain);
}

// ---------------------------------------------------------------------------
// updateDomain — Admin only
// ---------------------------------------------------------------------------

export async function updateDomainAdmin(
  input: UpdateDomainAdminInput,
  ctx: ServiceContext
): Promise<Result<DomainRecord>> {
  if (ctx.userRole !== "ADMIN") {
    return err({
      code: "FORBIDDEN",
      message: "Requires ADMIN role",
      suggestedFix: "Contact your administrator",
    });
  }

  const parsed = UpdateDomainAdminInputSchema.safeParse(input);
  if (!parsed.success) {
    return err({
      code: "VALIDATION_ERROR",
      message: parsed.error.issues[0].message,
      suggestedFix: "Check the domain input fields.",
    });
  }

  const domainIndex = domainStore.findIndex((d) => d.id === parsed.data.id);
  if (domainIndex === -1) {
    return err({
      code: "NOT_FOUND",
      message: `Domain with ID "${parsed.data.id}" not found`,
      suggestedFix: "Verify the domain ID.",
    });
  }

  // If name changed, enforce uniqueness
  if (parsed.data.name) {
    const duplicate = domainStore.find(
      (d) =>
        d.id !== parsed.data.id &&
        d.name.toLowerCase() === parsed.data.name!.toLowerCase()
    );
    if (duplicate) {
      return err({
        code: "DUPLICATE",
        message: `A domain named "${parsed.data.name}" already exists`,
        suggestedFix: "Choose a different domain name.",
      });
    }
  }

  const existing = domainStore[domainIndex];
  domainStore[domainIndex] = {
    ...existing,
    name: parsed.data.name ?? existing.name,
    description: parsed.data.description ?? existing.description,
    policyTemplate: parsed.data.policyTemplate !== undefined
      ? parsed.data.policyTemplate ?? null
      : existing.policyTemplate,
    updatedAt: new Date(),
  };

  return ok(domainStore[domainIndex]);
}

// ---------------------------------------------------------------------------
// deleteDomain — Admin only, blocked if entities exist
// ---------------------------------------------------------------------------

export async function deleteDomainAdmin(
  id: string,
  ctx: ServiceContext
): Promise<Result<void>> {
  if (ctx.userRole !== "ADMIN") {
    return err({
      code: "FORBIDDEN",
      message: "Requires ADMIN role",
      suggestedFix: "Contact your administrator",
    });
  }

  const domainIndex = domainStore.findIndex((d) => d.id === id);
  if (domainIndex === -1) {
    return err({
      code: "NOT_FOUND",
      message: `Domain with ID "${id}" not found`,
      suggestedFix: "Verify the domain ID.",
    });
  }

  const entityCount = entityCountMap.get(id) ?? 0;
  if (entityCount > 0) {
    return err({
      code: "CONFLICT",
      message: `Cannot delete domain with ${entityCount} entities. Reassign or delete entities first.`,
      suggestedFix: "Remove all entities from this domain before deleting it.",
    });
  }

  domainStore.splice(domainIndex, 1);
  entityCountMap.delete(id);
  return ok(undefined);
}

// ---------------------------------------------------------------------------
// applyPolicyTemplate — merge template values into field decorators
// ---------------------------------------------------------------------------

export function applyPolicyTemplate(
  domain: DomainRecord,
  existingDecorators: Record<string, unknown>
): { decorators: Record<string, unknown>; inherited: InheritedMetadata | null } {
  if (!domain.policyTemplate) {
    return { decorators: existingDecorators, inherited: null };
  }

  const template = domain.policyTemplate;
  const result = { ...existingDecorators };
  const inheritedKeys: string[] = [];

  // Apply classification if not already set
  if (template.classification && !getNestedValue(result, "classification.level")) {
    result.classification = {
      ...(result.classification as Record<string, unknown> ?? {}),
      level: template.classification,
    };
    inheritedKeys.push("classification");
  }

  // Apply retention if not already set
  if (template.retention && !getNestedValue(result, "policy.retention")) {
    result.policy = {
      ...(result.policy as Record<string, unknown> ?? {}),
      retention: template.retention,
    };
    inheritedKeys.push("retention");
  }

  // Apply quality rules if not already set
  if (template.qualityRules && !getNestedValue(result, "quality.rules")) {
    result.quality = {
      ...(result.quality as Record<string, unknown> ?? {}),
      rules: template.qualityRules,
    };
    inheritedKeys.push("qualityRules");
  }

  if (inheritedKeys.length === 0) {
    return { decorators: result, inherited: null };
  }

  const inherited: InheritedMetadata = {
    domainId: domain.id,
    domainName: domain.name,
    keys: inheritedKeys,
  };

  result._inherited = inherited;

  return { decorators: result, inherited };
}

// ---------------------------------------------------------------------------
// removeInheritance — remove a key from inherited metadata
// ---------------------------------------------------------------------------

export function removeInheritance(
  decorators: Record<string, unknown>,
  decoratorKey: string
): Record<string, unknown> {
  const result = { ...decorators };
  const inherited = result._inherited as InheritedMetadata | undefined;

  if (!inherited) return result;

  const keys = inherited.keys.filter((k) => k !== decoratorKey);

  if (keys.length === 0) {
    delete result._inherited;
  } else {
    result._inherited = { ...inherited, keys };
  }

  return result;
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split(".");
  let current: unknown = obj;
  for (const part of parts) {
    if (current == null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}
