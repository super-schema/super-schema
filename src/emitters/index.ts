/**
 * Emitter registry — barrel export for all emitters.
 */

import type { Emitter } from "@/lib/compiler/types";
import { openApiEmitter } from "./openapi";
import { avroEmitter } from "./avro";
import { BigQueryEmitter } from "./bigquery";
import { SpannerEmitter } from "./spanner";

// ---------------------------------------------------------------------------
// Emitter registry
// ---------------------------------------------------------------------------

const bigQueryEmitter = new BigQueryEmitter();
const spannerEmitter = new SpannerEmitter();

const emitterRegistry: Record<string, Emitter> = {
  openapi: openApiEmitter,
  avro: avroEmitter,
  bigquery: bigQueryEmitter,
  spanner: spannerEmitter,
};

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

export { openApiEmitter } from "./openapi";
export { avroEmitter } from "./avro";
export { BigQueryEmitter } from "./bigquery";
export { SpannerEmitter } from "./spanner";
