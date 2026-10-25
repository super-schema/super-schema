/**
 * What an IMPORT does with an entity whose name is a built-in type name (`Date`, `Duration`, `Record`, `Map`, `List`, `Set`, `Object`,
 * `Instant`, `url`, `String` ...; see `builtInNameConflict`): it renames it, it never skips it and never leaves a reference to it dangling.
 * A person who creates or renames an entity by hand is still refused (`entityNameMessage`): they can choose another name; a file cannot.
 *
 * ONE way, for every path that creates entities from a file (JSON Schema, OpenAPI, Avro, Protobuf, TypeSpec, the AsyncAPI payloads):
 * - the new name comes from the events import's suffix rule (`numberedName`: `Duration` -> `Duration2`), the first that is not a built-in,
 *   not reserved and free among the batch's names (case-insensitively) and URL slugs, and among the names the caller says are taken;
 * - everything that named the entity follows (`followEntityRenames`): `extends`, a reference field, an array of references, the members
 *   of a union field, and, for the formats whose field type IS a name (TypeSpec, OpenAPI), the type text of a field; in a bulk import also
 *   the members of a shared union and the entity and operation types of a service (`renameBuiltInPayload`);
 * - each rename is reported once (`builtInRenamedMessage`), however many entities carried the name.
 *
 * Pure: no I/O. The caller supplies the names that are taken outside the batch (the product's own entities).
 */
import { builtInNameConflict } from "@/lib/compiler/built-in-names";
import { entityNameMessage, numberedName } from "@/lib/entity-name";
import { reservedNameMessage } from "@/lib/reserved-field-names";
import { generateSlug } from "@/lib/slug";

/** More candidates than this cannot be taken (the events import's bound): the name is left as it is and the entity loop reports it. */
const MAX_ATTEMPTS = 1_000;

/**
 * The import formats whose FIELD TYPE is a TypeSpec type expression (a model's name, `Name[]`, `A | B`) rather than a logical type
 * (`string`, `reference`, `array`): only there can the type text name an entity.
 */
const TYPE_TEXT_FORMATS: ReadonlySet<string> = new Set(["typespec", "openapi"]);

/** Whether the field TYPE of an import in this format can name an entity. */
export function formatNamesEntitiesInTypes(sourceFormat: string | undefined): boolean {
  return sourceFormat !== undefined && TYPE_TEXT_FORMATS.has(sourceFormat);
}

interface FieldLike {
  type: string;
  decorators?: Record<string, unknown>;
}
interface EntityLike {
  name: string;
  extends?: string;
  fields: ReadonlyArray<FieldLike>;
}

export interface RenameOptions {
  /** Names taken outside the batch (the product's entities), compared case-insensitively. */
  taken?: Iterable<string>;
  /** URL slugs taken outside the batch. */
  takenSlugs?: Iterable<string>;
  /** The field TYPE of the batch is a type expression that can name an entity (see {@link formatNamesEntitiesInTypes}). */
  typeText?: boolean;
  /** Hears about each rename once, with the languages the name is a built-in of. */
  onRename?: (from: string, to: string, languages: string[]) => void;
}

/** `Duration`, `Duration[]`, `Duration | null`: the type text with every bare name that is renamed replaced (anything more complex is left). */
export function renameTypeText(type: string, renames: ReadonlyMap<string, string>): string {
  if (renames.size === 0) return type;
  return type
    .split("|")
    .map((part) =>
      part.replace(/^(\s*)([A-Za-z_][\w.]*)((?:\[\])*\s*)$/, (whole, lead: string, id: string, tail: string) => {
        const to = renames.get(id);
        return to === undefined ? whole : `${lead}${to}${tail}`;
      })
    )
    .join("|");
}

/**
 * `field` with the entity names it refers to replaced by their new names: the reference target, the element of an array of references, the
 * members of a union, and (with `typeText`) the type text. The very same object when it names nothing that was renamed; the input is never changed.
 */
export function followEntityRenames<F extends FieldLike>(field: F, renames: ReadonlyMap<string, string>, typeText: boolean): F {
  if (renames.size === 0) return field;
  const target = (name: unknown): string | undefined => (typeof name === "string" ? renames.get(name.trim()) : undefined);
  let changed = false;
  let decorators = field.decorators;
  if (decorators) {
    const next: Record<string, unknown> = { ...decorators };
    const reference = target(decorators.referencedEntityName);
    if (reference !== undefined) { next.referencedEntityName = reference; changed = true; }
    const element = target(decorators.arrayElementType);
    if (element !== undefined) { next.arrayElementType = element; changed = true; }
    const members = decorators.unionMembers;
    if (Array.isArray(members)) {
      const followed = members.map((member) => target(member) ?? member);
      if (followed.some((member, i) => member !== members[i])) { next.unionMembers = followed; changed = true; }
    }
    if (changed) decorators = next;
  }
  const type = typeText ? renameTypeText(field.type, renames) : field.type;
  if (type !== field.type) changed = true;
  return changed ? { ...field, type, ...(decorators ? { decorators } : {}) } : field;
}

