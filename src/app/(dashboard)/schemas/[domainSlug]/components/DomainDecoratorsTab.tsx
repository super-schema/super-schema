"use client";

import { Tag } from "lucide-react";
import { Badge } from "@/components/ui/badge";

export interface DecoratorDefinitionData {
  id: string;
  name: string;
  description: string;
  signature: string;
  targetTypes: string[];
}

interface DomainDecoratorsTabProps {
  decorators: DecoratorDefinitionData[];
}

export function DomainDecoratorsTab({ decorators }: DomainDecoratorsTabProps) {
  if (decorators.length === 0) {
    return (
      <div className="text-center py-16 text-muted-foreground" data-testid="domain-decorators-tab">
        <Tag className="w-8 h-8 mx-auto mb-2 text-muted-foreground/30" />
        <p className="text-body-small">No decorator definitions registered yet</p>
        <p className="text-caption mt-1">
          Import TypeSpec decorator declarations to catalog reusable domain annotations here.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-space-3" data-testid="domain-decorators-tab">
      {decorators.map((decorator) => (
        <div
          key={decorator.id}
          className="rounded-lg border border-border/30 p-space-3 hover:border-border transition-colors"
        >
          <div className="flex flex-wrap items-center gap-space-2 mb-1">
            <span className="font-mono text-body-small text-foreground font-medium">
              {decorator.name}
            </span>
            {decorator.targetTypes.map((targetType) => (
              <Badge
                key={`${decorator.id}-${targetType}`}
                variant="outline"
                className="text-[10px] h-4 px-1.5 font-mono"
              >
                {targetType}
              </Badge>
            ))}
          </div>
          <p className="text-caption text-muted-foreground font-mono">
            extern dec {decorator.name}({decorator.signature});
          </p>
          {decorator.description && (
            <p className="text-caption text-muted-foreground mt-1">{decorator.description}</p>
          )}
        </div>
      ))}
    </div>
  );
}
