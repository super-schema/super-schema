/**
 * Completeness and validity alerts for tenant metadata attributes. Pure: stored values are only read, never changed.
 */

import type { AlertEntityInput, AlertFieldInput, EntityAlert } from "@/lib/validation/entity-alerts";
import type { MetadataAttributeDefinition } from "@/types/schemas/metadata-attribute";
import { abcPlacement, isPrimitiveField } from "./placement";
import { readEntityAttributes, readFieldAttributes } from "./values";
import { validateValue } from "./value-schema";

/** A value field, or an array whose elements are primitive. An entity reference is never subject to `requiredWhen: "primitive"`. */
function isPrimitiveLike(field: AlertFieldInput): boolean {
  const shape = { type: field.type ?? "string", decorators: field.decorators };
  return isPrimitiveField(shape) || abcPlacement(shape) === "items";
}

function show(value: unknown): string {
  const text = JSON.stringify(value);
  return text === undefined ? String(value) : text;
}

export function metadataAttributeAlerts(
  entity: AlertEntityInput,
  fields: AlertFieldInput[],
  defs: MetadataAttributeDefinition[],
): EntityAlert[] {
  const alerts: EntityAlert[] = [];

  const entityDefs = defs.filter((d) => d.targets.includes("entity"));
  const entityValues = readEntityAttributes(entity.metadata);
  for (const d of entityDefs) {
    const present = Object.prototype.hasOwnProperty.call(entityValues, d.key);
    if (!present) {
      if (d.requiredWhen === "always") {
        alerts.push({
          id: `entity-attr-METADATA_ATTRIBUTE_MISSING-${d.key}`,
          severity: "warning",
          category: "entity",
          title: `Attribute "${d.key}" not set`,
          description: `${d.label} (${d.key}) is required on every entity. Set a value.`,
          action: "Set attribute",
        });
      }
      continue;
    }
    for (const problem of validateValue(entityValues[d.key], d.valueSchema)) {
      alerts.push({
        id: `entity-attr-METADATA_ATTRIBUTE_INVALID-${d.key}`,
        severity: "warning",
        category: "entity",
        title: `Attribute "${d.key}" is invalid`,
        description: `${d.key} value ${show(entityValues[d.key])}: ${problem.message}`,
        action: "Fix attribute",
      });
      break;
    }
  }

  const fieldDefs = defs.filter((d) => d.targets.includes("field"));
  if (fieldDefs.length === 0) return alerts;
  for (const field of fields) {
    const values = readFieldAttributes(field.decorators);
    for (const d of fieldDefs) {
      const present = Object.prototype.hasOwnProperty.call(values, d.key);
      if (!present) {
        const required = d.requiredWhen === "always" || (d.requiredWhen === "primitive" && isPrimitiveLike(field));
        if (required) {
          alerts.push({
            id: `field-attr-METADATA_ATTRIBUTE_MISSING-${d.key}-${field.id}`,
            severity: "warning",
            category: "field",
            title: `Field "${field.name}" is missing ${d.key}`,
            description: `${d.label} (${d.key}) is required on this field. Set a value.`,
            fieldId: field.id,
            fieldName: field.name,
            action: "Edit field",
          });
        }
        continue;
      }
      const problems = validateValue(values[d.key], d.valueSchema);
      if (problems.length > 0) {
        alerts.push({
          id: `field-attr-METADATA_ATTRIBUTE_INVALID-${d.key}-${field.id}`,
          severity: "warning",
          category: "field",
          title: `Field "${field.name}" has an invalid ${d.key}`,
          description: `${d.key} value ${show(values[d.key])}: ${problems[0].message}`,
          fieldId: field.id,
          fieldName: field.name,
          action: "Edit field",
        });
      }
    }
  }
  return alerts;
}

/** An API operation, event channel, message or event operation, as the item alerts read it. */
export interface AttributeItemInput {
  /** Identifies the item in an alert id (a database id, or a document key). */
  id: string;
  /** What the alert calls it. */
  name: string;
  /** The item's stored extension map. */
  extensions?: Record<string, unknown> | null;
}

export type AttributeItemTarget = "operation" | "channel" | "message";

const NOUN: Record<AttributeItemTarget, string> = { operation: "Operation", channel: "Channel", message: "Message" };

/**
 * Alerts for the items of one target (API operations, event channels, messages or event operations): a `requiredWhen: "always"`
 * attribute that is not set, and a value outside its schema. Definitions that do not list `target` are ignored.
 */
export function itemAttributeAlerts(target: AttributeItemTarget, items: readonly AttributeItemInput[], defs: readonly MetadataAttributeDefinition[]): EntityAlert[] {
  const targetDefs = defs.filter((d) => d.targets.includes(target));
  if (targetDefs.length === 0) return [];
  const noun = NOUN[target];
  const alerts: EntityAlert[] = [];
  for (const item of items) {
    const values = item.extensions ?? {};
    for (const d of targetDefs) {
      if (!Object.prototype.hasOwnProperty.call(values, d.key)) {
        if (d.requiredWhen === "always") {
          alerts.push({
            id: `${target}-attr-METADATA_ATTRIBUTE_MISSING-${d.key}-${item.id}`,
            severity: "warning",
            category: "entity",
            title: `${noun} "${item.name}" is missing ${d.key}`,
            description: `${d.label} (${d.key}) is required on every ${target}. Set a value.`,
            action: `Edit ${target}`,
          });
        }
        continue;
      }
      const problems = validateValue(values[d.key], d.valueSchema);
      if (problems.length > 0) {
        alerts.push({
          id: `${target}-attr-METADATA_ATTRIBUTE_INVALID-${d.key}-${item.id}`,
          severity: "warning",
          category: "entity",
          title: `${noun} "${item.name}" has an invalid ${d.key}`,
          description: `${d.key} value ${show(values[d.key])}: ${problems[0].message}`,
          action: `Edit ${target}`,
        });
      }
    }
  }
  return alerts;
}

type KeyedItem = { key: string; extensions?: Record<string, unknown> };

/** The attribute alerts of an event document: its channels, messages and operations (named by their document key). */
export function eventAttributeAlerts(
  doc: { channels: readonly KeyedItem[]; messages: readonly KeyedItem[]; operations: readonly KeyedItem[] },
  defs: readonly MetadataAttributeDefinition[],
): EntityAlert[] {
  const named = (items: readonly KeyedItem[]): AttributeItemInput[] => items.map((i) => ({ id: i.key, name: i.key, extensions: i.extensions }));
  return [
    ...itemAttributeAlerts("channel", named(doc.channels), defs),
    ...itemAttributeAlerts("message", named(doc.messages), defs),
    ...itemAttributeAlerts("operation", named(doc.operations), defs),
  ];
}