/**
 * The entities of one import batch with every built-in type name replaced (see the module note). `renames` maps each ORIGINAL (trimmed) name
 * to its new one, so the caller can rewrite what else names it. The very same array when nothing is renamed.
 */
export function renameBuiltInEntities<T extends EntityLike>(items: readonly T[], options: RenameOptions = {}): { items: T[]; renames: Map<string, string> } {
  const renames = new Map<string, string>();
  if (!items.some((item) => builtInNameConflict(item.name) !== null)) return { items: items as T[], renames };
  const names = new Set([...items.map((item) => item.name.trim().toLowerCase()), ...[...(options.taken ?? [])].map((name) => name.toLowerCase())]);
  const slugs = new Set([...items.map((item) => generateSlug(item.name)), ...(options.takenSlugs ?? [])]);
  for (const item of items) {
    const conflict = builtInNameConflict(item.name);
    if (conflict === null) continue;
    const from = item.name.trim();
    // Entities that carry the SAME name (a duplicate the import skips later) share one new name, reported once.
    if (renames.has(from)) continue;
    for (let attempt = 2; attempt <= MAX_ATTEMPTS; attempt += 1) {
      const to = numberedName(from, attempt);
      if (entityNameMessage(to) !== null || reservedNameMessage(to) !== null || names.has(to.toLowerCase()) || slugs.has(generateSlug(to))) continue;
      names.add(to.toLowerCase());
      slugs.add(generateSlug(to));
      renames.set(from, to);
      options.onRename?.(from, to, conflict.languages);
      break;
    }
  }
  if (renames.size === 0) return { items: items as T[], renames };
  const typeText = options.typeText === true;
  const renamed = items.map((item) => {
    const name = renames.get(item.name.trim());
    const parent = item.extends === undefined ? undefined : renames.get(item.extends.trim());
    const fields = item.fields.map((field) => followEntityRenames(field, renames, typeText));
    if (name === undefined && parent === undefined && fields.every((field, i) => field === item.fields[i])) return item;
    return { ...item, ...(name === undefined ? {} : { name }), ...(parent === undefined ? {} : { extends: parent }), fields: fields as T["fields"] };
  });
  return { items: renamed, renames };
}

/** The part of a bulk import's payload that can name an entity. */
interface PayloadLike<E extends EntityLike, U extends { memberTypes: string[] }, S extends ServiceLike> {
  sourceFormat?: string;
  entities: E[];
  unionTypes: U[];
  services: S[];
}
interface ServiceLike {
  entityName?: string;
  operations: Array<{ returnType?: string; params: Array<{ type: string }> }>;
}

/**
 * A bulk import's payload with every built-in entity name renamed and everything else of the SAME payload that names the entity following:
 * the members of a shared union, the entity of a service, the return and parameter types of its operations. Unions and services are created
 * BEFORE the entities, so this runs first. The very same arrays when nothing is renamed.
 */
export function renameBuiltInPayload<E extends EntityLike, U extends { memberTypes: string[] }, S extends ServiceLike>(
  payload: PayloadLike<E, U, S>,
  options: Omit<RenameOptions, "typeText"> = {}
): { entities: E[]; unionTypes: U[]; services: S[]; renames: Map<string, string> } {
  const { items: entities, renames } = renameBuiltInEntities(payload.entities, { ...options, typeText: formatNamesEntitiesInTypes(payload.sourceFormat) });
  if (renames.size === 0) return { entities: payload.entities, unionTypes: payload.unionTypes, services: payload.services, renames };
  const unionTypes = payload.unionTypes.map((union) => {
    const memberTypes = union.memberTypes.map((member) => (typeof member === "string" ? renames.get(member.trim()) : undefined) ?? member);
    return memberTypes.some((member, i) => member !== union.memberTypes[i]) ? { ...union, memberTypes } : union;
  });
  const services = payload.services.map((service) => {
    const entityName = service.entityName === undefined ? undefined : renames.get(service.entityName.trim());
    const operations = service.operations.map((operation) => ({
      ...operation,
      ...(operation.returnType === undefined ? {} : { returnType: renameTypeText(operation.returnType, renames) }),
      params: operation.params.map((param) => ({ ...param, type: renameTypeText(param.type, renames) })),
    }));
    return { ...service, ...(entityName === undefined ? {} : { entityName }), operations };
  });
  return { entities, unionTypes, services, renames };
}
