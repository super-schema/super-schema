"use client";

// src/features/events/builder/sections/ServersSection.tsx
// Servers: a list on the left, and on the right the AsyncAPI server object as a template form (host and protocol first, then
// everything else the spec defines under "More properties") plus protocol bindings. The key is generated: it starts as a placeholder
// and is named from the title or host once the user leaves the form; the "Identifier" below the form is the only place it shows.
import { useMemo } from "react";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { JsonObject } from "@/lib/event-specs/types";
import { renameKey } from "@/lib/events/document/keys";
import type { DocServer, EventDocument } from "@/lib/events/document/types";
import { TEMPLATES } from "@/lib/events/templates";
import { autoRenameKey, leftForm, newKey } from "../auto-key";
import type { SectionProps } from "../EventBuilder";
import { IdentifierDisclosure } from "../Identifier";
import { problemMessage, problemsByField, uniqueProblems } from "../problems";
import { buildReferenceContext } from "../references";
import { BindingsForm, TemplateForm } from "../template";

const DEFAULT_PROTOCOL = "kafka";

/** The properties of a server the template form does not draw: the identifier, infra-sync bookkeeping, and the bindings (their own form). */
const KEPT_KEYS = ["key", "origin", "externalRef", "bindings"] as const;

/** What a server is called in the list: its title, else its host. */
const listLabel = (s: DocServer) => s.title?.trim() || s.host?.trim() || "New server";

/** The server with the form's next value applied: protocol and host stay strings (empty while blank), the kept properties are untouched. */
function applyForm(current: DocServer, next: Record<string, unknown>): DocServer {
  const out: Record<string, unknown> = { ...next };
  const kept: Record<string, unknown> = { ...current };
  for (const k of KEPT_KEYS) {
    if (k in kept) out[k] = kept[k];
    else delete out[k];
  }
  if (typeof out.protocol !== "string") out.protocol = "";
  if (typeof out.host !== "string") out.host = "";
  return out as unknown as DocServer;
}

function withBindings(server: DocServer, bindings: Record<string, unknown>): DocServer {
  if (Object.keys(bindings).length === 0) {
    const copy = { ...server };
    delete copy.bindings;
    return copy;
  }
  return { ...server, bindings: bindings as JsonObject };
}

