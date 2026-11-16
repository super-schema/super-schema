"use client";

import { useEffect, useId, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Field, FieldLabel } from "@/components/ui/field";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { CLASS_SCALE } from "@/lib/classification-scale";
import { TypePicker } from "@/components/custom/TypePicker";
import { assetHref } from "@/lib/navigation/asset-href";
import { checkValueSchema } from "@/lib/metadata-attributes/value-schema";
import type { DictionaryUsageRow } from "@/services/field-dictionary.service";
import { METADATA_ATTRIBUTE_TARGETS } from "@/types/schemas/metadata-attribute";
import { GENERIC_ACTION_ERROR } from "@/types/action-result";
import {
  createAttributeAction,
  createFieldEntryAction,
  deleteAttributeAction,
  deleteFieldEntryAction,
  dictionariesOverviewAction,
  fieldEntryUsageAction,
  installPackAction,
  uninstallPackAction,
  updateAttributeAction,
  updateFieldEntryAction,
  type DictionariesOverview,
} from "@/app/(dashboard)/admin/settings/dictionaries/actions";

import { NativeSelect } from "@/components/ui/native-select";
import { Checkbox } from "@/components/ui/checkbox";
type Answer = { data: unknown } | { error: string };

const EMPTY_FIELD = { name: "", aliases: "", type: "", description: "", classification: "", attributes: "{}" };
const EMPTY_ATTR = {
  key: "x-",
  label: "",
  description: "",
  targets: ["field"] as string[],
  scope: "schema",
  placement: "field",
  requiredWhen: "never",
  derive: "",
  valueSchema: '{\n  "type": "string"\n}',
};

function parseJson(text: string): { value?: unknown; error?: string } {
  try {
    return { value: JSON.parse(text) };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Invalid JSON" };
  }
}

/** The inline problems of a value-schema editor: JSON syntax first, then the supported-subset check. */
export function valueSchemaProblems(text: string): string[] {
  const parsed = parseJson(text);
  if (parsed.error) return [`Not valid JSON: ${parsed.error}`];
  return checkValueSchema(parsed.value);
}


type Run = (c: () => Promise<Answer>) => Promise<boolean>;

/** A tenant-wide removal waiting for the admin's confirmation. */
interface PendingConfirm {
  title: string;
  description: string;
  confirmLabel: string;
  action: () => Promise<Answer>;
}

