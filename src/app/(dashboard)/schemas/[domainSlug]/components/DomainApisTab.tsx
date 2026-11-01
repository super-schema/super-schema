"use client";

import { useEffect, useState, useTransition } from "react";
import { ChevronDown, ChevronRight, Plus, Trash2 } from "lucide-react";
import { ApiIcon } from "@/components/icons/feature-icons";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import Link from "next/link";
import type { ScopeTarget } from "@/lib/asset-scope";
import { useInvalidateDomainsTree } from "@/hooks/useDomainsTree";
import {
  createServiceAction,
  deleteServiceAction,
  createOperationAction,
  deleteOperationAction,
} from "../actions";

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

/** Services owned by a broader level, shown read-only with a link to their source. */
export interface InheritedServices {
  label: string;
  href: string;
  services: ServiceData[];
}

/** What the parent asks the tab to open: the New Service form ("New API" in the header menu). */
export type DomainApiCreateIntent = "new";

interface DomainApisTabProps {
  domainId: string;
  /** Level new services are created at (domain page, product page, ...). */
  target: ScopeTarget;
  services: ServiceData[];
  entities: { id: string; name: string }[];
  inherited?: InheritedServices[];
  createIntent?: DomainApiCreateIntent | null;
  onCreateIntentConsumed?: () => void;
}

