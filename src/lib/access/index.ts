/**
 * The access-control policy engine (pure). Scopes and containment, the action table, and the decisions built on them.
 * See docs/superpowers/specs/2026-10-24-access-control-design.md.
 */

export {
  covers,
  isAssignment,
  isResourceRef,
  isScopeId,
  isValidAssignment,
  isValidScope,
  parseScopeKey,
  scopeContains,
  scopeKey,
  type Assignment,
  type ParsedScopeKey,
  type ResourceRef,
  type Scope,
} from "./scope";

export {
  ACTIONS,
  ACTION_IDS,
  isActionId,
  type ActionId,
  type ActionLevel,
  type ActionSpec,
  type RoleActionSpec,
  type SelfActionSpec,
} from "./actions";

export { can, contextRole, effectiveRole, globalRole, grantAllowed, roleAtLeast } from "./policy";
