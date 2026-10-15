import type { ActionNotice } from "@/lib/action-error";

/** Inline failure banner for an event form: the message plus the service's suggested fix, as one alert region. */
export function ActionNoticeAlert({ notice, testId }: { notice: ActionNotice | null; testId?: string }) {
  if (!notice) return null;
  return (
    <div role="alert" data-testid={testId} className="space-y-space-1 text-body-small text-destructive">
      <p>{notice.message}</p>
      {notice.fix && <p className="text-caption text-muted-foreground">{notice.fix}</p>}
    </div>
  );
}
