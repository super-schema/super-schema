/**
 * THE action table: every operation the application guards, with the minimum role it needs and the level at which that role is judged.
 * It is the single source (access-control design, decision 4); no role string or hierarchy array may decide a permission anywhere else.
 * `can(assignments, id, resource)` in `./policy` reads it. Adding an operation means adding an id here and mapping the call to it.
 *
 * Levels, i.e. which assignments count for the resource passed:
 * - `resource`: the role must be held at a scope that contains the resource (global, its tenant, its domain, its product).
 *   A domain-level asset is judged against its domain, an entity of a product against that product, a tenant-level entity against
 *   the tenant and global assignments only.
 * - `tenant`: a decision about the tenant as a whole; only a TENANT scope of the resource's tenant or a GLOBAL assignment counts,
 *   a domain or product assignment never does.
 * - `anywhere`: the role may be held at any scope inside the resource's tenant (or globally). For things that belong to the tenant
 *   but to none of its domains: tenant membership, reference data, the glossary.
 * - `global`: platform items; only a GLOBAL assignment counts (and GLOBAL is valid for ADMIN only). The resource is ignored.
 * - `self`: the principal's own data (notifications, profile). ANY active principal may, with no role at all (a roleless user still
 *   gets their notifications and profile), so `minRole` is `null` and `can` answers true. `can` knows nothing of sessions: the caller has
 *   already established an active principal (signed in, not disabled).
 *
 * The comment on each id names the operations it covers and, in brackets, the resource to pass; later tasks only map calls to ids.
 * Reads of stored content are VIEWER. A call that parses, compiles or fetches CLIENT-SUPPLIED text (previews, imports) is AUTHOR even
 * when it persists nothing: it spends the server's time and belongs to an authoring flow.
 */

import type { Role } from "@/types/schemas/rbac";

export type ActionLevel = "resource" | "tenant" | "anywhere" | "global" | "self";

/** An action that needs a role. */
export type RoleActionSpec = {
  readonly minRole: Role;
  readonly level: "resource" | "tenant" | "anywhere" | "global";
};

/** An action open to any active principal (see the `self` level above): there is no minimum role. */
export type SelfActionSpec = { readonly minRole: null; readonly level: "self" };

export type ActionSpec = RoleActionSpec | SelfActionSpec;

/** Freezes the table and each rule: nothing may loosen a permission at runtime. */
function freezeTable<T extends Record<string, ActionSpec>>(table: T): Readonly<T> {
  for (const spec of Object.values(table)) Object.freeze(spec);
  return Object.freeze(table);
}

