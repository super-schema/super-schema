"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Plus } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { createTraitAction } from "@/app/(dashboard)/schemas/trait-actions";
import { useInvalidateDomainsTree } from "@/hooks/useDomainsTree";
import type { ScopeTarget } from "@/lib/asset-scope";
import type { Linked, TraitKind, TraitListItem } from "@/lib/events/types";
import { assetHref } from "@/lib/navigation/asset-href";
import { Field, FormShell, selectClass, useCreateForm } from "./create-form";
import type { TraitsTabData } from "./types";

function TraitCards({ traits }: { traits: Linked<TraitListItem>[] }) {
  return (
    <ul className="grid grid-cols-1 gap-space-3 md:grid-cols-2 xl:grid-cols-3">
      {traits.map((t) => (
        <li key={t.id}>
          <Link href={t.href} className="block rounded-lg border border-border/60 p-space-4 transition-colors hover:border-primary/40">
            <div className="flex items-center justify-between gap-space-2">
              <span className="truncate font-medium text-foreground">{t.name}</span>
              <Badge variant="secondary">{t.kind === "MESSAGE" ? "message" : "operation"}</Badge>
            </div>
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
  const form = useCreateForm(onCreated);
  return (
    <FormShell title="New Trait" testId="new-trait-form" error={form.error} busy={form.busy} onCancel={onCancel}
      onSubmit={() => form.run(() => createTraitAction(target, { name, kind }))}>
      <div className="grid grid-cols-1 gap-space-3 md:grid-cols-2">
        <Field label="Name" htmlFor="new-trait-name">
          <Input id="new-trait-name" aria-label="Trait name" value={name} onChange={(e) => setName(e.target.value)} placeholder="CloudEvents" required />
        </Field>
        <Field label="Kind" htmlFor="new-trait-kind">
          <select id="new-trait-kind" aria-label="Kind" className={selectClass} value={kind} onChange={(e) => setKind(e.target.value as TraitKind)}>
            <option value="MESSAGE">Message trait</option>
            <option value="OPERATION">Operation trait</option>
          </select>
        </Field>
      </div>
    </FormShell>
  );
}

export function TraitsTab({
  target, domainSlug, data, createIntent, onCreateIntentConsumed,
}: {
  /** Level the new trait is created at (the level the tab is shown on: the Enterprise or a domain). */
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
        <p className="text-body-small text-muted-foreground">Reusable AsyncAPI message traits (e.g. CloudEvents headers) and operation traits.</p>
        <Button size="sm" variant="outline" className="shrink-0 gap-1.5" onClick={() => setOpen(true)} data-testid="traits-new">
          <Plus className="w-4 h-4" /> New Trait
        </Button>
      </div>

      {open && <NewTraitForm target={target} onCancel={() => setOpen(false)} onCreated={created} />}

      {data.own.length > 0 ? (
        <TraitCards traits={data.own} />
      ) : (
        <p className="text-body-small text-muted-foreground" data-testid="traits-empty">No traits at this level yet.</p>
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
