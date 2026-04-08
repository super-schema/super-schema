"use client";

import { useState } from "react";
import { ChevronDown, ChevronRight, Globe } from "lucide-react";
import { Badge } from "@/components/ui/badge";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface OperationParamData {
  name: string;
  type: string;
  location: string;
  required: boolean;
  description: string;
}

interface OperationResponseData {
  statusCode: number;
  type: string | null;
  description: string;
}

interface OperationData {
  id: string;
  name: string;
  httpMethod: string;
  httpPath: string;
  description: string;
  parameters: OperationParamData[];
  responses: OperationResponseData[];
}

export interface ServiceData {
  id: string;
  name: string;
  description: string;
  basePath: string;
  scope: "DOMAIN" | "ENTITY";
  entity: {
    id: string;
    name: string;
    slug: string;
  } | null;
  operations: OperationData[];
}

interface DomainApisTabProps {
  services: ServiceData[];
}

// ---------------------------------------------------------------------------
// HTTP method styling (mirrors ApiTab)
// ---------------------------------------------------------------------------

const METHOD_COLORS: Record<string, string> = {
  GET: "bg-green-500/15 text-green-600 border-green-500/30",
  POST: "bg-blue-500/15 text-blue-600 border-blue-500/30",
  PUT: "bg-amber-500/15 text-amber-600 border-amber-500/30",
  DELETE: "bg-red-500/15 text-red-600 border-red-500/30",
  PATCH: "bg-purple-500/15 text-purple-600 border-purple-500/30",
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function DomainApisTab({ services }: DomainApisTabProps) {
  const [expandedService, setExpandedService] = useState<string | null>(null);
  const [expandedOp, setExpandedOp] = useState<string | null>(null);

  if (services.length === 0) {
    return (
      <div className="text-center py-16 text-muted-foreground">
        <Globe className="w-8 h-8 mx-auto mb-2 text-muted-foreground/30" />
        <p className="text-body-small">No API services defined yet</p>
        <p className="text-caption mt-1">
          Import a TypeSpec file with interfaces or create services to see them here.
        </p>
      </div>
    );
  }

  const totalOps = services.reduce((sum, s) => sum + s.operations.length, 0);
  const entityServices = services.filter((service) => service.scope === "ENTITY");
  const domainServices = services.filter((service) => service.scope !== "ENTITY");

  return (
    <div className="space-y-space-3" data-testid="domain-apis-tab">
      {/* Summary */}
      <div className="flex items-center gap-space-2 text-caption text-muted-foreground">
        <span>
          {services.length} service{services.length !== 1 ? "s" : ""} with {totalOps} operation{totalOps !== 1 ? "s" : ""}
        </span>
      </div>

      {[
        { title: "Domain APIs", services: domainServices },
        { title: "Entity APIs", services: entityServices },
      ].map(({ title, services: groupedServices }) => (
        <div key={title} className="space-y-space-2">
          <div className="flex items-center justify-between">
            <h3 className="text-body-small font-medium text-foreground">{title}</h3>
            <span className="text-caption text-muted-foreground">{groupedServices.length}</span>
          </div>
          {groupedServices.length === 0 ? (
            <p className="text-caption text-muted-foreground/60 italic">
              No {title.toLowerCase()} yet
            </p>
          ) : (
            groupedServices.map((service) => {
        const isExpanded = expandedService === service.id;

        return (
          <div key={service.id} className="border border-border/50 rounded-lg overflow-hidden">
            {/* Service header */}
            <button
              onClick={() => setExpandedService(isExpanded ? null : service.id)}
              className="flex items-center gap-space-2 w-full px-space-4 py-space-3 hover:bg-muted/30 transition-colors"
            >
              {isExpanded ? (
                <ChevronDown className="w-3.5 h-3.5 text-muted-foreground" />
              ) : (
                <ChevronRight className="w-3.5 h-3.5 text-muted-foreground" />
              )}
              <Globe className="w-4 h-4 text-primary" />
              <span className="font-mono text-body-small text-foreground font-medium">
                {service.name}
              </span>
              <Badge variant="outline" className="text-[10px] h-4 px-1.5 uppercase">
                {service.scope === "ENTITY" ? "entity" : "domain"}
              </Badge>
              {service.entity && (
                <span className="text-caption text-muted-foreground">
                  {service.entity.name}
                </span>
              )}
              {service.basePath !== "/" && (
                <span className="font-mono text-caption text-muted-foreground">
                  {service.basePath}
                </span>
              )}
              <Badge variant="secondary" className="text-[10px] h-4 px-1.5 ml-auto">
                {service.operations.length} op{service.operations.length !== 1 ? "s" : ""}
              </Badge>
            </button>

            {/* Expanded: show operations */}
            {isExpanded && (
              <div className="border-t border-border/30">
                {service.description && (
                  <p className="text-caption text-muted-foreground px-space-4 py-space-2 border-b border-border/20">
                    {service.description}
                  </p>
                )}

                {service.operations.length === 0 ? (
                  <p className="text-caption text-muted-foreground/60 italic px-space-4 py-space-3">
                    No operations
                  </p>
                ) : (
                  <div>
                    {service.operations.map((op) => {
                      const isOpExpanded = expandedOp === op.id;
                      const methodColor = METHOD_COLORS[op.httpMethod] ?? METHOD_COLORS.GET;

                      return (
                        <div key={op.id} className="border-b border-border/20 last:border-b-0">
                          <button
                            onClick={() => setExpandedOp(isOpExpanded ? null : op.id)}
                            className="flex items-center gap-2 w-full px-space-4 py-space-2 hover:bg-muted/20 transition-colors"
                          >
                            {isOpExpanded ? (
                              <ChevronDown className="w-3 h-3 text-muted-foreground/50" />
                            ) : (
                              <ChevronRight className="w-3 h-3 text-muted-foreground/50" />
                            )}
                            <Badge className={`text-[11px] h-5 font-mono font-bold border ${methodColor}`}>
                              {op.httpMethod}
                            </Badge>
                            <span className="font-mono text-body-small text-foreground">
                              {op.httpPath}
                            </span>
                            <span className="text-caption text-muted-foreground flex-1 text-left truncate ml-2">
                              {op.name}
                            </span>
                            <span className="text-[10px] text-muted-foreground/50">
                              {op.parameters.length}p / {op.responses.length}r
                            </span>
                          </button>

                          {/* Operation details */}
                          {isOpExpanded && (
                            <div className="px-space-6 pb-space-3 space-y-space-2">
                              {op.description && (
                                <p className="text-caption text-muted-foreground">{op.description}</p>
                              )}

                              {/* Parameters */}
                              {op.parameters.length > 0 && (
                                <div>
                                  <span className="text-[10px] text-muted-foreground/60 uppercase tracking-wider">
                                    Parameters
                                  </span>
                                  <div className="mt-0.5 space-y-0.5">
                                    {op.parameters.map((p, i) => (
                                      <div key={i} className="flex items-center gap-1.5 text-[11px]">
                                        <Badge variant="outline" className="text-[9px] h-3.5 px-1 font-mono">
                                          @{p.location}
                                        </Badge>
                                        <span className="font-mono text-foreground">{p.name}</span>
                                        <span className="text-muted-foreground/50">:</span>
                                        <span className="font-mono text-muted-foreground">{p.type}</span>
                                        {p.required && (
                                          <span className="text-[9px] text-warning">required</span>
                                        )}
                                      </div>
                                    ))}
                                  </div>
                                </div>
                              )}

                              {/* Responses */}
                              {op.responses.length > 0 && (
                                <div>
                                  <span className="text-[10px] text-muted-foreground/60 uppercase tracking-wider">
                                    Responses
                                  </span>
                                  <div className="mt-0.5 space-y-0.5">
                                    {op.responses.map((r, i) => (
                                      <div key={i} className="flex items-center gap-1.5 text-[11px]">
                                        <Badge variant="outline" className="text-[9px] h-3.5 px-1 font-mono">
                                          {r.statusCode}
                                        </Badge>
                                        {r.type && (
                                          <span className="font-mono text-muted-foreground">{r.type}</span>
                                        )}
                                        {r.description && (
                                          <span className="text-muted-foreground/60">{r.description}</span>
                                        )}
                                      </div>
                                    ))}
                                  </div>
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </div>
        );
            })
          )}
        </div>
      ))}
    </div>
  );
}
