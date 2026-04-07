"use client";

import { useState } from "react";
import { ChevronDown, ChevronRight, Hash, Sigma, GitMerge } from "lucide-react";
import { Badge } from "@/components/ui/badge";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SharedEnumData {
  id: string;
  name: string;
  values: string[];
  description: string;
}

export interface CustomScalarData {
  id: string;
  name: string;
  baseType: string;
  format: string | null;
  pattern: string | null;
  description: string;
}

export interface UnionTypeData {
  id: string;
  name: string;
  memberTypes: string[];
  description: string;
}

interface DomainTypesTabProps {
  sharedEnums: SharedEnumData[];
  customScalars: CustomScalarData[];
  unionTypes: UnionTypeData[];
}

// ---------------------------------------------------------------------------
// Collapsible section wrapper
// ---------------------------------------------------------------------------

function TypeSection({
  title,
  icon: Icon,
  count,
  defaultOpen,
  children,
}: {
  title: string;
  icon: React.ComponentType<{ className?: string }>;
  count: number;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen ?? count > 0);

  return (
    <div className="border border-border/50 rounded-lg overflow-hidden">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-space-2 w-full px-space-4 py-space-3 hover:bg-muted/30 transition-colors"
      >
        {open ? (
          <ChevronDown className="w-3.5 h-3.5 text-muted-foreground" />
        ) : (
          <ChevronRight className="w-3.5 h-3.5 text-muted-foreground" />
        )}
        <Icon className="w-4 h-4 text-muted-foreground" />
        <span className="text-body-small font-medium text-foreground">{title}</span>
        <Badge variant="secondary" className="text-[10px] h-4 px-1.5 ml-auto">
          {count}
        </Badge>
      </button>
      {open && <div className="border-t border-border/30 px-space-4 py-space-3">{children}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function DomainTypesTab({ sharedEnums, customScalars, unionTypes }: DomainTypesTabProps) {
  const totalCount = sharedEnums.length + customScalars.length + unionTypes.length;

  if (totalCount === 0) {
    return (
      <div className="text-center py-16 text-muted-foreground">
        <Hash className="w-8 h-8 mx-auto mb-2 text-muted-foreground/30" />
        <p className="text-body-small">No reusable types defined yet</p>
        <p className="text-caption mt-1">
          Import a TypeSpec file or create shared enums, scalars, and unions to see them here.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-space-3" data-testid="domain-types-tab">
      {/* Enums section */}
      <TypeSection title="Enums" icon={Hash} count={sharedEnums.length}>
        {sharedEnums.length === 0 ? (
          <p className="text-caption text-muted-foreground/60 italic">No shared enums</p>
        ) : (
          <div className="space-y-space-2">
            {sharedEnums.map((e) => (
              <div key={e.id} className="rounded-lg border border-border/30 p-space-3 hover:border-border transition-colors">
                <div className="flex items-center gap-space-2 mb-1">
                  <span className="font-mono text-body-small text-foreground font-medium">{e.name}</span>
                  <Badge variant="secondary" className="text-[10px] h-4 px-1">
                    {e.values.length} values
                  </Badge>
                </div>
                {e.description && (
                  <p className="text-caption text-muted-foreground mb-1.5">{e.description}</p>
                )}
                <div className="flex flex-wrap gap-1">
                  {e.values.slice(0, 12).map((v) => (
                    <Badge key={v} variant="outline" className="text-[10px] h-4 px-1.5 font-mono">
                      {v}
                    </Badge>
                  ))}
                  {e.values.length > 12 && (
                    <span className="text-[10px] text-muted-foreground/50">
                      +{e.values.length - 12} more
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </TypeSection>

      {/* Custom Scalars section */}
      <TypeSection title="Custom Scalars" icon={Sigma} count={customScalars.length}>
        {customScalars.length === 0 ? (
          <p className="text-caption text-muted-foreground/60 italic">No custom scalars</p>
        ) : (
          <div className="space-y-space-2">
            {customScalars.map((s) => (
              <div key={s.id} className="rounded-lg border border-border/30 p-space-3 hover:border-border transition-colors">
                <div className="flex items-center gap-space-2 mb-1">
                  <span className="font-mono text-body-small text-foreground font-medium">{s.name}</span>
                  <span className="text-caption text-muted-foreground">extends</span>
                  <Badge variant="secondary" className="text-[10px] h-4 px-1.5 font-mono">
                    {s.baseType}
                  </Badge>
                  {s.format && (
                    <Badge variant="outline" className="text-[10px] h-4 px-1.5 font-mono">
                      format: {s.format}
                    </Badge>
                  )}
                  {s.pattern && (
                    <Badge variant="outline" className="text-[10px] h-4 px-1.5 font-mono">
                      pattern: {s.pattern}
                    </Badge>
                  )}
                </div>
                {s.description && (
                  <p className="text-caption text-muted-foreground">{s.description}</p>
                )}
              </div>
            ))}
          </div>
        )}
      </TypeSection>

      {/* Unions section */}
      <TypeSection title="Unions" icon={GitMerge} count={unionTypes.length}>
        {unionTypes.length === 0 ? (
          <p className="text-caption text-muted-foreground/60 italic">No union types</p>
        ) : (
          <div className="space-y-space-2">
            {unionTypes.map((u) => (
              <div key={u.id} className="rounded-lg border border-border/30 p-space-3 hover:border-border transition-colors">
                <div className="flex items-center gap-space-2 mb-1">
                  <span className="font-mono text-body-small text-foreground font-medium">{u.name}</span>
                  <span className="text-caption text-muted-foreground">=</span>
                  <span className="font-mono text-caption text-muted-foreground">
                    {u.memberTypes.join(" | ")}
                  </span>
                </div>
                {u.description && (
                  <p className="text-caption text-muted-foreground">{u.description}</p>
                )}
              </div>
            ))}
          </div>
        )}
      </TypeSection>
    </div>
  );
}
