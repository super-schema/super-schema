"use client";

// src/features/events/event-page/AsyncApiVisual.tsx
// A visual, read-only reading of a generated AsyncAPI 3 document: what the event sends and receives, on which channels, carrying which
// messages (payload and header fields as a tree), and the servers and security it declares. Only what the document sets is shown:
// an event without servers has no Servers section. Every item is collapsible; the flow summary at the top stays compact.
import type { ReactNode } from "react";
import { ArrowDownLeft, ArrowUpRight, ChevronRight } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);
const entries = (v: unknown): [string, Json][] => (isObj(v) ? Object.entries(v).filter((e): e is [string, Json] => isObj(e[1])) : []);

/** Follows local `$ref`s (`#/components/messages/x`) inside the document; an unresolvable ref stays as it is. */
function deref(doc: Json, value: unknown, seen = 0): unknown {
  if (!isObj(value) || typeof value.$ref !== "string" || !value.$ref.startsWith("#/") || seen > 16) return value;
  let node: unknown = doc;
  for (const part of value.$ref.slice(2).split("/")) node = isObj(node) ? node[part.replace(/~1/g, "/").replace(/~0/g, "~")] : undefined;
  return node === undefined ? value : deref(doc, node, seen + 1);
}
const refName = (value: unknown): string | undefined => (isObj(value) && typeof value.$ref === "string" ? value.$ref.split("/").pop() : undefined);

function Section({ id, title, count, children, defaultOpen = true }: { id: string; title: string; count: number; children: ReactNode; defaultOpen?: boolean }) {
  return (
    <details open={defaultOpen} data-testid={`visual-${id}`} className="group/section rounded-lg border border-border">
      <summary className="flex cursor-pointer list-none items-center gap-space-2 px-space-3 py-space-2 text-body-small font-medium text-foreground [&::-webkit-details-marker]:hidden">
        <ChevronRight aria-hidden="true" className="size-4 text-muted-foreground transition-transform group-open/section:rotate-90" />
        {title}
        <Badge variant="secondary" className="tabular-nums">{count}</Badge>
      </summary>
      <div className="space-y-space-2 border-t border-border px-space-3 py-space-2">{children}</div>
    </details>
  );
}

function Item({ id, title, meta, children }: { id: string; title: ReactNode; meta?: ReactNode; children?: ReactNode }) {
  if (!children) {
    return <div data-testid={id} className="flex flex-wrap items-center gap-space-2 py-0.5 text-body-small"><span className="font-medium text-foreground">{title}</span>{meta}</div>;
  }
  return (
    <details data-testid={id} className="group/item rounded-md border border-border/60">
      <summary className="flex cursor-pointer list-none flex-wrap items-center gap-space-2 px-space-2 py-1.5 text-body-small [&::-webkit-details-marker]:hidden">
        <ChevronRight aria-hidden="true" className="size-3.5 text-muted-foreground transition-transform group-open/item:rotate-90" />
        <span className="font-medium text-foreground">{title}</span>
        {meta}
      </summary>
      <div className="space-y-space-1 border-t border-border/60 px-space-3 py-space-2 text-body-small">{children}</div>
    </details>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[7rem_minmax(0,1fr)] gap-space-2">
      <span className="text-caption text-muted-foreground">{label}</span>
      <span className="min-w-0 break-words text-foreground">{children}</span>
    </div>
  );
}

const Mono = ({ children }: { children: ReactNode }) => <code className="break-all font-mono text-caption">{children}</code>;

