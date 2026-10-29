"use client";

// src/features/events/workspace/EventsList.tsx
// The product's Events tab (spec §3): ONE flat list of its events, replacing the Event Specs / Messages / Channels sections.
// The rows come from `loadEventsList` (valid v2 documents only); the list never reads a document itself.
import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Plus, Radio } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { EventListItem } from "@/features/events/event-page/load-events-list";
import { assetHref } from "@/lib/navigation/asset-href";
import { NewEventDialog } from "./NewEventDialog";

/** "asyncapi@3.0" → "AsyncAPI 3.0"; a spec type this build has no label for is shown as stored. */
function specLabel(specType: string): string {
  const match = /^asyncapi@(.+)$/.exec(specType);
  return match ? `AsyncAPI ${match[1]}` : specType;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Only the first topic is shown (most events have one channel); the rest collapse into "+N". */
function Topic({ item }: { item: EventListItem }) {
  const [first, ...rest] = item.topics;
  if (!first) return <span className="text-caption text-muted-foreground">No topic</span>;
  return (
    <span data-testid={`event-row-${item.id}-topic`} className="flex min-w-0 items-center gap-space-1 text-caption">
      <Badge variant="outline" className="shrink-0">{first.protocol}</Badge>
      <code className="truncate font-mono text-foreground" title={first.address}>{first.address}</code>
      {rest.length > 0 && <span className="shrink-0 text-muted-foreground">+{rest.length}</span>}
    </span>
  );
}

function Payloads({ item }: { item: EventListItem }) {
  if (item.payloads.length === 0) return <span className="text-caption text-muted-foreground">No payload</span>;
  return (
    <span data-testid={`event-row-${item.id}-payloads`} className="flex min-w-0 flex-wrap items-center gap-x-space-2 text-caption">
      {item.payloads.map((p) => (
        <Link key={p.href} href={p.href} className="font-mono text-primary hover:underline">{p.name}</Link>
      ))}
    </span>
  );
}

function Badges({ item }: { item: EventListItem }) {
  return (
    <span className="flex shrink-0 items-center gap-space-1">
      <Badge variant="secondary" data-testid={`event-row-${item.id}-spec`}>{specLabel(item.specType)}</Badge>
      <Badge variant="outline" data-testid={`event-row-${item.id}-version`}>{item.versionLabel ? `v${item.versionLabel}` : "Unpublished"}</Badge>
      {item.hasUnpublishedChanges && <Badge variant="warning" data-testid={`event-row-${item.id}-draft`}>Draft</Badge>}
    </span>
  );
}

/**
 * `onCreate` lets the host own the New Event dialog (the workspace opens one dialog for the header menu and this list alike). Without
 * it the list is self-sufficient: it opens its own dialog and opens the created event.
 */
export function EventsList({ productId, domainSlug, productSlug, items, viewMode = "tile", onCreate }: {
  productId: string;
  domainSlug: string;
  productSlug: string;
  items: EventListItem[];
  viewMode?: "tile" | "list";
  onCreate?: () => void;
}) {
  const router = useRouter();
  const [dialogOpen, setDialogOpen] = useState(false);
  const create = onCreate ?? (() => setDialogOpen(true));

  return (
    <div className="space-y-space-4" data-testid="events-tab">
      {items.length === 0 ? (
        <div data-testid="events-empty" className="flex flex-col items-center justify-center py-16 text-center">
          <Radio className="mb-space-3 h-8 w-8 text-muted-foreground" aria-hidden="true" />
          <h2 className="mb-space-2 text-heading-1 text-foreground">No events yet</h2>
          <p className="mb-space-6 max-w-md text-body text-muted-foreground">
            An event is the AsyncAPI document of what this product sends and receives: its servers, channels, messages and operations.
          </p>
          <Button onClick={create} className="gap-1.5" data-testid="events-empty-create">
            <Plus className="h-4 w-4" aria-hidden="true" /> New Event
          </Button>
        </div>
      ) : (
        <>
          <div className="flex items-center justify-between gap-space-2">
            <p className="text-body-small text-muted-foreground">{plural(items.length, "event", "events")}</p>
            <Button size="sm" variant="outline" className="gap-1.5" onClick={create} data-testid="events-new">
              <Plus className="h-4 w-4" aria-hidden="true" /> New Event
            </Button>
          </div>
          {viewMode === "tile" ? (
            <ul aria-label="Events" className="grid grid-cols-1 gap-space-4 md:grid-cols-2 xl:grid-cols-3">
              {items.map((item) => (
                <li key={item.id} data-testid={`event-row-${item.id}`} className="surface-glass flex flex-col gap-space-3 rounded-xl border border-border p-space-4 transition-colors hover:bg-accent/30">
                  <div className="flex items-start justify-between gap-space-2">
                    <Link href={item.href} className="min-w-0 truncate text-heading-2 font-medium text-foreground hover:text-primary hover:underline">{item.name}</Link>
                    <Badges item={item} />
                  </div>
                  <p data-testid={`event-row-${item.id}-description`} className="line-clamp-2 min-h-[2.5em] text-body-small text-muted-foreground">{item.description || "No description"}</p>
                  <div className="space-y-space-1 border-t border-border/60 pt-space-3">
                    <Topic item={item} />
                    <Payloads item={item} />
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <ul aria-label="Events" className="divide-y divide-border/60 overflow-hidden rounded-xl border border-border/60">
              {items.map((item) => (
                <li key={item.id} data-testid={`event-row-${item.id}`} className="grid grid-cols-[minmax(0,1.2fr)_minmax(0,2fr)_minmax(0,1.5fr)_minmax(0,1fr)_auto] items-center gap-x-space-4 px-space-4 py-space-3 transition-colors hover:bg-accent/30">
                  <Link href={item.href} className="truncate font-medium text-foreground hover:text-primary hover:underline">{item.name}</Link>
                  <span data-testid={`event-row-${item.id}-description`} className="truncate text-body-small text-muted-foreground">{item.description}</span>
                  <Topic item={item} />
                  <Payloads item={item} />
                  <Badges item={item} />
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      {!onCreate && (
        <NewEventDialog
          productId={productId} open={dialogOpen} onOpenChange={setDialogOpen}
          onCreated={(id) => router.push(assetHref({ kind: "event", id, domainSlug, productSlug }))}
        />
      )}
    </div>
  );
}
