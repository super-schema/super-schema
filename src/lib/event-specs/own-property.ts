/**
 * Own-property helpers for objects whose KEYS come from a user document (operation / server / channel / message
 * names, JSON Schema property names).
 *
 * `target["__proto__"] = value` does not create a property: it runs the `Object.prototype.__proto__` setter, so the
 * entry silently vanishes and the object's prototype changes. `setOwn` defines a real own property instead, so every
 * key — `__proto__` included — survives into the serialized document.
 */

/** Keys that are never valid as a document key (operation / server keys, component names): they collide with `Object.prototype`. */
export const RESERVED_KEYS: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);

export function isReservedKey(key: string): boolean {
  return RESERVED_KEYS.has(key);
}

export function setOwn<T extends object>(target: T, key: string, value: unknown): T {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
  return target;
}