/** The confirmation of a tenant-wide removal, built on the shared dialog (as the account disable confirmation is). */
function ConfirmRemoval({ pending, busy, onCancel, onConfirm }: { pending: PendingConfirm | null; busy: boolean; onCancel: () => void; onConfirm: () => void }) {
  return (
    <Dialog open={!!pending} onOpenChange={(next) => !next && !busy && onCancel()} modal>
      <DialogContent className="sm:max-w-md" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{pending?.title}</DialogTitle>
          <DialogDescription>{pending?.description}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" variant="outline" disabled={busy} onClick={onCancel}>
            Cancel
          </Button>
          <Button type="button" variant="destructive" disabled={busy} onClick={onConfirm}>
            {pending?.confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** "Class 2 — PII" for a standard level; "FINANCIAL (Class 2)" for a custom one. */
export function levelOptionLabel(level: { name: string; classNumber: number }): string {
  const standard = CLASS_SCALE.find((c) => c.level === level.name.toUpperCase());
  return standard ? `Class ${standard.classNumber} — ${standard.label}` : `${level.name} (Class ${level.classNumber})`;
}

const STANDARD_LEVELS = CLASS_SCALE.map((c) => ({ name: c.level as string, classNumber: c.classNumber as number }));

export function DictionariesAdmin({ initial, section }: { initial: DictionariesOverview; section?: "fields" | "attributes" }) {
  const [data, setData] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<PendingConfirm | null>(null);

  async function run(call: () => Promise<Answer>): Promise<boolean> {
    setBusy(true);
    setError(null);
    try {
      const answer = await call();
      if ("error" in answer) {
        setError(answer.error);
        return false;
      }
      const fresh = await dictionariesOverviewAction();
      if ("error" in fresh) setError(fresh.error);
      else setData(fresh.data);
      return true;
    } catch {
      // A rejected server action (network drop, an unexpected server failure): shown, never swallowed; the cause is not printed.
      setError(GENERIC_ACTION_ERROR);
      return false;
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-space-4">
      <div>
        <h2 className="text-heading-3 text-foreground">{section === "attributes" ? "Custom attributes" : "Dictionaries"}</h2>
        <p className="text-body-small text-muted-foreground">
          {section === "attributes" ? "Define classification, tag, and other metadata attributes for this tenant. Install attribute packs or create your own definitions." : "Define reusable enterprise fields for this tenant. Pick them from the dictionary when adding fields."}
        </p>
      </div>
      {error && (
        <p role="alert" className="rounded-lg border border-destructive/40 p-3 text-body-small text-destructive">
          {error}
        </p>
      )}
      <ConfirmRemoval
        pending={pending}
        busy={busy}
        onCancel={() => setPending(null)}
        onConfirm={() => {
          const action = pending?.action;
          setPending(null);
          if (action) void run(action);
        }}
      />
      {section === "fields" ? (
        <FieldsTab entries={data.fields} usage={data.usage ?? {}} levels={data.formOptions?.levels ?? STANDARD_LEVELS}
          customTypes={data.formOptions?.customTypes ?? []} busy={busy} run={run} confirm={setPending} />
      ) : section === "attributes" ? (
        <AttributesTab data={data} busy={busy} run={run} confirm={setPending} />
      ) : (
      <Tabs defaultValue="fields">
        <TabsList>
          <TabsTrigger value="fields">Fields</TabsTrigger>
          <TabsTrigger value="attributes">Metadata attributes</TabsTrigger>
        </TabsList>
        <TabsContent value="fields">
          <FieldsTab
            entries={data.fields}
            usage={data.usage ?? {}}
            levels={data.formOptions?.levels ?? STANDARD_LEVELS}
            customTypes={data.formOptions?.customTypes ?? []}
            busy={busy}
            run={run}
            confirm={setPending}
          />
        </TabsContent>
        <TabsContent value="attributes">
          <AttributesTab data={data} busy={busy} run={run} confirm={setPending} />
        </TabsContent>
      </Tabs>
      )}
    </div>
  );
}

/** The page of a field in the usage drawer: built by the shared link helper (an Enterprise entity has no domain / product). */
function usageHref(u: DictionaryUsageRow): string {
  return assetHref({ kind: "field", entitySlug: u.entitySlug, fieldId: u.fieldId, domainSlug: u.domainSlug, productSlug: u.productSlug });
}

/** Read-only: the fields linked to an entry and which of their properties differ from it. Nothing is synced from here. */
function UsageDrawer({ entry, onClose }: { entry: DictionariesOverview["fields"][number] | null; onClose: () => void }) {
  const [state, setState] = useState<{ id: string; rows?: DictionaryUsageRow[]; error?: string } | null>(null);
  const entryId = entry?.id;
  useEffect(() => {
    if (!entryId) return;
    let live = true;
    fieldEntryUsageAction(entryId)
      .then((a) => {
        if (live) setState("error" in a ? { id: entryId, error: a.error } : { id: entryId, rows: a.data });
      })
      .catch(() => {
        // A rejected action would leave "Loading..." forever: say it failed instead.
        if (live) setState({ id: entryId, error: "The usage could not be loaded. Close and try again." });
      });
    return () => {
      live = false;
    };
  }, [entryId]);
  const shown = state && state.id === entryId ? state : null;
  return (
    <Sheet open={!!entry} onOpenChange={(open) => !open && onClose()}>
      <SheetContent>
        <SheetHeader>
          <SheetTitle>Usage of {entry?.name}</SheetTitle>
          <SheetDescription>Fields linked to this dictionary entry, and what differs from it. Fields are never changed from here.</SheetDescription>
        </SheetHeader>
        <div className="space-y-2 overflow-y-auto p-4">
          {!shown && <p className="text-body-small text-muted-foreground">Loading...</p>}
          {shown?.error && (
            <p role="alert" className="text-body-small text-destructive">
              {shown.error}
            </p>
          )}
          {shown?.rows?.length === 0 && <p className="text-body-small text-muted-foreground">No fields use this entry.</p>}
          {shown?.rows && shown.rows.length > 0 && (
            <ul className="divide-y divide-border rounded-lg border border-border">
              {shown.rows.map((u) => (
                <li key={u.fieldId} className="space-y-1 p-3">
                  <a href={usageHref(u)} className="font-medium underline">
                    {u.entityName}.{u.fieldName}
                  </a>
                  <p className="text-body-small text-muted-foreground">
                    {u.domainSlug && u.productSlug ? `${u.domainSlug} / ${u.productSlug}` : "Enterprise"}
                  </p>
                  {u.drift.length === 0 ? (
                    <Badge variant="secondary">In sync</Badge>
                  ) : (
                    <p className="text-body-small">Differs: {u.drift.join(", ")}</p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function FieldsTab({
  entries,
  usage,
  levels,
  customTypes,
  busy,
  run,
  confirm,
}: {
  entries: DictionariesOverview["fields"];
  usage: Record<string, number>;
  levels: { name: string; classNumber: number }[];
  customTypes: string[];
  busy: boolean;
  run: Run;
  confirm: (p: PendingConfirm) => void;
}) {
  const [usageOf, setUsageOf] = useState<DictionariesOverview["fields"][number] | null>(null);
  const [form, setForm] = useState(EMPTY_FIELD);
  const [editing, setEditing] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const id = useId();
  const set = (k: keyof typeof EMPTY_FIELD, v: string) => setForm((f) => ({ ...f, [k]: v }));
  // A stored level the list does not know (renamed, legacy) stays selectable, so editing the entry does not drop it silently.
  const current = form.classification.trim();
  const known = levels.find((l) => l.name.toUpperCase() === current.toUpperCase());
  const levelOptions = current && !known ? [...levels, { name: current, classNumber: 0 }] : levels;

  async function save() {
    const attrs = parseJson(form.attributes || "{}");
    if (attrs.error) return setFormError(`Default attributes are not valid JSON: ${attrs.error}`);
    setFormError(null);
    const body = {
      name: form.name,
      aliases: form.aliases.split(",").map((a) => a.trim()).filter(Boolean),
      type: form.type,
      description: form.description,
      classification: form.classification.trim() || null,
      attributes: attrs.value,
    };
    const done = await run(() => (editing ? updateFieldEntryAction(editing, body) : createFieldEntryAction(body)));
    if (done) {
      setForm(EMPTY_FIELD);
      setEditing(null);
    }
  }

  return (
    <section aria-label="Field dictionary" className="space-y-space-4">
      <UsageDrawer entry={usageOf} onClose={() => setUsageOf(null)} />
      {entries.length === 0 ? (
        <p className="text-body-small text-muted-foreground">No dictionary fields yet.</p>
      ) : (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {entries.map((e) => (
            <li key={e.id} className="flex flex-wrap items-center justify-between gap-2 p-3">
              <div>
                <span className="font-medium">{e.name}</span> <span className="text-muted-foreground">{e.type}</span>
                {e.aliases.length > 0 && <span className="ml-2 text-body-small text-muted-foreground">aka {e.aliases.join(", ")}</span>}
                <span className="ml-2 text-body-small text-muted-foreground">
                  {usage[e.id] ?? 0} {(usage[e.id] ?? 0) === 1 ? "field" : "fields"}
                </span>
              </div>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" aria-label={`Usage of ${e.name}`} onClick={() => setUsageOf(e)}>
                  Usage
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setEditing(e.id);
                    setForm({
                      name: e.name,
                      aliases: e.aliases.join(", "),
                      type: e.type,
                      description: e.description,
                      classification: e.classification ?? "",
                      attributes: JSON.stringify(e.attributes, null, 2),
                    });
                  }}
                >
                  Edit {e.name}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() =>
                    confirm({
                      title: `Delete "${e.name}"?`,
                      description: "The entry is removed from the tenant's field dictionary. Fields linked to it keep their name, type and values; they are no longer linked.",
                      confirmLabel: "Delete",
                      action: () => deleteFieldEntryAction(e.id),
                    })
                  }
                >
                  Delete {e.name}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
      <div className="grid gap-3 rounded-lg border border-border p-4 sm:grid-cols-2">
        <h3 className="text-heading-3 sm:col-span-2">{editing ? "Edit field" : "New field"}</h3>
        <label className="space-y-1 text-body-small" htmlFor={`${id}-name`}>
          Name
          <Input id={`${id}-name`} value={form.name} onChange={(e) => set("name", e.target.value)} />
        </label>
        <Field>
          <FieldLabel htmlFor={`${id}-type`}>Type</FieldLabel>
          <TypePicker id={`${id}-type`} value={form.type} onChange={(value) => set("type", value)} customTypes={customTypes} disabled={busy} />
        </Field>
        <label className="space-y-1 text-body-small" htmlFor={`${id}-aliases`}>
          Aliases (comma separated)
          <Input id={`${id}-aliases`} value={form.aliases} onChange={(e) => set("aliases", e.target.value)} />
        </label>
        <label className="space-y-1 text-body-small" htmlFor={`${id}-class`}>
          Default classification
          <NativeSelect
            id={`${id}-class`}
            value={known?.name ?? current}
            onChange={(e) => set("classification", e.target.value)}
          >
            <option value="">None</option>
            {levelOptions.map((l) => (
              <option key={l.name} value={l.name}>
                {l.classNumber === 0 ? l.name : levelOptionLabel(l)}
              </option>
            ))}
          </NativeSelect>
        </label>
        <label className="space-y-1 text-body-small sm:col-span-2" htmlFor={`${id}-desc`}>
          Description
          <Input id={`${id}-desc`} value={form.description} onChange={(e) => set("description", e.target.value)} />
        </label>
        <label className="space-y-1 text-body-small sm:col-span-2" htmlFor={`${id}-attrs`}>
          Default attributes (JSON)
          <Textarea id={`${id}-attrs`} className="font-mono" value={form.attributes} onChange={(e) => set("attributes", e.target.value)} />
        </label>
        {formError && (
          <p role="alert" className="text-body-small text-destructive sm:col-span-2">
            {formError}
          </p>
        )}
        <div className="flex gap-2 sm:col-span-2">
          <Button disabled={busy} onClick={save}>
            {editing ? "Save field" : "Add field"}
          </Button>
          {editing && (
            <Button
              variant="outline"
              onClick={() => {
                setEditing(null);
                setForm(EMPTY_FIELD);
              }}
            >
              Cancel
            </Button>
          )}
        </div>
      </div>
    </section>
  );
}

function AttributesTab({ data, busy, run, confirm }: { data: DictionariesOverview; busy: boolean; run: Run; confirm: (p: PendingConfirm) => void }) {
  const [form, setForm] = useState(EMPTY_ATTR);
  const [editing, setEditing] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const id = useId();
  const set = (k: keyof typeof EMPTY_ATTR, v: string) => setForm((f) => ({ ...f, [k]: v }));
  const problems = valueSchemaProblems(form.valueSchema);

  async function save() {
    if (problems.length > 0) return;
    let derive: unknown = null;
    if (form.derive.trim()) {
      const d = parseJson(form.derive);
      if (d.error) return setFormError(`Derived members are not valid JSON: ${d.error}`);
      derive = d.value;
    }
    setFormError(null);
    const body = {
      key: form.key,
      label: form.label,
      description: form.description,
      targets: form.targets,
      scope: form.scope,
      placement: form.placement,
      requiredWhen: form.requiredWhen,
      derive,
      valueSchema: parseJson(form.valueSchema).value,
    };
    const done = await run(() => (editing ? updateAttributeAction(editing, body) : createAttributeAction(body)));
    if (done) {
      setForm(EMPTY_ATTR);
      setEditing(null);
    }
  }

  return (
    <div className="space-y-space-6">
      <section aria-label="Metadata attribute dictionary" className="space-y-space-4">
        {data.attributes.length === 0 ? (
          <p className="text-body-small text-muted-foreground">No metadata attributes yet.</p>
        ) : (
          <ul className="divide-y divide-border rounded-lg border border-border">
            {data.attributes.map((a) => (
              <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 p-3">
                <div>
                  <span className="font-mono">{a.key}</span> <span className="text-muted-foreground">{a.label}</span>
                  {a.pack && (
                    <Badge variant="secondary" className="ml-2">
                      Read-only (pack: {data.packs.find((p) => p.id === a.pack)?.name ?? a.pack})
                    </Badge>
                  )}
                </div>
                {!a.pack && (
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        setEditing(a.id);
                        setForm({
                          key: a.key,
                          label: a.label,
                          description: a.description,
                          targets: [...a.targets],
                          scope: a.scope,
                          placement: a.placement,
                          requiredWhen: a.requiredWhen,
                          derive: a.derive ? JSON.stringify(a.derive, null, 2) : "",
                          valueSchema: JSON.stringify(a.valueSchema, null, 2),
                        });
                      }}
                    >
                      Edit {a.key}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy}
                      onClick={() =>
                        confirm({
                          title: `Delete "${a.key}"?`,
                          description: "The definition is removed from the tenant's dictionary. Values already stored on fields, entities and events stay where they are; they are no longer edited with a typed editor.",
                          confirmLabel: "Delete",
                          action: () => deleteAttributeAction(a.id),
                        })
                      }
                    >
                      Delete {a.key}
                    </Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
        <div className="grid gap-3 rounded-lg border border-border p-4 sm:grid-cols-2">
          <h3 className="text-heading-3 sm:col-span-2">{editing ? "Edit attribute" : "New attribute"}</h3>
          <label className="space-y-1 text-body-small" htmlFor={`${id}-key`}>
            Key
            <Input id={`${id}-key`} value={form.key} disabled={!!editing} onChange={(e) => set("key", e.target.value)} />
          </label>
          <label className="space-y-1 text-body-small" htmlFor={`${id}-label`}>
            Label
            <Input id={`${id}-label`} value={form.label} onChange={(e) => set("label", e.target.value)} />
          </label>
          <label className="space-y-1 text-body-small sm:col-span-2" htmlFor={`${id}-desc`}>
            Description
            <Input id={`${id}-desc`} value={form.description} onChange={(e) => set("description", e.target.value)} />
          </label>
          <fieldset className="space-y-1 text-body-small sm:col-span-2">
            <legend>Targets</legend>
            <div className="flex flex-wrap gap-3">
              {METADATA_ATTRIBUTE_TARGETS.map((t) => (
                <label key={t} className="flex items-center gap-1">
                  <Checkbox
                    checked={form.targets.includes(t)}
                    onChange={(e) => setForm((f) => ({ ...f, targets: e.target.checked ? [...f.targets, t] : f.targets.filter((x) => x !== t) }))}
                  />
                  {t}
                </label>
              ))}
            </div>
          </fieldset>
          <label className="space-y-1 text-body-small" htmlFor={`${id}-scope`}>
            Scope
            <NativeSelect id={`${id}-scope`} value={form.scope} onChange={(e) => set("scope", e.target.value)}>
              <option value="schema">schema</option>
              <option value="internal">internal</option>
            </NativeSelect>
          </label>
          <label className="space-y-1 text-body-small" htmlFor={`${id}-placement`}>
            Placement
            <NativeSelect id={`${id}-placement`} value={form.placement} onChange={(e) => set("placement", e.target.value)}>
              <option value="field">field</option>
              <option value="abc-primitive">abc-primitive</option>
            </NativeSelect>
          </label>
          <label className="space-y-1 text-body-small" htmlFor={`${id}-required`}>
            Required when
            <NativeSelect id={`${id}-required`} value={form.requiredWhen} onChange={(e) => set("requiredWhen", e.target.value)}>
              <option value="never">never</option>
              <option value="always">always</option>
              <option value="primitive">primitive</option>
            </NativeSelect>
          </label>
          <label className="space-y-1 text-body-small" htmlFor={`${id}-derive`}>
            Derived members (JSON, optional)
            <Textarea id={`${id}-derive`} className="font-mono" value={form.derive} onChange={(e) => set("derive", e.target.value)} />
          </label>
          <label className="space-y-1 text-body-small sm:col-span-2" htmlFor={`${id}-schema`}>
            Value schema (JSON)
            <Textarea
              id={`${id}-schema`}
              className="font-mono"
              rows={8}
              aria-invalid={problems.length > 0}
              value={form.valueSchema}
              onChange={(e) => set("valueSchema", e.target.value)}
            />
          </label>
          {problems.length > 0 && (
            <ul role="alert" aria-label="Value schema problems" className="list-disc pl-5 text-body-small text-destructive sm:col-span-2">
              {problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          )}
          {formError && (
            <p role="alert" className="text-body-small text-destructive sm:col-span-2">
              {formError}
            </p>
          )}
          <div className="flex gap-2 sm:col-span-2">
            <Button disabled={busy || problems.length > 0} onClick={save}>
              {editing ? "Save attribute" : "Add attribute"}
            </Button>
            {editing && (
              <Button
                variant="outline"
                onClick={() => {
                  setEditing(null);
                  setForm(EMPTY_ATTR);
                }}
              >
                Cancel
              </Button>
            )}
          </div>
        </div>
      </section>

      <section aria-labelledby={`${id}-packs`} className="space-y-space-3">
        <h3 id={`${id}-packs`} className="text-heading-3">
          Packs
        </h3>
        <p className="text-body-small text-muted-foreground">A pack is a ready-made set of attributes. Installing one adds its entries to this dictionary.</p>
        <ul className="divide-y divide-border rounded-lg border border-border">
          {data.packs.map((p) => (
            <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 p-3">
              <div>
                <div className="font-medium">{p.name}</div>
                <div className="text-body-small text-muted-foreground">{p.description}</div>
              </div>
              {p.installed ? (
                <div className="flex items-center gap-2">
                  <Badge>Installed</Badge>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    onClick={() =>
                      confirm({
                        title: `Uninstall "${p.name}"?`,
                        description: `Its definitions (${p.keys.join(", ")}) are removed from the tenant's dictionary. Stored values remain on fields, entities and events; they are no longer edited with a typed editor or derived.`,
                        confirmLabel: "Uninstall",
                        action: () => uninstallPackAction(p.id),
                      })
                    }
                  >
                    Uninstall {p.name}
                  </Button>
                </div>
              ) : (
                <Button size="sm" disabled={busy} onClick={() => run(() => installPackAction(p.id))}>
                  Install {p.name}
                </Button>
              )}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
