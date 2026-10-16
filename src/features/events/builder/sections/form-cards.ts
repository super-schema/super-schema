// src/features/events/builder/sections/form-cards.ts
// The pure side of the accordion cards of the message and operation forms: which template fields a card draws, the value it hands to its
// TemplateForm (only its own keys) and how an edit is merged back, how many of its fields are set, and which cards hold a problem.
import { isFieldSet } from "../template/value";
import type { DocumentProblem } from "@/lib/events/document/types";
import type { FieldTemplate, ObjectTemplate } from "@/lib/events/templates";
import { problemsByField } from "../problems";

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** `template` restricted to `keys` (in that order), every field in the basics group: a card has no "More properties" toggle of its own. */
export function cardTemplate(template: ObjectTemplate, keys: readonly string[]): ObjectTemplate {
  const fields = keys
    .map((key) => template.fields.find((f) => f.key === key))
    .filter((f): f is FieldTemplate => f !== undefined)
    .map((f): FieldTemplate => ({ ...f, group: "basics" }));
  return { ...template, fields };
}

/** The part of `value` a card shows: only its own keys. */
export function pickValue(value: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of keys) if (Object.hasOwn(value, k)) out[k] = value[k];
  return out;
}

/** `full` with the card's keys replaced by `next` (the card's cleaned value): every other key is carried over untouched. */
export function mergeValue(full: Record<string, unknown>, keys: readonly string[], next: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(full)) if (!keys.includes(k)) out[k] = v;
  for (const k of keys) if (Object.hasOwn(next, k)) out[k] = next[k];
  return out;
}

/** How many of the card's template fields are set in `value` (what the count badge shows). */
export function setFieldCount(template: ObjectTemplate, keys: readonly string[], value: Record<string, unknown>): number {
  return keys.filter((key) => {
    const field = template.fields.find((f) => f.key === key);
    return field !== undefined && isFieldSet(field, value);
  }).length;
}

/** The number of protocol bindings set (`{ kafka: {...}, mqtt: {...} }` is 2). */
export function bindingCount(bindings: unknown): number {
  return isRecord(bindings) ? Object.keys(bindings).length : 0;
}

/**
 * The ids of the cards that hold a problem. `fields` maps a card id to the pointer segments (below `prefix`) it draws, e.g.
 * `{ payload: ["payload", "representation"] }` for `/messages/0/payload`.
 */
export function cardsWithProblems(problems: DocumentProblem[], prefix: string, fields: Record<string, readonly string[]>): Set<string> {
  const ids = new Set<string>();
  for (const [card, segments] of Object.entries(fields)) {
    if (segments.some((segment) => problemsByField(problems, `${prefix}/${segment}`).length > 0)) ids.add(card);
  }
  return ids;
}
