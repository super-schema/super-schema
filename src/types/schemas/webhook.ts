import { z } from "zod";

export const WebhookEventType = z.enum([
  "governance.request.created",
  "governance.request.approved",
  "governance.request.rejected",
  "emission.completed",
  "drift.detected",
  "compliance.gap.detected",
]);

export type WebhookEventType = z.infer<typeof WebhookEventType>;

export const WEBHOOK_EVENT_TYPES = WebhookEventType.options;

export const CreateWebhookEndpointInputSchema = z.object({
  url: z.string().url("URL must be a valid URL"),
  events: z
    .array(WebhookEventType)
    .min(1, "At least one event type is required"),
  active: z.boolean().optional().default(true),
});

export type CreateWebhookEndpointInput = z.infer<typeof CreateWebhookEndpointInputSchema>;

export const UpdateWebhookEndpointInputSchema = z.object({
  url: z.string().url("URL must be a valid URL").optional(),
  events: z.array(WebhookEventType).min(1).optional(),
  active: z.boolean().optional(),
});

export type UpdateWebhookEndpointInput = z.infer<typeof UpdateWebhookEndpointInputSchema>;

export type WebhookPayload = {
  event: string;
  timestamp: string;
  data: Record<string, unknown>;
};

export type WebhookEndpoint = {
  id: string;
  url: string;
  events: string[];
  secret: string;
  active: boolean;
  /** The user who created it; null for an endpoint made by the REST API key (a service principal, which is no user row). */
  createdBy: string | null;
  /** The tenant the endpoint belongs to: it is sent that tenant's events only. Null: an endpoint that could not be attributed (inactive). */
  tenantId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

/** What every answer but the creation carries: the endpoint WITHOUT its signing secret (KD-027: the secret is shown once). */
export type WebhookEndpointSummary = Omit<WebhookEndpoint, "secret">;

export type WebhookDelivery = {
  id: string;
  endpointId: string;
  event: string;
  payload: Record<string, unknown>;
  statusCode: number | null;
  error: string | null;
  attempt: number;
  nextRetryAt: Date | null;
  deliveredAt: Date;
};
