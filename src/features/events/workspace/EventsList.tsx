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

function countsLabel(item: EventListItem): string {
  return [plural(item.channels, "channel", "channels"), plural(item.messages, "message", "messages"), plural(item.operations, "operation", "operations")].join(" · ");
}

/**
 * `onCreate` lets the host own the New Event dialog (the workspace opens one dialog for the header menu and this list alike). Without
 * it the list is self-sufficient: it opens its own dialog and opens the created event.
 */
export function EventsList({ productId, domainSlug, productSlug, items, onCreate }: {
  productId: string;
  domainSlug: string;
  productSlug: string;
  items: EventListItem[];
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
          <ul aria-label="Events" className="divide-y divide-border/60 overflow-hidden rounded-xl border border-border/60">
            {items.map((item) => (
              <li key={item.id} data-testid={`event-row-${item.id}`} className="flex flex-wrap items-center gap-x-space-4 gap-y-space-1 px-space-4 py-space-3 transition-colors hover:bg-accent/30">
                <Link href={item.href} className="min-w-0 truncate font-medium text-foreground hover:text-primary hover:underline">{item.name}</Link>
                <span className="flex shrink-0 items-center gap-space-1">
                  <Badge variant="secondary" data-testid={`event-row-${item.id}-spec`}>{specLabel(item.specType)}</Badge>
                  <Badge variant="outline" data-testid={`event-row-${item.id}-version`}>{item.versionLabel ? `v${item.versionLabel}` : "Unpublished"}</Badge>
                  {item.hasUnpublishedChanges && <Badge variant="warning" data-testid={`event-row-${item.id}-draft`}>Draft</Badge>}
                </span>
                <span data-testid={`event-row-${item.id}-counts`} className="ml-auto text-caption text-muted-foreground">{countsLabel(item)}</span>
              </li>
            ))}
          </ul>
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
