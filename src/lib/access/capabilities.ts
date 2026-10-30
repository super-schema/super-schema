/**
 * What the signed-in user may do with ONE entity, as booleans a client component can show or hide controls by (access-control design,
 * goal 3: client components never decide from a role string). The server computes it from the policy (`entityCapabilities`) in the page that
 * renders the entity and hands it down as a prop. It is a convenience for the interface only: every action re-asks the policy on the server,
 * so a hidden control that is posted anyway is still refused.
 *
 * Pure and client-safe (no I/O, no session).
 */

import { can } from "./policy";
import type { Assignment, ResourceRef } from "./scope";

export type EntityCapabilities = {
  /** Edit the entity, its fields and its TypeSpec source (`entity.write`). */
  write: boolean;
  /** Publish a schema version (`entity.publish`). */
  publish: boolean;
  /** Deploy and mark deployed (`deploy.run`). */
  deploy: boolean;
  /** Create a per-entity type-mapping override or acknowledge a lossy mapping (`typemapping.entity`). */
  overrideEntity: boolean;
  /** Create a global type-mapping override (`typemapping.global`: it reaches every tenant, so a platform administrator's act). */
  overrideGlobal: boolean;
};

/** Nothing allowed: what a component shows when it was given no capabilities (fail closed). */
export const NO_ENTITY_CAPABILITIES: EntityCapabilities = Object.freeze({
  write: false,
  publish: false,
  deploy: false,
  overrideEntity: false,
  overrideGlobal: false,
});

/**
 * What the signed-in user may use of the Admin area, as booleans a client component can show or hide tabs and links by (goal 3: no role string reaches a
 * client). Computed on the server from the policy for the tenant in view (`adminCapabilities`) in the layouts, and handed down as a prop. A convenience for the
 * interface only: every admin action asks the policy again, so a tab that is hidden but whose action is posted anyway is still refused.
 */
export type AdminCapabilities = {
  /** The Admin area is theirs beyond personal settings: they administer the tenant in view or the platform. The Admin link is shown for this and only this. */
  area: boolean;
  /** Users, invitations, role assignment, the role matrix (`user.manage` over the tenant in view). */
  users: boolean;
  /** The domain administration tab (`tenant.admin` over the tenant in view). */
  domains: boolean;
  /** Emitter configuration (`emitter.manage`: a platform administrator). */
  emitters: boolean;
  /** Health and metrics (`platform.admin`). */
  health: boolean;
  /** The classification taxonomy (`classification.manage`). */
  classifications: boolean;
  /** AI provider settings (`ai.manage`: a platform administrator). */
  ai: boolean;
  /** Git configuration and export (`git.manage`; no tab is mounted for it yet). */
  git: boolean;
  /** Tenants (`tenant.create`; creating a tenant is a platform task, `npm run tenant:create`, and no tab is mounted for it yet). */
  tenants: boolean;
};

/** Nothing allowed: what a component shows when it was given no capabilities (fail closed). */
export const NO_ADMIN_CAPABILITIES: AdminCapabilities = Object.freeze({
  area: false,
  users: false,
  domains: false,
  emitters: false,
  health: false,
  classifications: false,
  ai: false,
  git: false,
  tenants: false,
});

/** A platform decision is judged over no place: nothing but a GLOBAL assignment covers it. */
const NO_PLACE: ResourceRef = { tenantId: "-" };

/**
 * The Admin capabilities of the holder of `assignments` for the tenant in view (`tenantId`; `null` judges the tenant items over no tenant, so only a platform
 * administrator passes them). The tenant tabs need the tenant administrator's act over that tenant (a domain- or product-scoped administrator is not one);
 * the platform tabs need a GLOBAL administrator whatever they hold in a tenant. Personal settings are every signed-in user's and are not a capability.
 */
export function adminCapabilities(assignments: Assignment[], tenantId: string | null): AdminCapabilities {
  const tenant: ResourceRef = tenantId === null ? NO_PLACE : { tenantId };
  const users = can(assignments, "user.manage", tenant);
  const domains = can(assignments, "tenant.admin", tenant);
  const emitters = can(assignments, "emitter.manage", NO_PLACE);
  const health = can(assignments, "platform.admin", NO_PLACE);
  const classifications = can(assignments, "classification.manage", NO_PLACE);
  const ai = can(assignments, "ai.manage", NO_PLACE);
  const git = can(assignments, "git.manage", NO_PLACE);
  const tenants = can(assignments, "tenant.create", NO_PLACE);
  return { area: users || domains || emitters || health || classifications || ai || git || tenants, users, domains, emitters, health, classifications, ai, git, tenants };
}

/** The capabilities `assignments` give over the entity at `resource` (its tenant, domain and product). */
export function entityCapabilities(assignments: Assignment[], resource: ResourceRef): EntityCapabilities {
  return {
    write: can(assignments, "entity.write", resource),
    publish: can(assignments, "entity.publish", resource),
    deploy: can(assignments, "deploy.run", resource),
    overrideEntity: can(assignments, "typemapping.entity", resource),
    overrideGlobal: can(assignments, "typemapping.global", resource),
  };
}
