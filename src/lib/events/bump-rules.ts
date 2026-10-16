import type { BumpKind } from "@/lib/entity-versioning/types";
import type { ResolvedPin } from "./types";

export interface BumpDecision {
  bump: BumpKind;
  reasons: string[];
}

/** Key-order independent JSON (undefined members dropped) for structural equality. */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((k) => record[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify(record[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export const decide = (major: string[], minor: string[]): BumpDecision =>
  major.length > 0 ? { bump: "MAJOR", reasons: [...major, ...minor] } : { bump: "MINOR", reasons: minor };

export function comparePin(role: string, prev: ResolvedPin | null, next: ResolvedPin | null, major: string[], minor: string[]): void {
  if (!prev && !next) return;
  if (prev && !next) {
    major.push(`${role} removed (was ${prev.entityName} v${prev.label})`);
    return;
  }
  if (!prev && next) {
    minor.push(`${role} added: ${next.entityName} v${next.label}`);
    return;
  }
  const p = prev as ResolvedPin;
  const n = next as ResolvedPin;
  if (p.entityId !== n.entityId) major.push(`${role} now references ${n.entityName} instead of ${p.entityName}`);
  else if (p.major !== n.major) major.push(`${role} pin moved from ${p.entityName} v${p.label} to v${n.label} (new major)`);
  else if (p.entityVersionId !== n.entityVersionId) minor.push(`${role} pin moved from v${p.label} to v${n.label}`);
}

/**
 * What a trait's headers pin identifies: the entity and the pinned version's major (R78). `major` / `label` are null for an
 * unpinned trait or a version row that no longer resolves: "unknown", never a MAJOR on its own.
 */
export interface BumpTraitHeadersPin {
  entityId: string;
  entityName?: string;
  entityVersionId: string | null;
  major: number | null;
  label: string | null;
}

const pinText = (pin: BumpTraitHeadersPin) => `${pin.entityName ?? pin.entityId}${pin.label ? ` v${pin.label}` : ""}`;
const versionText = (label: string | null) => (label ? `v${label}` : "(unpinned)");

/** R78: a trait's headers pin is part of every message that carries the trait, so moving it to another major is breaking. */
export function compareTraitHeaders(trait: string, prev: BumpTraitHeadersPin | null, next: BumpTraitHeadersPin | null, major: string[], minor: string[]): void {
  if (!prev && !next) return;
  if (!prev && next) {
    major.push(`Trait ${trait}: headers entity added (${pinText(next)})`);
    return;
  }
  if (prev && !next) {
    major.push(`Trait ${trait}: headers entity removed (was ${pinText(prev)})`);
    return;
  }
  const p = prev as BumpTraitHeadersPin;
  const n = next as BumpTraitHeadersPin;
  if (p.entityId !== n.entityId) {
    major.push(`Trait ${trait}: headers now reference ${n.entityName ?? n.entityId} instead of ${p.entityName ?? p.entityId}`);
  } else if (p.major !== null && n.major !== null && p.major !== n.major) {
    major.push(`Trait ${trait}: headers pin moved from ${pinText(p)} to ${versionText(n.label)} (new major)`);
  } else if (p.entityVersionId !== n.entityVersionId) {
    // Same major, or a side whose major is unknown: not provably breaking.
    minor.push(`Trait ${trait}: headers pin moved from ${versionText(p.label)} to ${versionText(n.label)}`);
  }
}
