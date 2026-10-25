/**
 * Webhook Service — Prisma-backed persistence.
 *
 * Provides webhook endpoint CRUD, event dispatch with HMAC-SHA256 signing,
 * delivery tracking, and retry logic with exponential backoff.
 */

import crypto from "crypto";
import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
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
// Test helpers (delegate to Prisma)
// ---------------------------------------------------------------------------

/** Exposed for testing — resets stores. */
export async function _resetStore(): Promise<void> {
  await prisma.webhookDelivery.deleteMany();
  await prisma.webhookEndpoint.deleteMany();
}

/** Exposed for testing — returns the raw endpoint store. */
export async function _getEndpoints(): Promise<WebhookEndpoint[]> {
  const rows = await prisma.webhookEndpoint.findMany();
  return rows.map(toWebhookEndpoint);
}

/** Exposed for testing — returns the raw delivery store. */
export async function _getDeliveries(): Promise<WebhookDelivery[]> {
  const rows = await prisma.webhookDelivery.findMany();
  return rows.map(toWebhookDelivery);
}

// Retry backoff schedule: attempt 1 failed → 10s, attempt 2 → 60s, attempt 3 → 300s
const RETRY_DELAYS_MS = [10_000, 60_000, 300_000];
const MAX_ATTEMPTS = 4; // 1 initial + 3 retries

// ---------------------------------------------------------------------------
// Prisma row → app type mappers
// ---------------------------------------------------------------------------

function toWebhookEndpoint(row: {
  id: string;
  url: string;
  events: string[];
  secret: string;
  active: boolean;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}): WebhookEndpoint {
  return {
    id: row.id,
    url: row.url,
    events: row.events,
    secret: row.secret,
    active: row.active,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toWebhookDelivery(row: {
  id: string;
  endpointId: string;
  event: string;
  payload: unknown;
  statusCode: number | null;
  error: string | null;
  attempt: number;
  nextRetryAt: Date | null;
  deliveredAt: Date;
}): WebhookDelivery {
  return {
    id: row.id,
    endpointId: row.endpointId,
    event: row.event,
    payload: row.payload as Record<string, unknown>,
    statusCode: row.statusCode,
    error: row.error,
    attempt: row.attempt,
    nextRetryAt: row.nextRetryAt,
    deliveredAt: row.deliveredAt,
  };
}

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

  const row = await prisma.webhookEndpoint.create({
    data: {
      url: parsed.data.url,
      events: parsed.data.events,
      secret: crypto.randomBytes(32).toString("hex"),
      active: parsed.data.active,
      createdBy: ctx.userId,
    },
  });

  return ok(toWebhookEndpoint(row));
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

  const existing = await prisma.webhookEndpoint.findUnique({ where: { id } });
  if (!existing) {
    return err({
      code: "NOT_FOUND",
      message: `Webhook endpoint "${id}" not found`,
    });
  }

  const data: Record<string, unknown> = {};
  if (parsed.data.url !== undefined) data.url = parsed.data.url;
  if (parsed.data.events !== undefined) data.events = parsed.data.events;
  if (parsed.data.active !== undefined) data.active = parsed.data.active;

  const updated = await prisma.webhookEndpoint.update({
    where: { id },
    data,
  });

  return ok(toWebhookEndpoint(updated));
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

  const existing = await prisma.webhookEndpoint.findUnique({ where: { id } });
  if (!existing) {
    return err({
      code: "NOT_FOUND",
      message: `Webhook endpoint "${id}" not found`,
    });
  }

  await prisma.webhookEndpoint.delete({ where: { id } });
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

  const rows = await prisma.webhookEndpoint.findMany();
  return ok(rows.map(toWebhookEndpoint));
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

  // An endpoint that does not exist has no deliveries to list: 404, not an empty list that reads as "nothing was delivered yet".
  const endpoint = await prisma.webhookEndpoint.findUnique({ where: { id: endpointId }, select: { id: true } });
  if (!endpoint) {
    return err({
      code: "NOT_FOUND",
      message: `Webhook endpoint "${endpointId}" not found`,
    });
  }

  const rows = await prisma.webhookDelivery.findMany({
    where: { endpointId },
    orderBy: { deliveredAt: "desc" },
  });

  return ok(rows.map(toWebhookDelivery));
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

  let statusCode: number | null = null;
  let error: string | null = null;
  let nextRetryAt: Date | null = null;

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

    statusCode = response.status;

    if (!response.ok) {
      error = `HTTP ${response.status}: ${response.statusText}`;
      if (attempt < MAX_ATTEMPTS) {
        const delayMs = RETRY_DELAYS_MS[attempt - 1] ?? RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1];
        nextRetryAt = new Date(Date.now() + delayMs);
      }
    }
  } catch (fetchError) {
    error =
      fetchError instanceof Error ? fetchError.message : "Unknown fetch error";
    if (attempt < MAX_ATTEMPTS) {
      const delayMs = RETRY_DELAYS_MS[attempt - 1] ?? RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1];
      nextRetryAt = new Date(Date.now() + delayMs);
    }
  }

  const row = await prisma.webhookDelivery.create({
    data: {
      endpointId: endpoint.id,
      event: payload.event,
      payload: payload as unknown as Prisma.InputJsonValue,
      statusCode,
      error,
      attempt,
      nextRetryAt,
    },
  });

  return toWebhookDelivery(row);
}

// ---------------------------------------------------------------------------
// Event Dispatch (fire-and-forget)
// ---------------------------------------------------------------------------

export async function dispatchEvent(payload: WebhookPayload): Promise<void> {
  try {
    const matchingEndpoints = await prisma.webhookEndpoint.findMany({
      where: {
        active: true,
        events: { hasSome: [payload.event] },
      },
    });

    await Promise.allSettled(
      matchingEndpoints.map((endpoint) =>
        sendWebhookRequest(toWebhookEndpoint(endpoint), payload, 1)
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

  const pendingRetries = await prisma.webhookDelivery.findMany({
    where: {
      nextRetryAt: { lte: now },
      attempt: { lt: MAX_ATTEMPTS },
      error: { not: null },
    },
  });

  for (const delivery of pendingRetries) {
    // Mark this delivery as processed (remove nextRetryAt)
    await prisma.webhookDelivery.update({
      where: { id: delivery.id },
      data: { nextRetryAt: null },
    });

    const endpoint = await prisma.webhookEndpoint.findUnique({
      where: { id: delivery.endpointId },
    });
    if (!endpoint || !endpoint.active) continue;

    const payload = delivery.payload as unknown as WebhookPayload;
    await sendWebhookRequest(toWebhookEndpoint(endpoint), payload, delivery.attempt + 1);
  }
}
