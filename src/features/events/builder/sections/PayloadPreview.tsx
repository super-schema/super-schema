"use client";

import Link from "next/link";
import { ChevronRight, ExternalLink } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import type { EntityOption } from "@/features/events/shared/EntityPinPicker";
import { summarizeSchemaFields } from "./schema-fields";

/** A compact field list; each row expands to show its complete description and schema attributes. */
export function PayloadPreview({ schema, loading, entity, hasPayload }: {
  schema: Record<string, unknown> | null; loading: boolean; entity: EntityOption | undefined; hasPayload: boolean;
}) {
  if (!hasPayload) return null;
  const { rows } = summarizeSchemaFields(schema, Infinity);
  return (
    <details open data-testid="payload-preview" className="group/preview min-w-0 rounded-lg border border-border bg-muted/30 p-space-3">
      <summary className="flex cursor-pointer list-none items-center gap-space-2 rounded-md outline-none focus-visible:ring-3 focus-visible:ring-ring/50 [&::-webkit-details-marker]:hidden">
        <ChevronRight aria-hidden="true" className="size-3.5 shrink-0 transition-transform group-open/preview:rotate-90" />
        <span className="min-w-0 truncate text-caption text-muted-foreground">{entity ? `Fields of ${entity.name}` : "Fields"}</span>
        {!loading && rows.length > 0 && <span className="text-caption text-muted-foreground">({rows.length})</span>}
      </summary>
      <div className="mt-space-2 flex min-w-0 flex-col gap-space-2">
        {entity?.href && (
          <Link href={entity.href} className="inline-flex items-center gap-1 self-end text-caption text-primary hover:underline">
            Open entity <ExternalLink aria-hidden="true" className="size-3" />
          </Link>
        )}
        {loading ? (
          <p className="text-caption text-muted-foreground">Loading fields…</p>
        ) : rows.length === 0 ? (
          <p className="text-caption text-muted-foreground">No field preview</p>
        ) : (
          <ul className="flex min-w-0 flex-col divide-y divide-border text-body-small">
            {rows.map((row) => (
              <li key={row.name} className="min-w-0">
                <details className="group/field min-w-0" data-testid={`payload-preview-field-${row.name}`}>
                  <summary className="flex min-w-0 cursor-pointer list-none items-center gap-space-2 rounded-md py-space-2 outline-none focus-visible:ring-3 focus-visible:ring-ring/50 [&::-webkit-details-marker]:hidden">
                    <ChevronRight aria-hidden="true" className="size-3 shrink-0 text-muted-foreground transition-transform group-open/field:rotate-90" />
                    <span className="max-w-[35%] truncate font-medium text-foreground" title={row.name}>{row.name}</span>
                    {row.required && (
                      <span data-testid={`payload-preview-required-${row.name}`} title="Required" className="shrink-0 text-caption text-destructive">
                        <span aria-hidden="true">*</span><span className="sr-only">required</span>
                      </span>
                    )}
                    <span className="max-w-[30%] truncate text-caption text-muted-foreground" title={row.type}>{row.type}</span>
                    {row.description && <span className="min-w-0 flex-1 truncate text-caption text-muted-foreground" title={row.description}>{row.description}</span>}
                    {row.attributes?.map((attribute) => (
                      <Badge key={attribute.name} variant="secondary" className="min-w-0 max-w-[25%] shrink" title={`${attribute.name}: ${attribute.value}`}>
                        <span className="truncate">{attribute.name}: {attribute.value}</span>
                      </Badge>
                    ))}
                  </summary>
                  <dl className="mb-space-3 ml-space-5 grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-space-3 gap-y-space-1 text-caption">
                    <dt className="text-muted-foreground">Field</dt><dd className="break-words text-foreground">{row.name}</dd>
                    <dt className="text-muted-foreground">Type</dt><dd className="break-words text-foreground">{row.type}{row.required ? " (required)" : " (optional)"}</dd>
                    {row.description && <><dt className="text-muted-foreground">Description</dt><dd className="whitespace-pre-wrap break-words text-foreground">{row.description}</dd></>}
                    {row.attributes?.map((attribute) => (
                      <div key={attribute.name} className="contents"><dt className="text-muted-foreground">{attribute.name}</dt><dd className="whitespace-pre-wrap break-words text-foreground">{attribute.value}</dd></div>
                    ))}
                  </dl>
                </details>
              </li>
            ))}
          </ul>
        )}
      </div>
    </details>
  );
}
