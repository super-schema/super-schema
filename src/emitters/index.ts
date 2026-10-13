/**
 * Emitter registry — barrel export for all emitters.
 */

import type { Emitter } from "@/lib/compiler/types";

// ---------------------------------------------------------------------------
// Emitter registry
//
// Empty as of 2026-10-12: the last two native emitters (avro, openapi) were
// retired in favor of real TypeSpec packages (@typespec/avro, official
// @typespec/openapi3), routed via src/lib/typespec-official/ like the
// database-DDL targets (spanner/postgresql/bigquery) before them. Every
// schema target in catalog.ts is now `runtime: "typespec-cli"` — none remain
// `"native"`. Kept as a stable extension point rather than deleted outright,
// in case a future target genuinely has no suitable TypeSpec emitter.
// ---------------------------------------------------------------------------

const emitterRegistry: Record<string, Emitter> = {};

/**
 * Get an emitter by target format name.
 */
export function getEmitter(targetFormat: string): Emitter | undefined {
  return emitterRegistry[targetFormat];
}

/**
 * Get all registered emitters.
 */
export function getAllEmitters(): Emitter[] {
  return Object.values(emitterRegistry);
}