/** Fields of a schema as a tree: JSON Schema `properties`, Avro record `fields`, or the schema's type / reference when it has neither. */
function SchemaTree({ doc, schema, depth = 0 }: { doc: Json; schema: unknown; depth?: number }) {
  const s = deref(doc, schema);
  // A multi-format payload (`{ schemaFormat, schema }`).
  if (isObj(s) && "schemaFormat" in s && "schema" in s) return <SchemaTree doc={doc} schema={s.schema} depth={depth} />;
  if (!isObj(s)) return <Mono>{typeof s === "string" ? s : JSON.stringify(s)}</Mono>;
  const rows: { name: string; type: string; required: boolean; child?: unknown; description?: string }[] = [];
  if (isObj(s.properties)) {
    const required = new Set(Array.isArray(s.required) ? s.required : []);
    for (const [name, raw] of Object.entries(s.properties)) {
      const p = deref(doc, raw);
      const type = isObj(p) ? (str(p.type) ?? (Array.isArray(p.type) ? p.type.join(" | ") : undefined) ?? refName(raw) ?? (p.enum ? "enum" : "object")) : "any";
      const nested = isObj(p) && (isObj(p.properties) || (isObj(p.items) && isObj(deref(doc, p.items)) && isObj((deref(doc, p.items) as Json).properties))) ? (isObj(p.properties) ? p : p.items) : undefined;
      rows.push({ name, type: isObj(p) && p.type === "array" && isObj(p.items) ? `${str((deref(doc, p.items) as Json).type) ?? refName(p.items) ?? "item"}[]` : type, required: required.has(name), child: nested, description: isObj(p) ? str(p.description) : undefined });
    }
  } else if (Array.isArray(s.fields)) {
    for (const f of s.fields) {
      if (!isObj(f) || typeof f.name !== "string") continue;
      const t = f.type;
      const optional = Array.isArray(t) && t.includes("null");
      const base = Array.isArray(t) ? t.filter((x) => x !== "null") : [t];
      const label = base.map((x) => (typeof x === "string" ? x : isObj(x) ? str(x.name) ?? str(x.type) ?? "complex" : "?")).join(" | ");
      const record = base.find((x) => isObj(x) && x.type === "record");
      rows.push({ name: f.name, type: label, required: !optional, child: record, description: str(f.doc) });
    }
  } else {
    const label = str(s.type) ?? str(s.title) ?? refName(schema) ?? str(s.$ref);
    return label ? <Mono>{label}</Mono> : <span className="text-muted-foreground">No fields</span>;
  }
  if (rows.length === 0) return <span className="text-muted-foreground">No fields</span>;
  return (
    <ul className={cn("space-y-0.5", depth > 0 && "ml-space-3 border-l border-border/60 pl-space-2")}>
      {rows.map((r) => (
        <li key={r.name}>
          <div className="flex flex-wrap items-baseline gap-x-space-2">
            <span className="font-mono text-caption text-foreground">{r.name}</span>
            <span className="font-mono text-caption text-muted-foreground">{r.type}</span>
            {r.required && <span className="text-caption text-warning">required</span>}
            {r.description && <span className="truncate text-caption text-muted-foreground" title={r.description}>{r.description}</span>}
          </div>
          {r.child !== undefined && depth < 4 && <SchemaTree doc={doc} schema={r.child} depth={depth + 1} />}
        </li>
      ))}
    </ul>
  );
}

const Action = ({ action }: { action: string }) => (
  <Badge variant={action === "send" ? "default" : "secondary"} className="gap-1">
    {action === "send" ? <ArrowUpRight aria-hidden="true" className="size-3" /> : <ArrowDownLeft aria-hidden="true" className="size-3" />}
    {action}
  </Badge>
);

