"use client";

interface AuditDiffViewerProps {
  beforeState: unknown;
  afterState: unknown;
}

type DiffEntry = {
  key: string;
  type: "added" | "removed" | "changed" | "unchanged";
  before?: unknown;
  after?: unknown;
};

export function computeDiff(
  before: Record<string, unknown>,
  after: Record<string, unknown>
): DiffEntry[] {
  const allKeys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const diffs: DiffEntry[] = [];

  for (const key of Array.from(allKeys).sort()) {
    const hasBefore = key in before;
    const hasAfter = key in after;

    if (!hasBefore && hasAfter) {
      diffs.push({ key, type: "added", after: after[key] });
    } else if (hasBefore && !hasAfter) {
      diffs.push({ key, type: "removed", before: before[key] });
    } else if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) {
      diffs.push({
        key,
        type: "changed",
        before: before[key],
        after: after[key],
      });
    } else {
      diffs.push({ key, type: "unchanged", before: before[key] });
    }
  }

  return diffs;
}

const TYPE_COLORS: Record<string, { bg: string; text: string; prefix: string }> = {
  added: { bg: "bg-green-500/10", text: "text-green-400", prefix: "+" },
  removed: { bg: "bg-red-500/10", text: "text-red-400", prefix: "-" },
  changed: { bg: "bg-amber-500/10", text: "text-amber-400", prefix: "~" },
  unchanged: { bg: "", text: "text-muted-foreground", prefix: " " },
};

function formatValue(val: unknown): string {
  if (val === null || val === undefined) return "null";
  if (typeof val === "object") return JSON.stringify(val, null, 2);
  return String(val);
}

export function AuditDiffViewer({
  beforeState,
  afterState,
}: AuditDiffViewerProps) {
  const before =
    beforeState && typeof beforeState === "object" && beforeState !== null
      ? (beforeState as Record<string, unknown>)
      : {};
  const after =
    afterState && typeof afterState === "object" && afterState !== null
      ? (afterState as Record<string, unknown>)
      : {};

  if (Object.keys(before).length === 0 && Object.keys(after).length === 0) {
    return (
      <div className="text-body-small text-muted-foreground">
        No state data recorded
      </div>
    );
  }

  const diffs = computeDiff(before, after);

  return (
    <div className="font-mono text-caption" data-testid="audit-diff-viewer">
      <div className="flex gap-space-4 mb-space-2 text-muted-foreground">
        <span className="flex-1 font-semibold">Before</span>
        <span className="flex-1 font-semibold">After</span>
      </div>
      {diffs.map((diff) => {
        const colors = TYPE_COLORS[diff.type];
        return (
          <div
            key={diff.key}
            className={`flex gap-space-4 px-space-2 py-0.5 rounded ${colors.bg}`}
          >
            <div className="flex-1">
              <span className={colors.text}>{colors.prefix} </span>
              <span className="text-muted-foreground">{diff.key}: </span>
              {diff.type !== "added" && (
                <span className={colors.text}>
                  {formatValue(diff.before)}
                </span>
              )}
            </div>
            <div className="flex-1">
              {diff.type === "added" || diff.type === "changed" ? (
                <>
                  <span className={colors.text}>{colors.prefix} </span>
                  <span className="text-muted-foreground">{diff.key}: </span>
                  <span className={colors.text}>
                    {formatValue(diff.after)}
                  </span>
                </>
              ) : diff.type === "unchanged" ? (
                <>
                  <span className={colors.text}> </span>
                  <span className="text-muted-foreground">{diff.key}: </span>
                  <span className={colors.text}>
                    {formatValue(diff.before)}
                  </span>
                </>
              ) : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}