export function ServersSection({ draft, options, selectedItem, onSelectItem }: SectionProps) {
  const { doc, update } = draft;
  const servers = doc.servers;
  // The client parse and a failed save usually report the same problems: show each once.
  const problems = uniqueProblems(draft.problems.concat(draft.serverProblems));
  const context = useMemo(() => buildReferenceContext(doc, { entityOptions: options.entityOptions }), [doc, options.entityOptions]);

  const selected = selectedItem === null ? -1 : servers.findIndex((s) => s.key === selectedItem);
  const activeIndex = selected >= 0 ? selected : servers.length > 0 ? 0 : -1;
  const active = activeIndex >= 0 ? servers[activeIndex] : null;
  const errorAt = (suffix: string) => problemMessage(problemsByField(problems, `/servers/${activeIndex}${suffix}`));

  function patchActive(change: (s: DocServer) => DocServer) {
    update((d) => ({ ...d, servers: d.servers.map((s, i) => (i === activeIndex ? change(s) : s)) }));
  }

  function addServer() {
    // A blank server, like before: the protocol has a default, the host is the user's to fill. Saving is never blocked by it.
    const key = newKey(doc, "server");
    update((d) => ({ ...d, servers: [...d.servers, { key, protocol: DEFAULT_PROTOCOL, host: "" }] }));
    onSelectItem(key);
  }

  /** Once the user leaves the form: a placeholder key becomes a name from the title or host. Later edits never rename it again. */
  function nameKeyFromContent() {
    if (!active) return;
    const from = active.key;
    const values = (d: EventDocument) => {
      const s = d.servers.find((x) => x.key === from);
      return { title: s?.title, host: s?.host };
    };
    const preview = autoRenameKey(doc, "server", from, values(doc));
    if (preview === doc) return;
    update((d) => autoRenameKey(d, "server", from, values(d)));
    onSelectItem(preview.servers[activeIndex].key);
  }

  function renameActive(to: string) {
    if (!active) return;
    const from = active.key;
    if (!renameKey(doc, "server", from, to).success) return;
    update((d) => {
      const renamed = renameKey(d, "server", from, to);
      return renamed.success ? renamed.data : d;
    });
    onSelectItem(to);
  }

  function removeActive() {
    if (!active) return;
    const key = active.key;
    const users = doc.channels.filter((c) => c.serverKeys.includes(key));
    if (users.length > 0) {
      const names = users.map((c) => c.key).join(", ");
      const ok = window.confirm(
        `Server "${key}" is used by ${users.length} channel${users.length === 1 ? "" : "s"} (${names}). Remove it and unlink it from ${users.length === 1 ? "that channel" : "those channels"}?`,
      );
      if (!ok) return;
    }
    update((d) => {
      const stillDefined = d.servers.some((s, i) => i !== activeIndex && s.key === key);
      return {
        ...d,
        servers: d.servers.filter((_, i) => i !== activeIndex),
        channels: stillDefined ? d.channels : d.channels.map((c) => (c.serverKeys.includes(key) ? { ...c, serverKeys: c.serverKeys.filter((k) => k !== key) } : c)),
      };
    });
    onSelectItem(null);
  }

  return (
    <section aria-labelledby="servers-heading" data-testid="section-servers" className="space-y-space-6">
      <header className="flex items-start justify-between gap-space-4">
        <div className="space-y-space-1">
          <h2 id="servers-heading" className="text-heading-3 text-foreground">Servers</h2>
          <p className="text-body-small text-muted-foreground">Where the brokers run. Channels pick the servers they are available on.</p>
        </div>
        {servers.length > 0 && (
          <Button type="button" size="sm" variant="outline" onClick={addServer} data-testid="server-add" className="gap-1.5">
            <Plus className="size-4" /> Add server
          </Button>
        )}
      </header>

      {!active ? (
        <div data-testid="server-empty" className="space-y-space-3 rounded-lg border border-dashed border-border p-space-6 text-center">
          <p className="text-heading-3 text-foreground">No servers yet</p>
          <p className="text-body-small text-muted-foreground">Servers are optional: a channel can be added without one.</p>
          <Button type="button" onClick={addServer} data-testid="server-empty-add" className="gap-1.5"><Plus className="size-4" /> Add server</Button>
        </div>
      ) : (
        <div className="grid gap-space-6 @2xl:grid-cols-[14rem_1fr]">
          <ul aria-label="Servers" className="space-y-space-1">
            {servers.map((s, i) => {
              const isActive = i === activeIndex;
              const broken = problemsByField(problems, `/servers/${i}`).length > 0;
              return (
                <li key={`${i}-${s.key}`}>
                  <button
                    type="button" data-testid={`server-row-${s.key}`} aria-current={isActive ? "true" : undefined}
                    onClick={() => onSelectItem(s.key)}
                    className={cn(
                      "flex w-full items-center justify-between gap-space-2 rounded-lg px-space-3 py-space-2 text-left outline-none transition-colors focus-visible:ring-3 focus-visible:ring-ring/50",
                      isActive ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
                    )}
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-body-small font-medium">{listLabel(s)}</span>
                      <span className="block truncate text-caption text-muted-foreground">{s.protocol}</span>
                    </span>
                    {broken && (
                      <>
                        <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-destructive" />
                        <span className="sr-only">has problems</span>
                      </>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>

          <div key={activeIndex} className="max-w-2xl space-y-space-4" data-testid="server-form">
            <div onBlur={(e) => { if (leftForm(e)) nameKeyFromContent(); }} className="space-y-space-4">
              <TemplateForm
                template={TEMPLATES.server} value={{ ...active }} idPrefix="server" errors={problems} errorPrefix={`/servers/${activeIndex}`}
                context={context} hideKeys={[...KEPT_KEYS]}
                onChange={(next) => patchActive((s) => applyForm(s, next))}
              />
              <BindingsForm
                target="server" suggestedProtocol={active.protocol} value={active.bindings ?? {}} idPrefix="server-bindings"
                errors={problems} errorPrefix={`/servers/${activeIndex}/bindings`}
                onChange={(next) => patchActive((s) => withBindings(s, next))}
              />
            </div>
            <IdentifierDisclosure
              id="server-key" value={active.key} error={errorAt("/key")}
              taken={servers.filter((_, i) => i !== activeIndex).map((s) => s.key)} onRename={renameActive}
            />
            <div className="flex justify-end">
              <Button type="button" variant="outline" onClick={removeActive} data-testid="server-remove" className="gap-1.5 text-muted-foreground hover:text-destructive">
                <Trash2 className="size-4" /> Remove server
              </Button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
