import type { NotificationType, EntityRef } from "@/types/schemas/notification";

export type NotificationItemData = {
  id: string;
  userId: string;
  type: NotificationType;
  title: string;
  body: string;
  entityRef: EntityRef;
  read: boolean;
  createdAt: Date;
};

export type NotificationGroup = {
  label: string;
  types: NotificationType[];
  notifications: NotificationItemData[];
};

export type NotificationCenterProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

export const NOTIFICATION_GROUPS: {
  label: string;
  types: NotificationType[];
  icon: string;
  color: string;
}[] = [
  {
    label: "Approvals",
    types: ["APPROVAL_REQUEST", "APPROVAL_DECISION"],
    icon: "shield",
    color: "text-blue-400",
  },
  {
    label: "Changes",
    types: ["CHANGE_COMPLETE"],
    icon: "check-circle",
    color: "text-green-400",
  },
  {
    label: "Mentions",
    types: ["ANNOTATION_TAG", "ANNOTATION_REPLY"],
    icon: "at-sign",
    color: "text-purple-400",
  },
  {
    label: "Alerts",
    types: ["DRIFT_ALERT", "COMPLIANCE_GAP"],
    icon: "alert-triangle",
    color: "text-amber-400",
  },
];
