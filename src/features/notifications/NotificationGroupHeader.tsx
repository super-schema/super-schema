"use client";

type NotificationGroupHeaderProps = {
  label: string;
  count: number;
};

export function NotificationGroupHeader({
  label,
  count,
}: NotificationGroupHeaderProps) {
  return (
    <div className="px-3 py-1.5 text-xs font-semibold text-muted-foreground uppercase tracking-wider">
      {label} ({count})
    </div>
  );
}
