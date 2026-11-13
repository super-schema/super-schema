/**
 * Typed read/write of metadata attribute values. Values live ONLY in the existing extension maps: a field's
 * `decorators.typespec.extensions.openapi`, an entity's `metadata.custom.extensions`. Writers are pure (return new objects).
 */

const X_KEY = /^x-/;

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function xOnly(map: unknown): Record<string, unknown> {
  if (!isObj(map)) return {};
  return Object.fromEntries(Object.entries(map).filter(([k]) => X_KEY.test(k)));
}

/** The x-* values of a field (`typespec.extensions.openapi`). */
export function readFieldAttributes(decorators: unknown): Record<string, unknown> {
  const typespec = isObj(decorators) ? decorators.typespec : undefined;
  const extensions = isObj(typespec) ? typespec.extensions : undefined;
  return xOnly(isObj(extensions) ? extensions.openapi : undefined);
}

/** Set (or, with `undefined`, remove) one x-* value. Containers emptied by a removal are pruned; other keys are untouched. */
export function writeFieldAttribute(decorators: Obj | null | undefined, key: string, value: unknown): Obj {
  const root: Obj = isObj(decorators) ? decorators : {};
  const typespec: Obj = isObj(root.typespec) ? root.typespec : {};
  const extensions: Obj = isObj(typespec.extensions) ? typespec.extensions : {};
  const openapi: Obj = isObj(extensions.openapi) ? extensions.openapi : {};

  const nextOpenapi: Obj = { ...openapi };
  if (value === undefined) delete nextOpenapi[key];
  else nextOpenapi[key] = value;

  const nextExtensions: Obj = { ...extensions, openapi: nextOpenapi };
  if (Object.keys(nextOpenapi).length === 0) delete nextExtensions.openapi;
  const nextTypespec: Obj = { ...typespec, extensions: nextExtensions };
  if (Object.keys(nextExtensions).length === 0) delete nextTypespec.extensions;
  const next: Obj = { ...root, typespec: nextTypespec };
  if (Object.keys(nextTypespec).length === 0) delete next.typespec;
  return next;
}

/** The x-* values of an entity (`metadata.custom.extensions`). */
export function readEntityAttributes(metadata: unknown): Record<string, unknown> {
  const custom = isObj(metadata) ? metadata.custom : undefined;
  return xOnly(isObj(custom) ? custom.extensions : undefined);
}

/** Set (or, with `undefined`, remove) one x-* value on an entity's metadata. */
export function writeEntityAttribute(metadata: Obj | null | undefined, key: string, value: unknown): Obj {
  const root: Obj = isObj(metadata) ? metadata : {};
  const custom: Obj = isObj(root.custom) ? root.custom : {};
  const extensions: Obj = isObj(custom.extensions) ? custom.extensions : {};

  const nextExtensions: Obj = { ...extensions };
  if (value === undefined) delete nextExtensions[key];
  else nextExtensions[key] = value;

  const nextCustom: Obj = { ...custom, extensions: nextExtensions };
  if (Object.keys(nextExtensions).length === 0) delete nextCustom.extensions;
  const next: Obj = { ...root, custom: nextCustom };
  if (Object.keys(nextCustom).length === 0) delete next.custom;
  return next;
}
