"use client";

// src/features/events/event-page/AsyncApiVisual.tsx
// A visual, read-only reading of a generated AsyncAPI 3 document: what the event sends and receives, on which channels, carrying which
// messages (payload and header fields as a tree), and the servers and security it declares. Only what the document sets is shown:
// an event without servers has no Servers section. Every item is collapsible; the flow summary at the top stays compact.
import { Fragment, useMemo, useState, type ReactNode } from "react";
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

/** One field of a payload or headers schema, flattened for the table; `children` are the fields of a nested object or array of objects. */
interface FieldRow {
  path: string; name: string; type: string; required: boolean; description?: string;
  /** Possible values: enum members, or the single value a `const` allows. */
  values?: { kind: "one-of" | "always"; items: string[] };
  /** Constraints and hints shown as small facts: format, range, length, pattern, default, example. */
  facts: string[];
  children: FieldRow[];
}

const show = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v));

function jsonSchemaFacts(p: Json): string[] {
  const f: string[] = [];
  if (str(p.format)) f.push(`format ${p.format}`);
  const lo = p.minimum ?? p.exclusiveMinimum, hi = p.maximum ?? p.exclusiveMaximum;
  if (lo !== undefined || hi !== undefined) f.push(`${lo !== undefined ? `${p.exclusiveMinimum !== undefined ? ">" : "≥"} ${show(lo)}` : ""}${lo !== undefined && hi !== undefined ? " · " : ""}${hi !== undefined ? `${p.exclusiveMaximum !== undefined ? "<" : "≤"} ${show(hi)}` : ""}`);
  if (p.minLength !== undefined || p.maxLength !== undefined) f.push(`length ${p.minLength ?? 0}–${p.maxLength ?? "∞"}`);
  if (p.minItems !== undefined || p.maxItems !== undefined) f.push(`items ${p.minItems ?? 0}–${p.maxItems ?? "∞"}`);
  if (str(p.pattern)) f.push(`pattern ${p.pattern}`);
  if (p.default !== undefined) f.push(`default ${show(p.default)}`);
  const example = Array.isArray(p.examples) ? p.examples[0] : p.example;
  if (example !== undefined) f.push(`e.g. ${show(example)}`);
  return f;
}

