/**
 * Webhook Service — Prisma-backed persistence.
 *
 * Provides webhook endpoint CRUD, event dispatch with HMAC-SHA256 signing,
 * delivery tracking, and retry logic with exponential backoff.
 */

import crypto from "crypto";
import type { Prisma } from "@/generated/prisma/client";
import { ctxCan } from "@/lib/access";
import { isServiceUserId } from "@/lib/access/api-key";
import { prisma } from "@/lib/db";
import { isSealedSecret, openSecret, sealLegacySecret, sealSecret, SecretBoxError, type SecretField } from "@/lib/crypto/secret-box";
import { postWebhook, refuseEndpointUrl, WebhookTargetError } from "@/lib/webhook-transport";
import { ok, err } from "@/types/result";
import type { Result } from "@/types/result";
import {
  CreateWebhookEndpointInputSchema,
  UpdateWebhookEndpointInputSchema,
  type CreateWebhookEndpointInput,
  type UpdateWebhookEndpointInput,
  type WebhookEndpoint,
  type WebhookEndpointSummary,
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

/** The signing secret is stored sealed (src/lib/crypto/secret-box.ts); a value stored before sealing is plain and still signs. */
const SIGNING_SECRET: SecretField = "WebhookEndpoint.secret";

/**
 * The answer of a request that names no tenant. An endpoint belongs to one tenant, and a request that acts in none reaches no endpoint: an absent
 * tenant is never read as "every tenant" (Prisma reads an undefined filter as no filter).
 */
const NO_TENANT = "A webhook endpoint belongs to a tenant, and this request names none";

// ---------------------------------------------------------------------------
// Prisma row → app type mappers
// ---------------------------------------------------------------------------

/** A stored endpoint. `secret` is the stored value: sealed (or, before sealing, plain). Nothing but the signing reads it opened. */
type EndpointRow = {
  id: string;
  url: string;
  events: string[];
  secret: string;
  active: boolean;
  createdBy: string | null;
  tenantId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

/** The endpoint as every other answer shows it: no signing secret (KD-027). Reads no secret, so it needs no key. */
function toEndpointSummary(row: EndpointRow): WebhookEndpointSummary {
  const { id, url, events, active, createdBy, tenantId, createdAt, updatedAt } = row;
  return { id, url, events, active, createdBy, tenantId, createdAt, updatedAt };
}

/** The whole endpoint with its signing secret opened: for the test helper of the store. Throws when the stored secret cannot be opened. */
function toWebhookEndpoint(row: EndpointRow): WebhookEndpoint {
  return { ...toEndpointSummary(row), secret: openSecret(row.secret, SIGNING_SECRET) };
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
  if (!ctxCan(ctx, "platform.admin")) {
    return err({
      code: "FORBIDDEN",
      message: "Only Admin users can create webhook endpoints",
    });
  }

  // The endpoint belongs to the tenant the request acts in. The input cannot name another one: the schema drops any tenant it carries.
  if (!ctx.tenantId) return err({ code: "VALIDATION_ERROR", message: NO_TENANT });
  const tenantId = ctx.tenantId;

  const parsed = CreateWebhookEndpointInputSchema.safeParse(input);
  if (!parsed.success) {
    return err({
      code: "VALIDATION_ERROR",
      message: parsed.error.issues[0].message,
    });
  }

  // The destination is judged before anything is stored: an address the delivery would refuse is not made into an endpoint (KD-027).
  const refusal = await refuseEndpointUrl(parsed.data.url);
  if (refusal !== null) {
    return err({
      code: "VALIDATION_ERROR",
      message: refusal,
      suggestedFix: "Give an https address whose name resolves to a public address (docs/auth-ops.md, Webhooks).",
    });
  }

  const secret = crypto.randomBytes(32).toString("hex");
  let sealedSecret: string;
  try {
    sealedSecret = sealSecret(secret, SIGNING_SECRET);
  } catch (sealError) {
    // With no key the secret is not stored, so the endpoint is not made: an endpoint that cannot sign is not left behind.
    return err({
      code: "INTERNAL_ERROR",
      message: sealError instanceof Error ? sealError.message : "The signing secret cannot be stored",
      suggestedFix:
        sealError instanceof SecretBoxError
          ? "Set SECRETS_ENCRYPTION_KEY, or AUTH_SECRET, then try again (docs/auth-ops.md)."
          : "Try again.",
    });
  }

  const row = await prisma.webhookEndpoint.create({
    data: {
      url: parsed.data.url,
      events: parsed.data.events,
      secret: sealedSecret,
      active: parsed.data.active,
      // The API key's principal is no user row (a foreign key would refuse it): an endpoint it makes has no creator.
      createdBy: isServiceUserId(ctx.userId) ? null : ctx.userId,
      tenantId,
    },
  });

  // The one answer that carries the signing secret, in plain text: it is not shown again. The store keeps only the sealed value.
  return ok({ ...toEndpointSummary(row), secret });
}

export async function updateEndpoint(
  id: string,
  input: UpdateWebhookEndpointInput,
  ctx: ServiceContext
): Promise<Result<WebhookEndpointSummary>> {
  if (!ctxCan(ctx, "platform.admin")) {
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

  // Another tenant's endpoint is the same answer as a missing one: no endpoint of another tenant is shown or changed.
  if (!ctx.tenantId) return err({ code: "VALIDATION_ERROR", message: NO_TENANT });
  const existing = await prisma.webhookEndpoint.findFirst({ where: { id, tenantId: ctx.tenantId } });
  if (!existing) {
    return err({
      code: "NOT_FOUND",
      message: `Webhook endpoint "${id}" not found`,
    });
  }

  if (parsed.data.url !== undefined) {
    const refusal = await refuseEndpointUrl(parsed.data.url);
    if (refusal !== null) {
      return err({
        code: "VALIDATION_ERROR",
        message: refusal,
        suggestedFix: "Give an https address whose name resolves to a public address (docs/auth-ops.md, Webhooks).",
      });
    }
  }

  const data: Record<string, unknown> = {};
  if (parsed.data.url !== undefined) data.url = parsed.data.url;
  if (parsed.data.events !== undefined) data.events = parsed.data.events;
  if (parsed.data.active !== undefined) data.active = parsed.data.active;
  // A signing secret stored before sealing is sealed by this write (the value does not change). With no key, or a malformed one, it stays as
  // it is and the update still goes through (sealLegacySecret says so in the log when the key is malformed).
  if (!isSealedSecret(existing.secret)) {
    const sealed = sealLegacySecret(existing.secret, SIGNING_SECRET);
    if (sealed !== undefined) data.secret = sealed;
  }

  const updated = await prisma.webhookEndpoint.update({
    where: { id },
    data,
  });

  return ok(toEndpointSummary(updated));
}

export async function deleteEndpoint(
  id: string,
  ctx: ServiceContext
): Promise<Result<void>> {
  if (!ctxCan(ctx, "platform.admin")) {
    return err({
      code: "FORBIDDEN",
      message: "Only Admin users can delete webhook endpoints",
    });
  }

  if (!ctx.tenantId) return err({ code: "VALIDATION_ERROR", message: NO_TENANT });
  const existing = await prisma.webhookEndpoint.findFirst({ where: { id, tenantId: ctx.tenantId } });
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
): Promise<Result<WebhookEndpointSummary[]>> {
  if (!ctxCan(ctx, "platform.admin")) {
    return err({
      code: "FORBIDDEN",
      message: "Only Admin users can view webhook endpoints",
    });
  }

  if (!ctx.tenantId) return err({ code: "VALIDATION_ERROR", message: NO_TENANT });
  const rows = await prisma.webhookEndpoint.findMany({ where: { tenantId: ctx.tenantId } });
  return ok(rows.map(toEndpointSummary));
}

export async function getDeliveries(
  endpointId: string,
  ctx: ServiceContext
): Promise<Result<WebhookDelivery[]>> {
  if (!ctxCan(ctx, "platform.admin")) {
    return err({
      code: "FORBIDDEN",
      message: "Only Admin users can view webhook deliveries",
    });
  }

  // An endpoint that does not exist has no deliveries to list: 404, not an empty list that reads as "nothing was delivered yet".
  if (!ctx.tenantId) return err({ code: "VALIDATION_ERROR", message: NO_TENANT });
  const endpoint = await prisma.webhookEndpoint.findFirst({ where: { id: endpointId, tenantId: ctx.tenantId }, select: { id: true } });
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
  endpoint: EndpointRow,
  payload: WebhookPayload,
  attempt: number
): Promise<WebhookDelivery> {
  const payloadString = JSON.stringify(payload);

  let statusCode: number | null = null;
  let error: string | null = null;
  let nextRetryAt: Date | null = null;

  try {
    // The secret is opened where it signs. One that cannot be opened fails this delivery like any other error (recorded, retried), and
    // nothing is sent unsigned: the receiver could not check it. Its error names the field, never the value.
    const signature = computeHmacSignature(openSecret(endpoint.secret, SIGNING_SECRET), payloadString);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10_000);

    // The destination policy (https only, public addresses, no redirect) is in the transport (KD-027).
    const response = await postWebhook(endpoint.url, {
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
    // A refused destination stays refused: a retry would only repeat it.
    if (attempt < MAX_ATTEMPTS && !(fetchError instanceof WebhookTargetError)) {
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

/**
 * Sends `payload` to every active endpoint of the event's tenant that subscribed to its type. Every trigger names the tenant in `data.tenantId`;
 * an event that names none reaches nobody (an absent filter would mean every tenant), and that is logged.
 */
export async function dispatchEvent(payload: WebhookPayload): Promise<void> {
  try {
    const tenantId = payload.data.tenantId;
    if (typeof tenantId !== "string" || tenantId === "") {
      console.error(`Webhook dispatchEvent: the ${payload.event} event names no tenant, so no endpoint is sent it`);
      return;
    }
    const matchingEndpoints = await prisma.webhookEndpoint.findMany({
      where: {
        active: true,
        tenantId,
        events: { hasSome: [payload.event] },
      },
    });

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

  const pendingRetries = await prisma.webhookDelivery.findMany({
    where: {
      nextRetryAt: { lte: now },
      attempt: { lt: MAX_ATTEMPTS },
      error: { not: null },
    },
  });

  for (const delivery of pendingRetries) {
    // Claim the delivery before it is sent: clear nextRetryAt only while it is still due. Two sweeps (two dispatches in flight) can read the same
    // row; the one that clears it sends the retry, and the other finds nothing to claim and skips it.
    const claim = await prisma.webhookDelivery.updateMany({
      where: { id: delivery.id, nextRetryAt: { lte: now } },
      data: { nextRetryAt: null },
    });
    if (claim.count !== 1) continue;

    const endpoint = await prisma.webhookEndpoint.findUnique({
      where: { id: delivery.endpointId },
    });
    if (!endpoint || !endpoint.active) continue;

    const payload = delivery.payload as unknown as WebhookPayload;
    await sendWebhookRequest(endpoint, payload, delivery.attempt + 1);
  }
}
