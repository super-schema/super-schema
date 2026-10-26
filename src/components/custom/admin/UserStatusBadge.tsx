import { Badge } from "@/components/ui/badge";
import type { UserStatus } from "@/types/schemas/user-admin";

const STATUS: Record<UserStatus, { label: string; variant: "success" | "destructive" | "info" }> = {
  active: { label: "Active", variant: "success" },
  disabled: { label: "Disabled", variant: "destructive" },
  invited: { label: "Invited", variant: "info" },
};

/** An account's status in words (never by colour alone): active, disabled, or invited (an invitation nobody has accepted). */
export function UserStatusBadge({ status }: { status: UserStatus }) {
  const { label, variant } = STATUS[status];
  return (
    <Badge variant={variant} data-testid="user-status" data-status={status}>
      {label}
    </Badge>
  );
}