export function AsyncApiVisual({ document: doc }: { document: Json }) {
  const info = isObj(doc.info) ? doc.info : {};
  const components = isObj(doc.components) ? doc.components : {};
  const servers = entries(doc.servers);
  const channels = entries(doc.channels);
  const operations = entries(doc.operations);
  const messageMap = new Map<string, Json>();
  for (const [key, m] of entries(components.messages)) messageMap.set(key, m);
  for (const [, ch] of channels) for (const [key, m] of entries(ch.messages)) if (!messageMap.has(key)) { const r = deref(doc, m); if (isObj(r)) messageMap.set(refName(m) ?? key, r); }
  const messages = [...messageMap.entries()];
  const schemes = entries(components.securitySchemes);
  const channelLabel = (ref: unknown) => { const c = deref(doc, ref); return isObj(c) ? str(c.address) ?? refName(ref) ?? "channel" : refName(ref) ?? "channel"; };
  const tags = Array.isArray(info.tags) ? info.tags.flatMap((t) => (isObj(t) && typeof t.name === "string" ? [t.name] : [])) : [];

  return (
    <div data-testid="asyncapi-visual" className="space-y-space-3 p-space-3">
      <header className="space-y-space-1">
        <div className="flex flex-wrap items-center gap-space-2">
          <h3 className="text-body font-semibold text-foreground">{str(info.title) ?? "Untitled event"}</h3>
          {str(info.version) && <Badge variant="outline">v{str(info.version)}</Badge>}
          {str(doc.asyncapi) && <Badge variant="secondary">AsyncAPI {str(doc.asyncapi)}</Badge>}
        </div>
        {str(info.description) && <p className="text-body-small text-muted-foreground">{str(info.description)}</p>}
        <div className="flex flex-wrap gap-x-space-4 gap-y-1 text-caption text-muted-foreground">
          {str(doc.defaultContentType) && <span>Content type <Mono>{str(doc.defaultContentType)}</Mono></span>}
          {str(info["x-cloudevents-source"]) && <span>CloudEvents source <Mono>{str(info["x-cloudevents-source"])}</Mono></span>}
          {tags.length > 0 && <span>Tags {tags.join(", ")}</span>}
        </div>
      </header>

      {operations.length > 0 && (
        <section aria-label="Flow" data-testid="visual-flow" className="space-y-1 rounded-lg bg-muted/30 p-space-2">
          {operations.map(([key, op]) => {
            const msgs = Array.isArray(op.messages) ? op.messages.map((m) => refName(m) ?? "message") : [];
            return (
              <div key={key} data-testid={`visual-flow-${key}`} className="flex flex-wrap items-center gap-space-2 text-body-small">
                <Action action={str(op.action) ?? "send"} />
                <span className="font-medium text-foreground">{key}</span>
                <span className="text-muted-foreground">on</span>
                <Mono>{channelLabel(op.channel)}</Mono>
                {msgs.length > 0 && <span className="flex flex-wrap gap-1">{msgs.map((m) => <Badge key={m} variant="outline">{m}</Badge>)}</span>}
                {isObj(op.reply) && <Badge variant="outline">request · reply</Badge>}
              </div>
            );
          })}
        </section>
      )}

      {channels.length > 0 && (
        <Section id="channels" title="Channels" count={channels.length}>
          {channels.map(([key, ch]) => {
            const msgKeys = entries(ch.messages).map(([k]) => k);
            const serverRefs = Array.isArray(ch.servers) ? ch.servers.map((s) => refName(s) ?? "server") : [];
            const params = Object.keys(isObj(ch.parameters) ? ch.parameters : {});
            const bindings = Object.keys(isObj(ch.bindings) ? ch.bindings : {});
            return (
              <Item key={key} id={`visual-channel-${key}`} title={<Mono>{str(ch.address) ?? key}</Mono>} meta={<span className="text-caption text-muted-foreground">{msgKeys.length} message{msgKeys.length === 1 ? "" : "s"}</span>}>
                {str(ch.description) && <p className="text-muted-foreground">{str(ch.description)}</p>}
                <Field label="Key">{key}</Field>
                {msgKeys.length > 0 && <Field label="Messages">{msgKeys.join(", ")}</Field>}
                {serverRefs.length > 0 && <Field label="Servers">{serverRefs.join(", ")}</Field>}
                {params.length > 0 && <Field label="Parameters">{params.join(", ")}</Field>}
                {bindings.length > 0 && <Field label="Bindings">{bindings.join(", ")}</Field>}
              </Item>
            );
          })}
        </Section>
      )}

      {messages.length > 0 && (
        <Section id="messages" title="Messages" count={messages.length}>
          {messages.map(([key, m]) => {
            const traits = Array.isArray(m.traits) ? m.traits.map((t) => refName(t) ?? str((deref(doc, t) as Json)?.name) ?? "trait") : [];
            const examples = Array.isArray(m.examples) ? m.examples.length : 0;
            return (
              <Item
                key={key} id={`visual-message-${key}`} title={str(m.title) ?? str(m.name) ?? key}
                meta={<>{str(m.contentType) && <Badge variant="outline">{str(m.contentType)}</Badge>}{traits.map((t) => <Badge key={t} variant="secondary">{t}</Badge>)}</>}
              >
                {(str(m.summary) || str(m.description)) && <p className="text-muted-foreground">{str(m.summary) ?? str(m.description)}</p>}
                {m.payload !== undefined && <div className="space-y-1"><p className="text-caption font-medium text-muted-foreground">Payload</p><SchemaTree doc={doc} schema={m.payload} /></div>}
                {m.headers !== undefined && <div className="space-y-1"><p className="text-caption font-medium text-muted-foreground">Headers</p><SchemaTree doc={doc} schema={m.headers} /></div>}
                {isObj(m.correlationId) && <Field label="Correlation id"><Mono>{str(m.correlationId.location) ?? "set"}</Mono></Field>}
                {examples > 0 && <Field label="Examples">{examples}</Field>}
                {Object.keys(isObj(m.bindings) ? m.bindings : {}).length > 0 && <Field label="Bindings">{Object.keys(m.bindings as Json).join(", ")}</Field>}
              </Item>
            );
          })}
        </Section>
      )}

      {servers.length > 0 && (
        <Section id="servers" title="Servers" count={servers.length} defaultOpen={false}>
          {servers.map(([key, s]) => (
            <Item key={key} id={`visual-server-${key}`} title={key} meta={<><Badge variant="outline">{str(s.protocol) ?? "?"}{str(s.protocolVersion) ? ` ${str(s.protocolVersion)}` : ""}</Badge><Mono>{`${str(s.host) ?? ""}${str(s.pathname) ?? ""}`}</Mono></>} />
          ))}
        </Section>
      )}

      {schemes.length > 0 && (
        <Section id="security" title="Security schemes" count={schemes.length} defaultOpen={false}>
          {schemes.map(([key, s]) => <Item key={key} id={`visual-security-${key}`} title={key} meta={<Badge variant="outline">{str(s.type) ?? "?"}</Badge>} />)}
        </Section>
      )}

      {operations.length === 0 && channels.length === 0 && messages.length === 0 && servers.length === 0 && (
        <p data-testid="visual-empty" className="text-body-small text-muted-foreground">Nothing is defined yet. Add channels, messages and operations in Design.</p>
      )}
    </div>
  );
}
