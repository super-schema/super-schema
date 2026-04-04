/**
 * Webhook Service — In-memory store for MVP (no Prisma migration).
 *
 * Provides webhook endpoint CRUD, event dispatch with HMAC-SHA256 signing,
 * delivery tracking, and retry logic with exponential backoff.
 */

import crypto from "crypto";
import { ok, err } from "@/types/result";
import type { Result } from "@/types/result";
import {
  CreateWebhookEndpointInputSchema,
  UpdateWebhookEndpointInputSchema,
  type CreateWebhookEndpointInput,
  type UpdateWebhookEndpointInput,
  type WebhookEndpoint,
  type WebhookDelivery,
  type WebhookPayload,
} from "@/types/schemas/webhook";
import type { ServiceContext } from "@/types/service-context";

// ---------------------------------------------------------------------------
// In-memory stores (MVP — replaces Prisma tables)
// ---------------------------------------------------------------------------
let endpoints: WebhookEndpoint[] = [];
let deliveries: WebhookDelivery[] = [];
let idCounter = 0;

function generateId(prefix: string): string {
  idCounter++;
  return `${prefix}_${idCounter}_${Date.now()}`;
}

/** Exposed for testing — resets in-memory stores. */
export function _resetStore(): void {
  endpoints = [];
  deliveries = [];
  idCounter = 0;
}

/** Exposed for testing — returns the raw endpoint store. */
export function _getEndpoints(): WebhookEndpoint[] {
  return endpoints;
}

/** Exposed for testing — returns the raw delivery store. */
export function _getDeliveries(): WebhookDelivery[] {
  return deliveries;
}

// Retry backoff schedule: attempt 1 failed → 10s, attempt 2 → 60s, attempt 3 → 300s
const RETRY_DELAYS_MS = [10_000, 60_000, 300_000];
const MAX_ATTEMPTS = 4; // 1 initial + 3 retries

// ---------------------------------------------------------------------------
// CRUD operations
// ---------------------------------------------------------------------------