export const ACTIONS = freezeTable({
  // ── Reads of content: VIEWER, at the covering scope ──────────────────────────────────────────────────────────────────────────────
  // entity page and lists, field rows, versions, version history and compare, change history, TypeSpec source and preview, schema versions,
  // target field mappings, generation requirements, per-entity overrides, emission preview (emitEntity), publish preview, retention page list,
  // GET /api/v1/schemas, /schemas/:id, POST /schemas/:id/emit and /validate, command palette fields [the entity, or its domain/product/tenant for a list]
  "entity.read": { minRole: "VIEWER", level: "resource" },
  // domain and product structure: domain list, domain tree (/api/domains-tree), domain and product pages, the admin domain list and detail
  // (getDomainsAdmin, getDomainAdminById) [the domain; a product through its domain]
  "domain.read": { minRole: "VIEWER", level: "resource" },
  // domain assets: models and their fields, shared enums, custom scalars, unions, API services and operations [the asset's owner: domain, product or tenant]
  "asset.read": { minRole: "VIEWER", level: "resource" },
  // events: the event, its draft emission, published versions and their stored documents, external event candidates / versions / items / ref
  // statuses, publish preview, GET /api/v1/event-specs/:id [the event's product]
  "event.read": { minRole: "VIEWER", level: "resource" },
  // traits (list, detail, usage in an event) [the trait's owner: tenant, domain or product]
  "trait.read": { minRole: "VIEWER", level: "resource" },
  // deployment overview and per-entity deployment status, target drift check, deployment service reads [the entity]
  "deploy.read": { minRole: "VIEWER", level: "resource" },
  // governance requests: list (getGovernanceRequests, getAllRequests, pending, per entity), approvals of a request [the request's entity]
  "governance.read": { minRole: "VIEWER", level: "resource" },
  // "who uses X": listUsagesAction / usage lookups [the subject of the lookup]
  "usage.read": { minRole: "VIEWER", level: "resource" },
  // annotations (comments) on an entity or field: getAnnotations, getAnnotationCounts [the entity] (annotation.service; its router is unmounted today)
  "annotation.read": { minRole: "VIEWER", level: "resource" },
  // glossary: getConcepts, searchConcepts, suggestConceptsForField (business concepts belong to no tenant row) [the active tenant]
  "glossary.read": { minRole: "VIEWER", level: "anywhere" },
  // reference data: classification levels (getClassificationLevels), default and override type mappings (getMappingsForTarget, getAllMappings),
  // the schema target catalog, the data-type hierarchy [the active tenant]
  "reference.read": { minRole: "VIEWER", level: "anywhere" },
  // tenant membership: setActiveTenantAction, GET /api/tenants and the tenant switcher (accessibleTenants), validating the active_tenant cookie [the tenant asked about]
  "tenant.access": { minRole: "VIEWER", level: "anywhere" },

  // ── Authoring: AUTHOR, at the covering scope ─────────────────────────────────────────────────────────────────────────────────────
  // create / edit / delete entities and fields: createEntity, createEntityWithFields, createTenantEntity (tenant-level), deleteEntity, addField,
  // updateField, deleteField, setEntityPrimaryKey, setFieldReference, updateEntityRelationships, updateEntityMetadata, updateEntityDescription,
  // applyTypeSpec, compileAndApplyTypeSpecSource [the entity; its parent domain/product on create; the tenant for a tenant-level one]
  "entity.write": { minRole: "AUTHOR", level: "resource" },
  // schema generation: generateSchemaAction (stores a draft version in the entity) [the entity]
  "schema.generate": { minRole: "AUTHOR", level: "resource" },
  // domain assets: create / update / delete shared enums, custom scalars, unions, API services (createService, getOrCreateEntityService,
  // deleteService), operations (create, update, replaceDetails, delete), model fields (add, update, delete) [the asset's owner scope]
  "asset.write": { minRole: "AUTHOR", level: "resource" },
  // imports: importTypeSpecDocument, importOpenApiDocument, importJsonSchemaFromUrl (authorize BEFORE the fetch), createDomainAssetsFromImport,
  // createEntitiesFromImport, previewAsyncApiImport, importAsyncApi [the import's target: domain, product or tenant]
  "import.run": { minRole: "AUTHOR", level: "resource" },
  // events: createEvent, updateEventDocument, renameEvent, deleteEvent, previewEventDocument (a document the user has not saved) [the event's product]
  "event.write": { minRole: "AUTHOR", level: "resource" },
  // pins: pinJsonSchemaAction (the schema of a pinned entity), listPinnableVersionsAction (the pin picker) [the event's product; the pinned entity for the picker]
  "event.pin": { minRole: "AUTHOR", level: "resource" },
  // traits: createTrait, updateTrait, deleteTrait [the trait's owner: tenant, domain or product]
  "trait.write": { minRole: "AUTHOR", level: "resource" },
  // per-entity type-mapping overrides: createTypeMappingOverride (scope per-entity), createEntityOverride, saveSchemaFieldTypeOverride,
  // acknowledgeLossyMapping, deleteOverride of a per-entity override [the entity]
  "typemapping.entity": { minRole: "AUTHOR", level: "resource" },
  // glossary links: linkFieldToConcept, unlinkFieldFromConcept [the field's entity]
  "glossary.link": { minRole: "AUTHOR", level: "resource" },
  // glossary concepts: createConcept, updateConcept, deleteConcept (concepts belong to no domain) [the active tenant]
  "glossary.write": { minRole: "AUTHOR", level: "anywhere" },
  // AI entity suggestion: POST /api/ai/generate-entity (sends the domain's entity names to the provider) [the domain]
  "ai.generate": { minRole: "AUTHOR", level: "resource" },
  // annotations: createAnnotation (annotation.service; its router is unmounted today) [the entity]
  "annotation.write": { minRole: "AUTHOR", level: "resource" },

  // ── Release and structure: STEWARD ─────────────────────────────────────────────────────────────────────────────────────────────
  // publish an entity version: publishSchemaAction, publishEntityAction [the entity]
  "entity.publish": { minRole: "STEWARD", level: "resource" },
  // lifecycle: updateEntityStatusAction (activate, deprecate, retire) [the entity]
  "entity.lifecycle": { minRole: "STEWARD", level: "resource" },
  // publish an event version: publishEventAction [the event's product]
  "event.publish": { minRole: "STEWARD", level: "resource" },
  // deploy: deploySchemaAction, markEntityDeployedAction [the entity]
  "deploy.run": { minRole: "STEWARD", level: "resource" },
  // governance approve / reject: approveGovernanceRequestAction, rejectGovernanceRequestAction (approveRequest, rejectRequest) [the request's entity]
  "governance.decide": { minRole: "STEWARD", level: "resource" },
  // retention policy edit: updateRetentionPolicyAction [the entity]
  "retention.write": { minRole: "STEWARD", level: "resource" },
  // create a product: createProductAction [the domain it is created in]
  "product.create": { minRole: "STEWARD", level: "resource" },
  // edit a product (name, description, tier, owner team, contacts): updateProductAction. Not in the spec table; it follows "create product" [the product]
  "product.update": { minRole: "STEWARD", level: "resource" },
  // edit a domain: updateDomainAdmin, applyPolicyTemplate, removeInheritance (domain-admin.service). Not in the spec table; it follows "create domain" [the domain]
  "domain.update": { minRole: "STEWARD", level: "resource" },
  // create a domain: createDomainAction, createDomainAdminAction (decided at tenant scope) [the tenant]
  "domain.create": { minRole: "STEWARD", level: "tenant" },

  // ── Compliance: COMPLIANCE_OFFICER ─────────────────────────────────────────────────────────────────────────────────────────────
  // POST /api/compliance/query: queryFields (rows are entities: filter by the entity's scope) [the entity of each row, or the tenant]
  "compliance.query": { minRole: "COMPLIANCE_OFFICER", level: "resource" },
  // POST /api/compliance/gaps: detectGaps, generateChangeSummary [the entity of each row, or the tenant]
  "compliance.gaps": { minRole: "COMPLIANCE_OFFICER", level: "resource" },
  // POST /api/compliance/audit-trail: queryAuditTrail (a tenant-wide read of audit_log) [the tenant]
  "compliance.audit": { minRole: "COMPLIANCE_OFFICER", level: "tenant" },
  // exportAuditTrail (a tenant-wide export of audit_log) [the tenant]
  "compliance.export": { minRole: "COMPLIANCE_OFFICER", level: "tenant" },

  // ── Administration: ADMIN ──────────────────────────────────────────────────────────────────────────────────────────────────────
  // assign / revoke a role: assignRoleAction, removeRoleAction (assignRole, removeRole). Always combined with grantAllowed(granter, role, targetScope) [the target scope]
  "role.assign": { minRole: "ADMIN", level: "resource" },
  // resolve another user's annotation: resolveAnnotation (the author may resolve their own) [the entity]
  "annotation.moderate": { minRole: "ADMIN", level: "resource" },
  // delete a domain: deleteDomainAction, deleteDomainAdmin (a tenant ADMIN; a domain-scoped ADMIN does not) [the tenant]
  "domain.delete": { minRole: "ADMIN", level: "tenant" },
  // delete a product: deleteProductAction [the tenant]
  "product.delete": { minRole: "ADMIN", level: "tenant" },
  // users of the tenant: getUsersAction, getUsers, getUserById, updateUser / updateUserNameAction (of another user), invite, disable / enable, reset link [the tenant]
  "user.manage": { minRole: "ADMIN", level: "tenant" },
  // tenant settings and the Admin area's tenant tabs: the admin layout gate, the tenant record's settings [the tenant]
  "tenant.admin": { minRole: "ADMIN", level: "tenant" },
  // platform administration: health and usage / activity / error metrics (runHealthCheck, getUsageMetrics, getActivityMetrics, getErrorSummary,
  // getErrorDetails, getHealthAction), webhooks (webhook.service and GET/POST/PUT/DELETE /api/v1/webhooks*, deliveries) [none: global]
  "platform.admin": { minRole: "ADMIN", level: "global" },
  // emitter configuration: getEmitterConfigs, getEmitterConfigByName, updateEmitterConfig(Action), testEmitter, and the emitter-config type mappings
  // (getTypeMappingsForTarget, createTypeMappingOverride, updateTypeMapping, deleteTypeMappingOverride) [none: global]
  "emitter.manage": { minRole: "ADMIN", level: "global" },
  // git configuration and export: configureRepository, testConnection, exportAll, enableExport, disableExport, getConfig (git.service) [none: global]
  "git.manage": { minRole: "ADMIN", level: "global" },
  // classification taxonomy: createClassification, updateClassification, deleteClassification [none: global]
  "classification.manage": { minRole: "ADMIN", level: "global" },
  // AI provider settings: getAiSettings, updateAiSettings, testAiConnection (ai-config.service; the stored provider, base URL and model that every
  // AI call reads) [none: global]
  "ai.manage": { minRole: "ADMIN", level: "global" },
  // tenant creation (a platform task; there is no tenant creation action yet: `npm run tenant:create`) [none: global]
  "tenant.create": { minRole: "ADMIN", level: "global" },
  // global type-mapping override: createTypeMappingOverride (scope global), createGlobalOverride, createOverride without an entity, deleteOverride of a
  // global override. The override table has no tenant column, so a global override changes the mapping of EVERY tenant: the design table says STEWARD,
  // and the review ruling (Task 5b) restricts it to a platform administrator until the table is tenant-keyed [none: global]
  "typemapping.global": { minRole: "ADMIN", level: "global" },

  // ── The principal's own data: any active principal, role or not ────────────────────────────────────────────────────────────────
  // notifications: GET/POST /api/v1/notifications (list, count, mark read, mark all read), notification.service [the principal]
  "notification.own": { minRole: null, level: "self" },
  // the principal's own profile: reading it, changing their own name [the principal]
  "profile.own": { minRole: null, level: "self" },
} as const satisfies Record<string, ActionSpec>);

/** The id of an operation in the action table. */
export type ActionId = keyof typeof ACTIONS;

/** Every action id, in table order (for the repository scan test and for documentation). */
export const ACTION_IDS: readonly ActionId[] = Object.freeze(Object.keys(ACTIONS) as ActionId[]);

/** True for exactly the table's own ids: not a prototype name such as `constructor`, not a non-string. */
export function isActionId(value: unknown): value is ActionId {
  return typeof value === "string" && Object.hasOwn(ACTIONS, value);
}
