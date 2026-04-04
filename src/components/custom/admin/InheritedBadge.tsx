"use client";

interface InheritedBadgeProps {
  domainName: string;
}

/**
 * Small badge showing "Inherited from {DomainName}".
 * Displayed next to field decorator values that came from domain policy template.
 */
export function InheritedBadge({ domainName }: InheritedBadgeProps) {
  return (
    <span
      className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] text-muted-foreground bg-muted/80"
      title={`This value was inherited from the "${domainName}" domain policy template`}
    >
      <span className="opacity-70">&darr;</span>
      Inherited from {domainName}
    </span>
  );
}
