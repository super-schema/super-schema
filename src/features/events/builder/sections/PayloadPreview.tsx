"use client";

// src/features/events/builder/sections/PayloadPreview.tsx
// Under the payload picker: the fields of the entity the message carries (name, type, a mark on the required ones) and a link to the
// entity, so choosing a payload is not choosing a name blind. Presentational: the schema (rendered by the server with the TypeSpec compiler,
// which takes seconds) is asked for by the message form, which shares one request between this preview and the Examples pane. No schema, or
// a schema without fields, says so in one line.
import Link from "next/link";
import { ExternalLink } from "lucide-react";
import type { EntityOption } from "@/features/events/shared/EntityPinPicker";
import { summarizeSchemaFields } from "./schema-fields";

/** `schema` is null while loading, when it could not be loaded, and when the message has no payload entity (`hasPayload` false: nothing shows). */
export function PayloadPreview({ schema, loading, entity, hasPayload }: {
  schema: Record<string, unknown> | null; loading: boolean; entity: EntityOption | undefined; hasPayload: boolean;
}) {
  if (!hasPayload) return null;
  const { rows, more } = summarizeSchemaFields(schema);
  return (
    <div data-testid="payload-preview" className="space-y-space-2 rounded-lg border border-border bg-muted/30 p-space-3">
      <div className="flex items-center justify-between gap-space-2">
        <p className="text-caption text-muted-foreground">{entity ? `Fields of ${entity.name}` : "Fields"}</p>
        {entity?.href && (
          <Link href={entity.href} className="inline-flex items-center gap-1 text-caption text-primary hover:underline">
            Open entity <ExternalLink aria-hidden="true" className="size-3" />
          </Link>
        )}
      </div>
      {loading ? (
        <p className="text-caption text-muted-foreground">Loading fields…</p>
      ) : rows.length === 0 ? (
        <p className="text-caption text-muted-foreground">No field preview</p>
      ) : (
        <ul className="grid gap-x-space-4 gap-y-space-1 text-body-small sm:grid-cols-2">
          {rows.map((row) => (
            <li key={row.name} className="flex min-w-0 items-baseline gap-space-2">
              <span className="truncate font-medium text-foreground">{row.name}</span>
              <span className="truncate text-caption text-muted-foreground">{row.type}</span>
              {row.required && (
                <span data-testid={`payload-preview-required-${row.name}`} title="Required" className="text-caption text-destructive">
                  <span aria-hidden="true">*</span>
                  <span className="sr-only">required</span>
                </span>
              )}
            </li>
          ))}
          {more > 0 && <li className="text-caption text-muted-foreground">{`+${more} more`}</li>}
        </ul>
      )}
    </div>
  );
}
