import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { UserStatus } from "@/types/schemas/user-admin";

/**
 * Each status is its word first (never colour alone). Disabled is an outline in the destructive colour with ordinary text: the tinted destructive badge
 * puts red text on a red wash, which is under the contrast the accessibility scan asks for in the dark theme.
 */
const STATUS: Record<UserStatus, { label: string; variant: "success" | "outline" | "info"; className?: string }> = {
  active: { label: "Active", variant: "success" },
  disabled: { label: "Disabled", variant: "outline", className: "border-destructive/60" },
  invited: { label: "Invited", variant: "info" },
};

/** An account's status in words: active, disabled, or invited (an invitation nobody has accepted). */
export function UserStatusBadge({ status }: { status: UserStatus }) {
  const { label, variant, className } = STATUS[status];
  return (
    <Badge variant={variant} className={cn(className)} data-testid="user-status" data-status={status}>
      {label}
    </Badge>
  );
}