/** Fields of a schema: JSON Schema `properties` or an Avro record's `fields` (a multi-format `{ schemaFormat, schema }` is unwrapped). */
function fieldRows(doc: Json, schema: unknown, prefix = "", depth = 0): FieldRow[] | string {
  // Multi-format payloads may carry Avro / JSON Schema as serialized JSON rather than an object.
  const unpack = (value: unknown): unknown => {
    if (typeof value !== "string") return value;
    try { return JSON.parse(value); } catch { return value; }
  };
  let s = deref(doc, unpack(schema));
  if (isObj(s) && "schemaFormat" in s && "schema" in s) s = deref(doc, unpack(s.schema));
  if (!isObj(s)) {
    return typeof s === "string" && s.length < 120 && !s.includes("\n")
      ? s
      : "This representation cannot be shown as fields. Open Code to inspect its schema.";
  }
  if (depth > 5) return [];
  if (isObj(s.properties)) {
    const required = new Set(Array.isArray(s.required) ? s.required : []);
    return Object.entries(s.properties).map(([name, raw]) => {
      const p = deref(doc, raw);
      const path = prefix ? `${prefix}.${name}` : name;
      if (!isObj(p)) return { path, name, type: "any", required: required.has(name), facts: [], children: [] };
      const items = isObj(p.items) ? deref(doc, p.items) : undefined;
      const itemType = isObj(items) ? str(items.type) ?? refName(p.items) ?? "item" : undefined;
      const type = p.type === "array" ? `${itemType ?? "item"}[]` : Array.isArray(p.type) ? p.type.join(" | ") : str(p.type) ?? refName(raw) ?? (p.enum ? "enum" : isObj(p.properties) ? "object" : "any");
      const enumOf = Array.isArray(p.enum) ? p.enum : isObj(items) && Array.isArray(items.enum) ? items.enum : undefined;
      const nested = isObj(p.properties) ? p : isObj(items) && isObj(items.properties) ? items : undefined;
      const children = nested ? fieldRows(doc, nested, path, depth + 1) : [];
      return {
        path, name, type, required: required.has(name), description: str(p.description),
        values: p.const !== undefined ? { kind: "always" as const, items: [show(p.const)] } : enumOf ? { kind: "one-of" as const, items: enumOf.map(show) } : undefined,
        facts: [...jsonSchemaFacts(p), ...(isObj(items) ? jsonSchemaFacts(items).map((f) => `each ${f}`) : [])],
        children: Array.isArray(children) ? children : [],
      };
    });
  }
  if (Array.isArray(s.fields)) {
    return s.fields.flatMap((f): FieldRow[] => {
      if (!isObj(f) || typeof f.name !== "string") return [];
      const path = prefix ? `${prefix}.${f.name}` : f.name;
      const branches = Array.isArray(f.type) ? f.type : [f.type];
      const optional = branches.includes("null");
      const real = branches.filter((x) => x !== "null");
      const label = (x: unknown): string => {
        if (typeof x === "string") return x;
        if (!isObj(x)) return "?";
        if (x.type === "array") return `${label(x.items)}[]`;
        if (x.type === "map") return `map<${label(x.values)}>`;
        if (str(x.logicalType)) return `${str(x.type)} (${x.logicalType})`;
        return str(x.name) ?? str(x.type) ?? "complex";
      };
      const enumType = real.flatMap((x) => isObj(x) && x.type === "array" ? [x.items] : [x])
        .find((x) => isObj(x) && x.type === "enum") as Json | undefined;
      const record = real.find((x) => isObj(x) && x.type === "record") ?? real.map((x) => (isObj(x) && x.type === "array" && isObj(x.items) && x.items.type === "record" ? x.items : undefined)).find(Boolean);
      const children = record ? fieldRows(doc, record, path, depth + 1) : [];
      return [{
        path, name: f.name, type: real.map(label).join(" | "), required: !optional, description: str(f.doc),
        values: enumType && Array.isArray(enumType.symbols) ? { kind: "one-of", items: enumType.symbols.map(show) } : undefined,
        facts: f.default !== undefined && f.default !== null ? [`default ${show(f.default)}`] : [],
        children: Array.isArray(children) ? children : [],
      }];
    });
  }
  return str(s.type) ?? str(s.title) ?? refName(schema) ?? str(s.$ref) ?? "";
}

/** Values chips: up to 8 shown, the rest behind "+n". */
function Values({ values }: { values: NonNullable<FieldRow["values"]> }) {
  const shown = values.items.slice(0, 8);
  return (
    <div className="flex flex-wrap items-center gap-1">
      <span className="text-caption text-muted-foreground">{values.kind === "always" ? "Always" : "One of"}</span>
      {shown.map((v) => <Badge key={v} variant="secondary" className="max-w-full whitespace-normal break-all font-mono">{v}</Badge>)}
      {values.items.length > shown.length && (
        <details className="text-caption text-muted-foreground">
          <summary className="cursor-pointer">+{values.items.length - shown.length} more</summary>
          <div className="flex flex-wrap gap-1 pt-space-1">
            {values.items.slice(shown.length).map((v) => <Badge key={v} variant="secondary" className="max-w-full whitespace-normal break-all font-mono">{v}</Badge>)}
          </div>
        </details>
      )}
    </div>
  );
}