export async function createEndpoint(
  input: CreateWebhookEndpointInput,
  ctx: ServiceContext
): Promise<Result<WebhookEndpoint>> {
  // RBAC: Admin only
  if (ctx.userRole !== "ADMIN") {
    return err({
      code: "FORBIDDEN",
      message: "Only Admin users can create webhook endpoints",
    });
  }

  const parsed = CreateWebhookEndpointInputSchema.safeParse(input);
  if (!parsed.success) {
    return err({
      code: "VALIDATION_ERROR",
      message: parsed.error.issues[0].message,
    });
  }

  const endpoint: WebhookEndpoint = {
    id: generateId("whep"),
    url: parsed.data.url,
    events: parsed.data.events,
    secret: crypto.randomBytes(32).toString("hex"),
    active: parsed.data.active,
    createdBy: ctx.userId,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  endpoints.push(endpoint);
  return ok(endpoint);
}

export async function updateEndpoint(
  id: string,
  input: UpdateWebhookEndpointInput,
  ctx: ServiceContext
): Promise<Result<WebhookEndpoint>> {
  if (ctx.userRole !== "ADMIN") {
    return err({
      code: "FORBIDDEN",
      message: "Only Admin users can update webhook endpoints",
    });
  }

  const parsed = UpdateWebhookEndpointInputSchema.safeParse(input);
  if (!parsed.success) {
    return err({
      code: "VALIDATION_ERROR",
      message: parsed.error.issues[0].message,
    });
  }

  const endpoint = endpoints.find((e) => e.id === id);
  if (!endpoint) {
    return err({
      code: "NOT_FOUND",
      message: `Webhook endpoint "${id}" not found`,
    });
  }

  if (parsed.data.url !== undefined) endpoint.url = parsed.data.url;
  if (parsed.data.events !== undefined) endpoint.events = parsed.data.events;
  if (parsed.data.active !== undefined) endpoint.active = parsed.data.active;
  endpoint.updatedAt = new Date();

  return ok(endpoint);
}

export async function deleteEndpoint(
  id: string,
  ctx: ServiceContext
): Promise<Result<void>> {
  if (ctx.userRole !== "ADMIN") {
    return err({
      code: "FORBIDDEN",
      message: "Only Admin users can delete webhook endpoints",
    });
  }

  const index = endpoints.findIndex((e) => e.id === id);
  if (index === -1) {
    return err({
      code: "NOT_FOUND",
      message: `Webhook endpoint "${id}" not found`,
    });
  }

  endpoints.splice(index, 1);
  return ok(undefined);
}

export async function getEndpoints(
  ctx: ServiceContext
): Promise<Result<WebhookEndpoint[]>> {
  if (ctx.userRole !== "ADMIN") {
    return err({
      code: "FORBIDDEN",
      message: "Only Admin users can view webhook endpoints",
    });
  }

  return ok([...endpoints]);
}

export async function getDeliveries(
  endpointId: string,
  ctx: ServiceContext
): Promise<Result<WebhookDelivery[]>> {
  if (ctx.userRole !== "ADMIN") {
    return err({
      code: "FORBIDDEN",
      message: "Only Admin users can view webhook deliveries",
    });
  }

  const endpointDeliveries = deliveries
    .filter((d) => d.endpointId === endpointId)
    .sort((a, b) => b.deliveredAt.getTime() - a.deliveredAt.getTime());

  return ok(endpointDeliveries);
}

// ---------------------------------------------------------------------------
// HMAC Signing
// ---------------------------------------------------------------------------

export function computeHmacSignature(
  secret: string,
  payloadString: string
): string {
  return crypto
    .createHmac("sha256", secret)
    .update(payloadString)
    .digest("hex");
}

// ---------------------------------------------------------------------------
// HTTP Dispatch
// ---------------------------------------------------------------------------

async function sendWebhookRequest(
  endpoint: WebhookEndpoint,
  payload: WebhookPayload,
  attempt: number
): Promise<WebhookDelivery> {
  const payloadString = JSON.stringify(payload);
  const signature = computeHmacSignature(endpoint.secret, payloadString);

  const delivery: WebhookDelivery = {
    id: generateId("whdl"),
    endpointId: endpoint.id,
    event: payload.event,
    payload: payload as unknown as Record<string, unknown>,
    statusCode: null,
    error: null,
    attempt,
    nextRetryAt: null,
    deliveredAt: new Date(),
  };

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10_000);

    const response = await fetch(endpoint.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Webhook-Signature": `sha256=${signature}`,
      },
      body: payloadString,
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    delivery.statusCode = response.status;

    if (!response.ok) {
      delivery.error = `HTTP ${response.status}: ${response.statusText}`;
      scheduleRetry(delivery, attempt);
    }
  } catch (error) {
    delivery.error =
      error instanceof Error ? error.message : "Unknown fetch error";
    scheduleRetry(delivery, attempt);
  }

  deliveries.push(delivery);
  return delivery;
}

function scheduleRetry(delivery: WebhookDelivery, attempt: number): void {
  if (attempt < MAX_ATTEMPTS) {
    const delayMs = RETRY_DELAYS_MS[attempt - 1] ?? RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1];
    delivery.nextRetryAt = new Date(Date.now() + delayMs);
  }
}

// ---------------------------------------------------------------------------
// Event Dispatch (fire-and-forget)
// ---------------------------------------------------------------------------

export async function dispatchEvent(payload: WebhookPayload): Promise<void> {
  try {
    const matchingEndpoints = endpoints.filter(
      (e) => e.active && e.events.includes(payload.event)
    );

    await Promise.allSettled(
      matchingEndpoints.map((endpoint) =>
        sendWebhookRequest(endpoint, payload, 1)
      )
    );

    // Process retry queue opportunistically
    await processRetryQueue();
  } catch (error) {
    console.error("Webhook dispatchEvent failed:", error);
  }
}

// ---------------------------------------------------------------------------
// Retry Queue
// ---------------------------------------------------------------------------

export async function processRetryQueue(): Promise<void> {
  const now = new Date();

  const pendingRetries = deliveries.filter(
    (d) =>
      d.nextRetryAt !== null &&
      d.nextRetryAt <= now &&
      d.attempt < MAX_ATTEMPTS &&
      d.error !== null
  );

  for (const delivery of pendingRetries) {
    // Mark this delivery as processed (remove nextRetryAt)
    delivery.nextRetryAt = null;

    const endpoint = endpoints.find((e) => e.id === delivery.endpointId);
    if (!endpoint || !endpoint.active) continue;

    const payload = delivery.payload as unknown as WebhookPayload;
    await sendWebhookRequest(endpoint, payload, delivery.attempt + 1);
  }
}
