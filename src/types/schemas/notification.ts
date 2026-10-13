import { z } from "zod";

export const NotificationType = z.enum([
  "APPROVAL_REQUEST",
  "APPROVAL_DECISION",
  "CHANGE_COMPLETE",
  "DRIFT_ALERT",
  "ANNOTATION_TAG",
  "ANNOTATION_REPLY",
  "COMPLIANCE_GAP",
]);

export type NotificationType = z.infer<typeof NotificationType>;

export const EntityRefSchema = z.object({
  entityId: z.string().min(1),
  domainSlug: z.string().min(1).optional(),
  productSlug: z.string().min(1).optional(),
  entitySlug: z.string().min(1).optional(),
  fieldId: z.string().optional(),
  fieldSlug: z.string().min(1).optional(),
  versionId: z.string().optional(),
});

export type EntityRef = z.infer<typeof EntityRefSchema>;

export const CreateNotificationInputSchema = z.object({
  userId: z.string().min(1, "userId is required"),
  type: NotificationType,
  title: z.string().min(1, "Title is required").max(256),
  body: z.string().min(1, "Body is required").max(2048),
  entityRef: EntityRefSchema,
});

export type CreateNotificationInput = z.infer<typeof CreateNotificationInputSchema>;

export const NotificationFilterSchema = z.object({
  types: z.array(NotificationType).optional(),
  read: z.boolean().optional(),
});

export type NotificationFilter = z.infer<typeof NotificationFilterSchema>;

export const PaginationSchema = z.object({
  page: z.number().int().min(1).default(1),
  pageSize: z.number().int().min(1).max(100).default(25),
});

export type Pagination = z.infer<typeof PaginationSchema>;

export type Notification = {
  id: string;
  userId: string;
  type: NotificationType;
  title: string;
  body: string;
  entityRef: EntityRef;
  read: boolean;
  createdAt: Date;
};