/** Name of the level a target creates at; labels the non-entity service group. */
function levelNoun(target: ScopeTarget): string {
  if (target.level === "PRODUCT") return "Product";
  if (target.level === "TENANT") return "Enterprise";
  return "Domain";
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

const METHODS = ["GET", "POST", "PUT", "DELETE", "PATCH"];

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function DomainApisTab({ domainId, target, services, entities, inherited, createIntent, onCreateIntentConsumed }: DomainApisTabProps) {
  const [expandedService, setExpandedService] = useState<string | null>(null);
  const [expandedOp, setExpandedOp] = useState<string | null>(null);
  const [isAddingService, setIsAddingService] = useState(false);
  const [addingOpFor, setAddingOpFor] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  // The explorer tree's APIs counts come from /api/domains-tree, not revalidatePath.
  const invalidateDomainsTree = useInvalidateDomainsTree();

  // "New API" in the header menu opens the same New Service form as this tab's own button.
  useEffect(() => {
    if (!createIntent) return;
    setIsAddingService(true);
    onCreateIntentConsumed?.();
  }, [createIntent, onCreateIntentConsumed]);

  // New service form state
  const [newServiceName, setNewServiceName] = useState("");
  const [newServiceScope, setNewServiceScope] = useState<"DOMAIN" | "ENTITY">("DOMAIN");
  const [newServiceEntityId, setNewServiceEntityId] = useState(entities[0]?.id ?? "");
  const [newServiceBasePath, setNewServiceBasePath] = useState("/");

  // New operation form state
  const [newOpName, setNewOpName] = useState("");
  const [newOpMethod, setNewOpMethod] = useState("GET");
  const [newOpPath, setNewOpPath] = useState("/");

  function submitNewService() {
    if (!newServiceName.trim()) return;
    startTransition(async () => {
      const result = await createServiceAction(
        domainId,
        {
          name: newServiceName.trim(),
          basePath: newServiceBasePath || "/",
          scope: newServiceScope,
          entityId: newServiceScope === "ENTITY" ? newServiceEntityId : undefined,
        },
        target
      );
      if ("error" in result) {
        toast.error(result.error);
        return;
      }
      void invalidateDomainsTree();
      setIsAddingService(false);
      setNewServiceName("");
      setNewServiceBasePath("/");
    });
  }

  function removeService(serviceId: string) {
    startTransition(async () => {
      const result = await deleteServiceAction(serviceId);
      if ("error" in result) toast.error(result.error);
      else void invalidateDomainsTree();
    });
  }

  function submitNewOperation(serviceId: string) {
    if (!newOpName.trim()) return;
    startTransition(async () => {
      const result = await createOperationAction(serviceId, {
        name: newOpName.trim(),
        httpMethod: newOpMethod,
        httpPath: newOpPath || "/",
      });
      if ("error" in result) {
        toast.error(result.error);
        return;
      }
      void invalidateDomainsTree();
      setAddingOpFor(null);
      setNewOpName("");
      setNewOpMethod("GET");
      setNewOpPath("/");
    });
  }

  function removeOperation(operationId: string) {
    startTransition(async () => {
      const result = await deleteOperationAction(operationId);
      if ("error" in result) toast.error(result.error);
      else void invalidateDomainsTree();
    });
  }

  const totalOps = services.reduce((sum, s) => sum + s.operations.length, 0);
  const entityServices = services.filter((service) => service.scope === "ENTITY");
  const domainServices = services.filter((service) => service.scope !== "ENTITY");
  // Entity-scoped APIs belong to an entity's product. Where no entities are
  // offered (the domain page) they can neither be created nor listed here.
  const canScopeToEntity = entities.length > 0;
  const noun = levelNoun(target);
  // A group with nothing in it carries no information — hide it.
  const inheritedGroups = (inherited ?? []).filter((g) => g.services.length > 0);
  const serviceGroups = [
    { title: `${noun} APIs`, services: domainServices },
    ...(canScopeToEntity || entityServices.length > 0
      ? [{ title: "Entity APIs", services: entityServices }]
      : []),
  ];

  return (
    <div className="space-y-space-3" data-testid="domain-apis-tab">
      {/* Summary + create */}
      <div className="flex items-center justify-between">
        <span className="text-caption text-muted-foreground">
          {services.length} service{services.length !== 1 ? "s" : ""} with {totalOps} operation{totalOps !== 1 ? "s" : ""}
        </span>
        <Button size="sm" className="gap-1.5" onClick={() => setIsAddingService(true)} disabled={isAddingService}>
          <Plus className="w-3.5 h-3.5" />
          New Service
        </Button>
      </div>

      {isAddingService && (
        <div className="rounded-lg border border-primary/30 bg-primary/5 p-space-4 space-y-space-3">
          <h3 className="text-body-small font-semibold text-foreground">New API Service</h3>
          <div className={canScopeToEntity ? "grid grid-cols-2 gap-space-2" : "grid grid-cols-1 gap-space-2"}>
            <Input
              value={newServiceName}
              onChange={(e) => setNewServiceName(e.target.value)}
              placeholder="Service name"
              className="h-8"
              autoFocus
            />
            {canScopeToEntity && (
              <select
                value={newServiceScope}
                onChange={(e) => setNewServiceScope(e.target.value as "DOMAIN" | "ENTITY")}
                className="h-8 rounded-lg border border-border bg-popover px-2 text-body-small text-foreground"
              >
                <option value="DOMAIN">{`${noun}-scoped`}</option>
                <option value="ENTITY">Entity-scoped</option>
              </select>
            )}
          </div>
          {newServiceScope === "ENTITY" && (
            <select
              value={newServiceEntityId}
              onChange={(e) => setNewServiceEntityId(e.target.value)}
              className="h-8 w-full rounded-lg border border-border bg-popover px-2 text-body-small text-foreground"
            >
              {entities.map((e) => (
                <option key={e.id} value={e.id}>{e.name}</option>
              ))}
            </select>
          )}
          <Input
            value={newServiceBasePath}
            onChange={(e) => setNewServiceBasePath(e.target.value)}
            placeholder="/base-path"
            className="h-8 font-mono"
          />
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setIsAddingService(false)}>Cancel</Button>
            <Button size="sm" onClick={submitNewService} disabled={!newServiceName.trim() || isPending}>
              Create Service
            </Button>
          </div>
        </div>
      )}

      {services.length === 0 && !isAddingService ? (
        <div className="text-center py-16 text-muted-foreground">
          <ApiIcon className="w-8 h-8 mx-auto mb-2 text-muted-foreground/30" />
          <p className="text-body-small">No API services defined yet</p>
          <p className="text-caption mt-1">
            Import an OpenAPI or TypeSpec file, or create a service to get started.
          </p>
          <Button className="gap-1.5 mt-space-4" onClick={() => setIsAddingService(true)} data-testid="apis-empty-create">
            <Plus className="w-4 h-4" aria-hidden="true" />
            New API
          </Button>
        </div>
      ) : (
        serviceGroups.map(({ title, services: groupedServices }) => (
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
            <div className="flex items-center gap-space-2 w-full px-space-4 py-space-3 hover:bg-muted/30 transition-colors">
              <button
                onClick={() => setExpandedService(isExpanded ? null : service.id)}
                className="flex items-center gap-space-2 flex-1 min-w-0"
              >
                {isExpanded ? (
                  <ChevronDown className="w-3.5 h-3.5 text-muted-foreground" />
                ) : (
                  <ChevronRight className="w-3.5 h-3.5 text-muted-foreground" />
                )}
                <ApiIcon className="w-4 h-4 text-primary" />
                <span className="font-mono text-body-small text-foreground font-medium">
                  {service.name}
                </span>
                <Badge variant="outline" className="text-[10px] h-4 px-1.5 uppercase">
                  {service.scope === "ENTITY" ? "entity" : noun.toLowerCase()}
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
              <button
                onClick={() => removeService(service.id)}
                className="text-muted-foreground hover:text-destructive"
                title="Delete service"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>

            {/* Expanded: show operations */}
            {isExpanded && (
              <div className="border-t border-border/30">
                {service.description && (
                  <p className="text-caption text-muted-foreground px-space-4 py-space-2 border-b border-border/20">
                    {service.description}
                  </p>
                )}

                <div className="flex justify-end px-space-4 py-space-2 border-b border-border/20">
                  <button
                    onClick={() => setAddingOpFor(addingOpFor === service.id ? null : service.id)}
                    className="text-[11px] text-primary hover:underline flex items-center gap-1"
                  >
                    <Plus className="w-3 h-3" /> Add Operation
                  </button>
                </div>

                {addingOpFor === service.id && (
                  <div className="px-space-4 py-space-2 border-b border-border/20 flex items-center gap-2">
                    <select
                      value={newOpMethod}
                      onChange={(e) => setNewOpMethod(e.target.value)}
                      className="h-7 rounded border border-border bg-popover px-1 text-[11px] font-mono"
                    >
                      {METHODS.map((m) => <option key={m} value={m}>{m}</option>)}
                    </select>
                    <Input
                      value={newOpPath}
                      onChange={(e) => setNewOpPath(e.target.value)}
                      placeholder="/path"
                      className="h-7 font-mono text-[11px] flex-1"
                    />
                    <Input
                      value={newOpName}
                      onChange={(e) => setNewOpName(e.target.value)}
                      placeholder="operationName"
                      className="h-7 font-mono text-[11px] flex-1"
                    />
                    <Button size="sm" className="h-7" onClick={() => submitNewOperation(service.id)} disabled={!newOpName.trim() || isPending}>
                      Add
                    </Button>
                  </div>
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
                          <div className="flex items-center gap-2 w-full px-space-4 py-space-2 hover:bg-muted/20 transition-colors">
                            <button
                              onClick={() => setExpandedOp(isOpExpanded ? null : op.id)}
                              className="flex items-center gap-2 flex-1 min-w-0"
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
                            <button
                              onClick={() => removeOperation(op.id)}
                              className="text-muted-foreground hover:text-destructive"
                              title="Delete operation"
                            >
                              <Trash2 className="w-3 h-3" />
                            </button>
                          </div>

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
        ))
      )}

      {inheritedGroups.map((group) => (
        <InheritedServicesSection key={group.label} group={group} />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Read-only services inherited from a broader level
// ---------------------------------------------------------------------------

function InheritedServicesSection({ group }: { group: InheritedServices }) {
  return (
    <section
      className="mt-space-6 border-t border-border/50 pt-space-4 space-y-space-2"
      data-testid="inherited-services"
    >
      <div className="flex items-center gap-space-2">
        <h3 className="text-body-small font-semibold text-foreground">
          <Link href={group.href} className="hover:text-primary hover:underline">
            {group.label}
          </Link>
        </h3>
        <Badge variant="outline" className="text-[10px] h-4 px-1.5">Read-only</Badge>
      </div>
      {group.services.map((service) => (
        <div key={service.id} className="rounded-lg border border-border/30 p-space-3">
          <div className="flex items-center gap-space-2 flex-wrap">
            <ApiIcon className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
            <span className="font-mono text-body-small text-foreground font-medium">{service.name}</span>
            {service.basePath !== "/" && (
              <span className="font-mono text-caption text-muted-foreground">{service.basePath}</span>
            )}
            <Badge variant="secondary" className="text-[10px] h-4 px-1.5 ml-auto">
              {service.operations.length} op{service.operations.length !== 1 ? "s" : ""}
            </Badge>
          </div>
          {service.description && <p className="text-caption text-muted-foreground mt-1">{service.description}</p>}
          {service.operations.length > 0 && (
            <div className="mt-space-2 space-y-0.5">
              {service.operations.map((op) => (
                <div key={op.id} className="flex items-center gap-2">
                  <Badge className={`text-[10px] h-4 font-mono font-bold border ${METHOD_COLORS[op.httpMethod] ?? METHOD_COLORS.GET}`}>
                    {op.httpMethod}
                  </Badge>
                  <span className="font-mono text-caption text-foreground">{op.httpPath}</span>
                  <span className="text-caption text-muted-foreground truncate">{op.name}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
    </section>
  );
}
