"use client";

// src/features/events/workspace/TraitsTab.tsx
// The Enterprise / Domain tab that lists the library's message properties ("Trait" in brackets for the technical name). A card shows the name,
// what it applies to (Message / Operation), a lock for the built-in ones (CloudEvents, W3C Trace Context), how many properties it brings and its
// summary. "New Message Properties" asks for a name, what it applies to and an optional description; the properties are edited on the page that
// opens after creating it. The tab id and URL value stay `traits`; test ids stay `trait*`.
import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Lock, Plus } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { createTraitAction } from "@/app/(dashboard)/schemas/trait-actions";
import { useInvalidateDomainsTree } from "@/hooks/useDomainsTree";
import type { ScopeTarget } from "@/lib/asset-scope";
import type { TraitKind } from "@/lib/events/types";
import { assetHref } from "@/lib/navigation/asset-href";
import { BUILT_IN_BADGE, NEW_PROPERTIES_MENU, propertyCountText, PROPERTIES_PAGE_SUBTITLE } from "@/features/events/builder/labels";
import { Field, FormShell, selectClass, useCreateForm } from "./create-form";
import type { TraitsTabData, TraitTabItem } from "./types";

function TraitCards({ traits }: { traits: TraitTabItem[] }) {
  return (
    <ul className="grid grid-cols-1 gap-space-3 md:grid-cols-2 xl:grid-cols-3">
      {traits.map((t) => (
        <li key={t.id}>
          <Link href={t.href} data-testid={`trait-card-${t.id}`} className="block rounded-lg border border-border/60 p-space-4 transition-colors hover:border-primary/40">
            <div className="flex items-center justify-between gap-space-2">
              <span className="truncate font-medium text-foreground">{t.name}</span>
              <span className="flex shrink-0 items-center gap-space-1">
                {t.bundled && (
                  <Badge variant="secondary" className="gap-1" data-testid={`trait-card-${t.id}-builtin`}><Lock aria-hidden="true" />{BUILT_IN_BADGE}</Badge>
                )}
                <Badge variant="outline">{t.kind === "MESSAGE" ? "Message" : "Operation"}</Badge>
              </span>
            </div>
            {t.propertyCount !== undefined && t.propertyCount > 0 && (
              <p data-testid={`trait-card-${t.id}-count`} className="mt-space-1 text-caption text-muted-foreground">{propertyCountText(t.propertyCount)}</p>
            )}
            {t.summary && <p className="mt-space-1 text-caption text-muted-foreground">{t.summary}</p>}
          </Link>
        </li>
      ))}
    </ul>
  );
}

function NewTraitForm({ target, onCancel, onCreated }: { target: ScopeTarget; onCancel: () => void; onCreated: (id: string) => void }) {
  const [name, setName] = useState("");
  const [kind, setKind] = useState<TraitKind>("MESSAGE");
  const [description, setDescription] = useState("");
  const form = useCreateForm(onCreated);
  const text = description.trim();
  return (
    <FormShell title={NEW_PROPERTIES_MENU} testId="new-trait-form" error={form.error} busy={form.busy} onCancel={onCancel}
      onSubmit={() => form.run(() => createTraitAction(target, { name, kind, ...(text !== "" ? { spec: { description: text } } : {}) }))}>
      <div className="grid grid-cols-1 gap-space-3 md:grid-cols-2">
        <Field label="Name" htmlFor="new-trait-name">
          <Input id="new-trait-name" aria-label="Name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Audit headers" required />
        </Field>
        <Field label="Applies to" htmlFor="new-trait-kind">
          <select id="new-trait-kind" aria-label="Applies to" className={selectClass} value={kind} onChange={(e) => setKind(e.target.value as TraitKind)}>
            <option value="MESSAGE">Message</option>
            <option value="OPERATION">Operation</option>
          </select>
        </Field>
      </div>
      <Field label="Description (optional)" htmlFor="new-trait-description">
        <Input id="new-trait-description" aria-label="Description" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What these properties are for" />
      </Field>
      <p className="text-caption text-muted-foreground">You add the properties themselves on the next page.</p>
    </FormShell>
  );
}

export function TraitsTab({
  target, domainSlug, data, createIntent, onCreateIntentConsumed,
}: {
  /** Level the new set is created at (the level the tab is shown on: the Enterprise or a domain). */
  target: ScopeTarget;
  domainSlug: string | null;
  data: TraitsTabData;
  createIntent?: "trait" | null;
  onCreateIntentConsumed?: () => void;
}) {
  const router = useRouter();
  const invalidateDomainsTree = useInvalidateDomainsTree();
  const [open, setOpen] = useState(false);

  // A New-menu click on the workspace header opens the form (same idea as DomainTypesTab): it opens in the
  // render pass that first sees the intent, and the effect clears the intent so the menu item works again.
  const [seenIntent, setSeenIntent] = useState<"trait" | null>(null);
  if ((createIntent ?? null) !== seenIntent) {
    setSeenIntent(createIntent ?? null);
    if (createIntent) setOpen(true);
  }
  useEffect(() => {
    if (createIntent) onCreateIntentConsumed?.();
  }, [createIntent, onCreateIntentConsumed]);

  function created(id: string) {
    void invalidateDomainsTree();
    router.push(assetHref({ kind: "trait", id, domainSlug }));
  }

  return (
    <div className="space-y-space-6" data-testid="traits-tab">
      <div className="flex items-center justify-between gap-space-2">
        <p className="text-body-small text-muted-foreground">
          <span data-testid="traits-subtitle" className="font-medium text-foreground">{PROPERTIES_PAGE_SUBTITLE}</span>
          {" — reusable sets of properties for messages and operations, such as the CloudEvents attributes."}
        </p>
        <Button size="sm" variant="outline" className="shrink-0 gap-1.5" onClick={() => setOpen(true)} data-testid="traits-new">
          <Plus className="w-4 h-4" /> {NEW_PROPERTIES_MENU}
        </Button>
      </div>

      {open && <NewTraitForm target={target} onCancel={() => setOpen(false)} onCreated={created} />}

      {data.own.length > 0 ? (
        <TraitCards traits={data.own} />
      ) : (
        <p className="text-body-small text-muted-foreground" data-testid="traits-empty">No message properties at this level yet.</p>
      )}

      {data.inherited.map((group) => (
        <section key={group.label} className="space-y-space-2">
          <h3 className="text-heading-3 text-muted-foreground">
            <Link href={group.href} className="hover:text-foreground">{group.label}</Link>
          </h3>
          <TraitCards traits={group.traits} />
        </section>
      ))}
    </div>
  );
}
