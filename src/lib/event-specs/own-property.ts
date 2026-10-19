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

/**
 * RESERVED NAMES for as long as we use this AsyncAPI parser: the keys `@asyncapi/parser` cannot read. A document with one of them as an
 * object key (a channel, a message, a JSON Schema property, a binding, an `x-` extension, a server variable ...) makes the parser throw,
 * so such a name is refused everywhere a user can type one: the builder's key editors, the document parser, an entity's field names (the
 * field editor, the services, every importer) and, as the last line of defence for data that already has one, the validator every emitted
 * document passes through (`findParserUnsafeKeys`, `PARSER_UNSAFE_KEY`).
 *
 * Causes (found by running every name of `Object.getOwnPropertyNames(Object.prototype)` through the real parser, see the sweep test):
 * - `hasOwnProperty`: `@stoplight/json-ref-resolver` (inside `@asyncapi/parser`) walks every object of the document with
 *   `if (!target.hasOwnProperty(key)) continue;` (`crawler.js:35`), so an object with an OWN key of that name shadows the method and the
 *   parser fails with `TypeError: target.hasOwnProperty is not a function`, wherever the key sits. The key is valid JSON and valid
 *   AsyncAPI and the tools that read our documents use the same resolver, so a document that has one is refused, not patched or renamed.
 * - `__proto__`: an own key of that name crashes the parser inside `x-` maps, bindings and objects in arrays (`'ownKeys' on proxy: trap
 *   returned extra keys but proxy target is non-extensible`). It is also in `RESERVED_KEYS`, so it stays reserved when this list shrinks.
 *
 * HOW TO LIFT IT: this set is the ONE place. When `@asyncapi/parser` / `@stoplight/json-ref-resolver` no longer crashes on a key named X
 * (or we ship a fixed copy of them), `tests/unit/lib/event-specs/parser-unsafe-keys-sweep.test.ts` goes red: remove X from this set and
 * every refusal listed above disappears with it. The list is empirical; the sweep test pins it. Lower-case `hasownproperty` and
 * `HasOwnProperty` are different names and are read fine.
 */
export const PARSER_UNSAFE_KEYS: ReadonlySet<string> = new Set(["hasOwnProperty", "__proto__"]);

export function isParserUnsafeKey(key: string): boolean {
  return PARSER_UNSAFE_KEYS.has(key);
}

/**
 * True for a name that may not be used as a LOCAL document key (a channel, message, server, operation, trait or security-scheme key): the
 * names that collide with `Object.prototype` (`RESERVED_KEYS`) and the ones the AsyncAPI parser cannot read (`PARSER_UNSAFE_KEYS`).
 * The assembler's own `RESERVED_KEY` check uses `RESERVED_KEYS` alone: `hasOwnProperty` is reported once, by the validator's guard.
 */
export function isReservedKey(key: string): boolean {
  return RESERVED_KEYS.has(key) || PARSER_UNSAFE_KEYS.has(key);
}

export function setOwn<T extends object>(target: T, key: string, value: unknown): T {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
  return target;
}