function Rows({ rows, depth, collapsed, toggle }: { rows: FieldRow[]; depth: number; collapsed: Set<string>; toggle: (path: string) => void }) {
  return (
    <>
      {rows.map((r) => {
        const open = !collapsed.has(r.path);
        return (
          <Fragment key={r.path}>
            <tr data-testid={`visual-field-${r.path}`} role="row" className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-space-2 py-space-1 align-top @lg/schema:table-row @lg/schema:py-0">
              <td role="cell" className="min-w-0 py-1.5 pr-space-2">
                <div className="flex items-start gap-1" style={{ paddingLeft: `${depth * 0.875}rem` }}>
                  {r.children.length > 0 ? (
                    <button type="button" aria-expanded={open} aria-label={`${open ? "Collapse" : "Expand"} ${r.path}`} onClick={() => toggle(r.path)} className="mt-0.5 rounded text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50">
                      <ChevronRight aria-hidden="true" className={cn("size-3.5 transition-transform", open && "rotate-90")} />
                    </button>
                  ) : <span className="w-3.5 shrink-0" />}
                  <span className="break-all font-mono text-caption font-medium text-foreground">{r.name}</span>
                  {r.required && <span className="text-caption text-destructive" title="Required">*</span>}
                </div>
              </td>
              <td role="cell" className="min-w-0 py-1.5 pr-space-2 text-right @lg/schema:text-left"><span className="break-all font-mono text-caption text-primary">{r.type}</span></td>
              <td role="cell" className="col-span-2 min-w-0 py-1.5">
                <div className="flex flex-col gap-space-2">
                  {r.description && <p className="break-words text-caption text-foreground">{r.description}</p>}
                  {r.values && <Values values={r.values} />}
                  {r.facts.length > 0 && <div className="flex flex-wrap gap-1">{r.facts.map((f) => <span key={f} className="max-w-full break-all rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">{f}</span>)}</div>}
                  {!r.values && r.facts.length === 0 && !r.description && <span className="text-caption text-muted-foreground/60">—</span>}
                </div>
              </td>
            </tr>
            {open && r.children.length > 0 && <Rows rows={r.children} depth={depth + 1} collapsed={collapsed} toggle={toggle} />}
          </Fragment>
        );
      })}
    </>
  );
}

const countRows = (rows: FieldRow[]): number => rows.reduce((n, r) => n + 1 + countRows(r.children), 0);

/** A payload or headers schema as a table: Field (nesting indented, collapsible) · Type · Allowed values & description. */
function SchemaTable({ doc, schema, label }: { doc: Json; schema: unknown; label: string }) {
  const rows = useMemo(() => fieldRows(doc, schema), [doc, schema]);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const toggle = (path: string) => setCollapsed((c) => { const n = new Set(c); if (n.has(path)) n.delete(path); else n.add(path); return n; });
  if (typeof rows === "string") {
    return <p className="text-caption text-muted-foreground">{rows ? <>Schema <Mono>{rows}</Mono> — its fields appear once the full schemas render.</> : "No fields"}</p>;
  }
  if (rows.length === 0) return <p className="text-caption text-muted-foreground">No fields</p>;
  const required = rows.filter((r) => r.required).length;
  return (
    <div className="@container/schema flex min-w-0 flex-col gap-space-2">
      <div className="flex items-baseline justify-between gap-space-2">
        <p className="text-caption font-medium text-foreground">{label}</p>
        <p className="text-caption text-muted-foreground">{countRows(rows)} fields · {required} required at top level <span className="text-destructive">*</span></p>
      </div>
      <div className="overflow-x-auto rounded-md border border-border">
        <table role="table" className="block w-full table-fixed border-collapse @lg/schema:table" aria-label={`${label} fields`}>
          <thead role="rowgroup" className="block bg-muted/40 @lg/schema:table-header-group">
            <tr role="row" className="grid grid-cols-[minmax(0,1fr)_auto] text-left text-caption text-muted-foreground @lg/schema:table-row">
              <th role="columnheader" scope="col" className="px-space-2 py-1 font-medium @lg/schema:w-[30%]">Field</th>
              <th role="columnheader" scope="col" className="px-space-2 py-1 text-right font-medium @lg/schema:w-[22%] @lg/schema:text-left">Data type</th>
              <th role="columnheader" scope="col" className="sr-only px-space-2 py-1 font-medium @lg/schema:not-sr-only">Description &amp; possible values</th>
            </tr>
          </thead>
          <tbody role="rowgroup" className="block divide-y divide-border/60 @lg/schema:table-row-group [&_td]:px-space-2">
            <Rows rows={rows} depth={0} collapsed={collapsed} toggle={toggle} />
          </tbody>
        </table>
      </div>
    </div>
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
                {m.payload !== undefined && <SchemaTable doc={doc} schema={m.payload} label="Payload" />}
                {m.headers !== undefined && <SchemaTable doc={doc} schema={m.headers} label="Headers" />}
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
