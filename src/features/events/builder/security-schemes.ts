// src/features/events/builder/security-schemes.ts
// `components.securitySchemes` as the builder edits it. A scheme's NAME is the key the rest of the document points at
// (`servers[].security`, `operations[].security`, an operation trait's `spec.security`), so renaming and removing one has to rewrite
// those references, and an emptied `securitySchemes` / `components` is dropped instead of saved empty. Pure — no React.
import { isReservedKey } from "@/lib/event-specs/own-property";
import {
  KEY_MAX_LENGTH, KEY_PATTERN, type DocComponents, type DocSecurityScheme, type EventDocument,
} from "@/lib/events/document/types";
import { slugKey, uniqueKey } from "@/lib/events/document/keys";

export type SchemeRename = { success: true; data: EventDocument } | { success: false; message: string };

/** The security schemes of the document, empty when it has none. */
export const schemesOf = (doc: EventDocument): Record<string, DocSecurityScheme> => doc.components?.securitySchemes ?? {};

const has = (doc: EventDocument, name: string): boolean => Object.hasOwn(schemesOf(doc), name);

/** The keys of the items that name a scheme, by kind. Library traits carry no spec, so they never do. */
export interface SchemeReferences { servers: string[]; operations: string[]; traits: string[] }

const names = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : []);

export function schemeReferences(doc: EventDocument, name: string): SchemeReferences {
  return {
    servers: doc.servers.filter((s) => names(s.security).includes(name)).map((s) => s.key),
    operations: doc.operations.filter((o) => names(o.security).includes(name)).map((o) => o.key),
    traits: doc.traits.filter((t) => "spec" in t && names(t.spec.security).includes(name)).map((t) => t.key),
  };
}

/**
 * Why `name` cannot be the name of a scheme, or null when it can. `current` is the name the scheme has now (null for a scheme not
 * yet in the document), which stays valid. The rule is the components key rule the parser applies to the map.
 */
export function schemeNameProblem(doc: EventDocument, name: string, current: string | null): string | null {
  if (name === "") return "A name is required.";
  if (name.length > KEY_MAX_LENGTH) return `A name can be at most ${KEY_MAX_LENGTH} characters.`;
  if (!KEY_PATTERN.test(name)) return 'Use only letters, digits, ".", "_" and "-" (no spaces).';
  if (isReservedKey(name)) return `"${name}" is reserved. Choose another name.`;
  if (name !== current && has(doc, name)) return `A security scheme named "${name}" already exists.`;
  return null;
}

/** The name a new scheme starts with: `scheme`, `scheme-2`, … while taken. */
export function newSchemeName(doc: EventDocument): string {
  return uniqueKey(slugKey("scheme"), Object.keys(schemesOf(doc)));
}

/** `doc` with `schemes` as its security schemes; `securitySchemes` and then `components` are dropped when nothing is left in them. */
function withSchemes(doc: EventDocument, schemes: Record<string, DocSecurityScheme>): EventDocument {
  const { components, ...rest } = doc;
  const others: DocComponents = { ...components };
  delete others.securitySchemes;
  const next: DocComponents = Object.keys(schemes).length > 0 ? { ...others, securitySchemes: schemes } : others;
  return Object.keys(next).length > 0 ? { ...rest, components: next } : rest;
}

/** Add a scheme named `name` (the caller checked `schemeNameProblem`). */
export function addSecurityScheme(doc: EventDocument, name: string, scheme: DocSecurityScheme): EventDocument {
  return withSchemes(doc, { ...schemesOf(doc), [name]: scheme });
}

/** Replace the scheme `name` in place, so the schemes keep their order. A name the document does not have changes nothing. */
export function updateSecurityScheme(doc: EventDocument, name: string, scheme: DocSecurityScheme): EventDocument {
  if (!has(doc, name)) return doc;
  return withSchemes(doc, Object.fromEntries(Object.entries(schemesOf(doc)).map(([key, value]) => [key, key === name ? scheme : value])));
}

/**
 * `doc` with every security list (servers, operations, the spec of a local trait) passed through `change`. A list `change` empties
 * is removed. Items that hold no change keep their identity.
 */
function rewriteSecurity(doc: EventDocument, change: (list: string[]) => string[]): EventDocument {
  const apply = <T extends { security?: unknown }>(item: T): T => {
    if (!Array.isArray(item.security)) return item;
    const list = change(names(item.security));
    if (list.length === names(item.security).length && list.every((n, i) => n === names(item.security)[i])) return item;
    const next = { ...item };
    if (list.length > 0) next.security = list;
    else delete next.security;
    return next;
  };
  return {
    ...doc,
    servers: doc.servers.map(apply),
    operations: doc.operations.map(apply),
    traits: doc.traits.map((t) => {
      if (!("spec" in t)) return t;
      const spec = apply(t.spec);
      return spec === t.spec ? t : { ...t, spec };
    }),
  };
}

/** Rename a scheme in place and rewrite every reference to it. Refuses an invalid or taken name and a scheme that does not exist. */
export function renameSecurityScheme(doc: EventDocument, from: string, to: string): SchemeRename {
  if (!has(doc, from)) return { success: false, message: `There is no security scheme named "${from}".` };
  if (from === to) return { success: true, data: doc };
  const problem = schemeNameProblem(doc, to, from);
  if (problem) return { success: false, message: problem };
  const renamed = withSchemes(doc, Object.fromEntries(Object.entries(schemesOf(doc)).map(([key, value]) => [key === from ? to : key, value])));
  return { success: true, data: rewriteSecurity(renamed, (list) => list.map((n) => (n === from ? to : n))) };
}

/** Remove a scheme and every reference to it. A name the document does not have changes nothing. */
export function removeSecurityScheme(doc: EventDocument, name: string): EventDocument {
  if (!has(doc, name)) return doc;
  const kept = Object.fromEntries(Object.entries(schemesOf(doc)).filter(([key]) => key !== name));
  return rewriteSecurity(withSchemes(doc, kept), (list) => list.filter((n) => n !== name));
}
