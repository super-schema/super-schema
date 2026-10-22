/** Types of the corpus manifest (see manifest.ts and docs/superpowers/reports/2026-10-22-corpus-matrix.md). */
import type { PrismaEntityInput, PrismaFieldInput } from "@/lib/compiler/compiler.service";

export type CorpusKind = "jsonschema" | "typespec" | "model";

export const ALL_TARGETS = ["json-schema", "openapi3", "avro", "protobuf", "java-pojo", "postgresql", "spanner", "bigquery"] as const;
export type TargetKey = (typeof ALL_TARGETS)[number];

export interface CorpusExpectations {
  /** Patterns the import warnings must match (each at least once). */
  importWarnings?: RegExp[];
  /** Targets that generate with a warning on purpose (the matrix shows DEGRADED, and the reason is recorded). */
  expectedDegraded?: { target: TargetKey; reason: string }[];
  /** Known failures whose root cause is NOT in this repo (sibling emitter, tool limit); `issue` is the evidence. */
  expectedFailures?: { target: TargetKey | "*"; reason: string; issue: string; stage?: "emit" | "validate" }[];
  /** True when the case has no key and the DB targets are expected to ask for one (NEEDS_INPUT or a simulated answer). */
  requiresPrimaryKey?: boolean;
  /** Environment variables to set while importing (restored afterwards). */
  env?: Record<string, string>;
  /** The import itself is expected to be refused with a message matching this (the case documents the refusal). */
  importError?: RegExp;
  /** Skip the round-trip check. */
  roundTrip?: false;
}

export interface ModelInput {
  entity: Partial<PrismaEntityInput> & { name: string };
  fields: Array<Partial<PrismaFieldInput> & { name: string; type: string }>;
}

export interface CorpusCase {
  id: string;
  title: string;
  kind: CorpusKind;
  /** JSON / YAML text (jsonschema), .tsp text (typespec), or the entity + fields (model). */
  source: string | ModelInput;
  tags: string[];
  expectations: CorpusExpectations;
}
