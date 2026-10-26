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
  /** Create a global type-mapping override (`typemapping.global`, judged over the entity's tenant). */
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

/** The capabilities `assignments` give over the entity at `resource` (its tenant, domain and product). */
export function entityCapabilities(assignments: Assignment[], resource: ResourceRef): EntityCapabilities {
  return {
    write: can(assignments, "entity.write", resource),
    publish: can(assignments, "entity.publish", resource),
    deploy: can(assignments, "deploy.run", resource),
    overrideEntity: can(assignments, "typemapping.entity", resource),
    overrideGlobal: can(assignments, "typemapping.global", { tenantId: resource.tenantId }),
  };
}
