"use client";

import { useEffect, useState } from "react";
import { Hash, Sigma, GitMerge, Plus, X, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import Link from "next/link";
import type { ScopeTarget } from "@/lib/asset-scope";
import {
  createSharedEnumAction,
  updateSharedEnumAction,
  deleteSharedEnumAction,
  createCustomScalarAction,
  deleteCustomScalarAction,
  createUnionTypeAction,
  updateUnionTypeAction,
  deleteUnionTypeAction,
} from "../actions";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SharedEnumData {
  id: string;
  name: string;
  values: string[];
  description: string;
}

export interface CustomScalarData {
  id: string;
  name: string;
  baseType: string;
  format: string | null;
  pattern: string | null;
  description: string;
}

export interface UnionTypeData {
  id: string;
  name: string;
  memberTypes: string[];
  description: string;
}

export type DomainTypeKind = "enum" | "scalar" | "union";

/**
 * What the parent asks the tab to open: a specific kind's create form, or
 * "choose" to let the user pick the kind first ("New Custom Data Type").
 */
export type DomainTypeCreateIntent = DomainTypeKind | "choose";

const TYPE_KINDS: { kind: DomainTypeKind; label: string }[] = [
  { kind: "enum", label: "Enum" },
  { kind: "scalar", label: "Scalar" },
  { kind: "union", label: "Union" },
];

/** Data types owned by a broader level, shown read-only with a link to their source. */
export interface InheritedDataTypes {
  label: string;
  href: string;
  sharedEnums: SharedEnumData[];
  customScalars: CustomScalarData[];
  unionTypes: UnionTypeData[];
}

interface DomainTypesTabProps {
  domainId: string;
  /** Level the "New ..." forms create at (domain page, product page, ...). */
  target: ScopeTarget;
  sharedEnums: SharedEnumData[];
  customScalars: CustomScalarData[];
  unionTypes: UnionTypeData[];
  inherited?: InheritedDataTypes[];
  createIntent?: DomainTypeCreateIntent | null;
  onCreateIntentConsumed?: () => void;
}

type TypeSubTab = "enums" | "scalars" | "unions";

// ---------------------------------------------------------------------------
// Confirmation dialog
// ---------------------------------------------------------------------------

function useConfirmDelete() {
  const [pending, setPending] = useState<{ name: string; action: () => Promise<void> } | null>(null);

  function ask(name: string, action: () => Promise<void>) {
    setPending({ name, action });
  }

  async function confirm() {
    if (pending) {
      await pending.action();
      setPending(null);
    }
  }

  function cancel() {
    setPending(null);
  }

  return { pending, ask, confirm, cancel };
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function DomainTypesTab({ domainId, target, sharedEnums, customScalars, unionTypes, inherited, createIntent, onCreateIntentConsumed }: DomainTypesTabProps) {
  const [activeSubTab, setActiveSubTab] = useState<TypeSubTab>("enums");
  const deleteDialog = useConfirmDelete();

  // Create form states
  const [showCreateEnum, setShowCreateEnum] = useState(false);
  const [newEnumName, setNewEnumName] = useState("");
  const [newEnumValues, setNewEnumValues] = useState("");

  const [showCreateScalar, setShowCreateScalar] = useState(false);
  const [newScalarName, setNewScalarName] = useState("");
  const [newScalarBase, setNewScalarBase] = useState("string");

  const [showCreateUnion, setShowCreateUnion] = useState(false);
  const [newUnionName, setNewUnionName] = useState("");
  const [newUnionMembers, setNewUnionMembers] = useState("");

  // "New Custom Data Type": the kind is picked here, not in the parent's menu.
  const [showKindChooser, setShowKindChooser] = useState(false);

  function openCreateForm(kind: DomainTypeKind) {
    if (kind === "enum") {
      setActiveSubTab("enums");
      setShowCreateEnum(true);
    } else if (kind === "scalar") {
      setActiveSubTab("scalars");
      setShowCreateScalar(true);
    } else {
      setActiveSubTab("unions");
      setShowCreateUnion(true);
    }
  }

  useEffect(() => {
    if (!createIntent) return;

    if (createIntent === "choose") {
      setShowKindChooser(true);
    } else {
      openCreateForm(createIntent);
    }

    onCreateIntentConsumed?.();
  }, [createIntent, onCreateIntentConsumed]);

  async function handleCreateEnum() {
    if (!newEnumName.trim()) return;
    const values = newEnumValues.split(",").map((v) => v.trim()).filter(Boolean);
    const result = await createSharedEnumAction(domainId, { name: newEnumName.trim(), values }, target);
    if (result.error) { toast.error(result.error); } else { toast.success(`Enum "${newEnumName}" created`); setNewEnumName(""); setNewEnumValues(""); setShowCreateEnum(false); }
  }

  async function handleCreateScalar() {
    if (!newScalarName.trim()) return;
    const result = await createCustomScalarAction(domainId, { name: newScalarName.trim(), baseType: newScalarBase }, target);
    if (result.error) { toast.error(result.error); } else { toast.success(`Scalar "${newScalarName}" created`); setNewScalarName(""); setNewScalarBase("string"); setShowCreateScalar(false); }
  }

  async function handleCreateUnion() {
    if (!newUnionName.trim()) return;
    const members = newUnionMembers.split("|").map((v) => v.trim()).filter(Boolean);
    const result = await createUnionTypeAction(domainId, { name: newUnionName.trim(), memberTypes: members }, target);
    if (result.error) { toast.error(result.error); } else { toast.success(`Union "${newUnionName}" created`); setNewUnionName(""); setNewUnionMembers(""); setShowCreateUnion(false); }
  }

  // A group with nothing in it carries no information — hide it.
  const inheritedGroups = (inherited ?? []).filter(
    (g) => g.sharedEnums.length + g.customScalars.length + g.unionTypes.length > 0
  );

  const subTabs: { id: TypeSubTab; label: string; icon: typeof Hash; count: number }[] = [
    { id: "enums", label: "Enums", icon: Hash, count: sharedEnums.length },
    { id: "scalars", label: "Scalars", icon: Sigma, count: customScalars.length },
    { id: "unions", label: "Unions", icon: GitMerge, count: unionTypes.length },
  ];

  return (
    <div data-testid="domain-types-tab">
      {/* Delete confirmation dialog */}
      {deleteDialog.pending && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-background border border-border rounded-xl shadow-xl p-space-6 max-w-sm">
            <h3 className="text-heading-3 text-foreground mb-2">Delete "{deleteDialog.pending.name}"?</h3>
            <p className="text-body-small text-muted-foreground mb-4">This action cannot be undone.</p>
            <div className="flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={deleteDialog.cancel}>Cancel</Button>
              <Button variant="destructive" size="sm" onClick={deleteDialog.confirm}>Delete</Button>
            </div>
          </div>
        </div>
      )}

      <div className="flex gap-space-4">
        {/* Vertical sub-tabs */}
        <div className="w-[140px] shrink-0 space-y-1">
          {subTabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveSubTab(tab.id)}
              className={`flex items-center gap-2 w-full px-3 py-2 rounded-lg text-body-small transition-colors ${
                activeSubTab === tab.id
                  ? "bg-accent text-foreground font-medium"
                  : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
              }`}
            >
              <tab.icon className="w-3.5 h-3.5 shrink-0" />
              {tab.label}
              <Badge variant="secondary" className="text-[10px] h-4 px-1 ml-auto">{tab.count}</Badge>
            </button>
          ))}
        </div>

        {/* Content area */}
        <div className="flex-1 min-w-0">
          {showKindChooser && (
            <div
              data-testid="type-kind-chooser"
              role="group"
              aria-label="Choose a custom data type kind"
              className="rounded-lg border border-primary/30 bg-primary/5 p-3 mb-space-3 space-y-2"
            >
              <div>
                <div className="text-body-small font-semibold text-foreground">New Custom Data Type</div>
                <div className="text-caption text-muted-foreground">What kind of type do you want to create?</div>
              </div>
              <div className="flex items-center gap-1">
                {TYPE_KINDS.map(({ kind, label }) => (
                  <Button
                    key={kind}
                    size="sm"
                    variant="outline"
                    className="h-7 text-[11px]"
                    onClick={() => {
                      setShowKindChooser(false);
                      openCreateForm(kind);
                    }}
                  >
                    {label}
                  </Button>
                ))}
                <Button variant="ghost" size="sm" className="h-7 text-[11px] ml-auto" onClick={() => setShowKindChooser(false)}>
                  Cancel
                </Button>
              </div>
            </div>
          )}

          {/* Enums */}
          {activeSubTab === "enums" && (
            <div className="space-y-space-2">
              <div className="flex items-center justify-between mb-2">
                <h3 className="text-body-small font-semibold text-foreground">Shared Enums</h3>
                <Button size="sm" className="gap-1 h-7 text-[11px]" onClick={() => setShowCreateEnum(true)} disabled={showCreateEnum}>
                  <Plus className="w-3 h-3" /> New Enum
                </Button>
              </div>

              {showCreateEnum && (
                <div className="rounded-lg border border-primary/30 bg-primary/5 p-3 space-y-2">
                  <Input value={newEnumName} onChange={(e) => setNewEnumName(e.target.value)} placeholder="EnumName" className="h-7 font-mono text-caption" autoFocus />
                  <Input value={newEnumValues} onChange={(e) => setNewEnumValues(e.target.value)} placeholder="Value1, Value2, Value3" className="h-7 text-caption" />
                  <div className="flex justify-end gap-1">
                    <Button variant="ghost" size="sm" className="h-6 text-[10px]" onClick={() => setShowCreateEnum(false)}>Cancel</Button>
                    <Button size="sm" className="h-6 text-[10px]" onClick={handleCreateEnum} disabled={!newEnumName.trim()}>Create</Button>
                  </div>
                </div>
              )}

              {sharedEnums.length === 0 && !showCreateEnum && (
                <p className="text-caption text-muted-foreground/60 italic py-4">No shared enums — click "New Enum" to create one</p>
              )}

              {sharedEnums.map((e) => (
                <EnumCard key={e.id} e={e} onDelete={(name) => deleteDialog.ask(name, async () => {
                  const r = await deleteSharedEnumAction(e.id);
                  if (r.error) toast.error(r.error); else toast.success(`Enum "${name}" deleted`);
                })} />
              ))}
            </div>
          )}

          {/* Scalars */}
          {activeSubTab === "scalars" && (
            <div className="space-y-space-2">
              <div className="flex items-center justify-between mb-2">
                <h3 className="text-body-small font-semibold text-foreground">Custom Scalars</h3>
                <Button size="sm" className="gap-1 h-7 text-[11px]" onClick={() => setShowCreateScalar(true)} disabled={showCreateScalar}>
                  <Plus className="w-3 h-3" /> New Scalar
                </Button>
              </div>

              {showCreateScalar && (
                <div className="rounded-lg border border-primary/30 bg-primary/5 p-3 space-y-2">
                  <Input value={newScalarName} onChange={(e) => setNewScalarName(e.target.value)} placeholder="ScalarName" className="h-7 font-mono text-caption" autoFocus />
                  <select value={newScalarBase} onChange={(e) => setNewScalarBase(e.target.value)} className="h-7 w-full rounded-lg border border-border bg-popover px-2 text-caption">
                    <option value="string">extends string</option>
                    <option value="int32">extends int32</option>
                    <option value="int64">extends int64</option>
                    <option value="float64">extends float64</option>
                    <option value="decimal">extends decimal</option>
                    <option value="utcDateTime">extends utcDateTime</option>
                    <option value="bytes">extends bytes</option>
                  </select>
                  <div className="flex justify-end gap-1">
                    <Button variant="ghost" size="sm" className="h-6 text-[10px]" onClick={() => setShowCreateScalar(false)}>Cancel</Button>
                    <Button size="sm" className="h-6 text-[10px]" onClick={handleCreateScalar} disabled={!newScalarName.trim()}>Create</Button>
                  </div>
                </div>
              )}

              {customScalars.length === 0 && !showCreateScalar && (
                <p className="text-caption text-muted-foreground/60 italic py-4">No custom scalars — click "New Scalar" to create one</p>
              )}

              {customScalars.map((s) => (
                <div key={s.id} className="rounded-lg border border-border/30 p-space-3 hover:border-border transition-colors group/scalar">
                  <div className="flex items-center gap-space-2">
                    <span className="font-mono text-body-small text-foreground font-medium">{s.name}</span>
                    <ScalarTypeBadges s={s} />
                    <button
                      onClick={() => deleteDialog.ask(s.name, async () => {
                        const r = await deleteCustomScalarAction(s.id);
                        if (r.error) toast.error(r.error); else toast.success(`Scalar "${s.name}" deleted`);
                      })}
                      className="ml-auto opacity-0 group-hover/scalar:opacity-100 text-muted-foreground hover:text-destructive transition-opacity"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                  {s.description && <p className="text-caption text-muted-foreground mt-1">{s.description}</p>}
                </div>
              ))}
            </div>
          )}

          {/* Unions */}
          {activeSubTab === "unions" && (
            <div className="space-y-space-2">
              <div className="flex items-center justify-between mb-2">
                <h3 className="text-body-small font-semibold text-foreground">Union Types</h3>
                <Button size="sm" className="gap-1 h-7 text-[11px]" onClick={() => setShowCreateUnion(true)} disabled={showCreateUnion}>
                  <Plus className="w-3 h-3" /> New Union
                </Button>
              </div>

              {showCreateUnion && (
                <div className="rounded-lg border border-primary/30 bg-primary/5 p-3 space-y-2">
                  <Input value={newUnionName} onChange={(e) => setNewUnionName(e.target.value)} placeholder="UnionName" className="h-7 font-mono text-caption" autoFocus />
                  <Input value={newUnionMembers} onChange={(e) => setNewUnionMembers(e.target.value)} placeholder="TypeA | TypeB | TypeC" className="h-7 font-mono text-caption" />
                  <div className="flex justify-end gap-1">
                    <Button variant="ghost" size="sm" className="h-6 text-[10px]" onClick={() => setShowCreateUnion(false)}>Cancel</Button>
                    <Button size="sm" className="h-6 text-[10px]" onClick={handleCreateUnion} disabled={!newUnionName.trim()}>Create</Button>
                  </div>
                </div>
              )}

              {unionTypes.length === 0 && !showCreateUnion && (
                <p className="text-caption text-muted-foreground/60 italic py-4">No union types — click "New Union" to create one</p>
              )}

              {unionTypes.map((u) => (
                <UnionCard key={u.id} u={u} onDelete={(name) => deleteDialog.ask(name, async () => {
                  const r = await deleteUnionTypeAction(u.id);
                  if (r.error) toast.error(r.error); else toast.success(`Union "${name}" deleted`);
                })} />
              ))}
            </div>
          )}
        </div>
      </div>

      {inheritedGroups.map((group) => (
        <InheritedSection key={group.label} group={group} />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared scalar summary (editable and inherited cards render the same facts)
// ---------------------------------------------------------------------------

function ScalarTypeBadges({ s }: { s: CustomScalarData }) {
  return (
    <>
      <span className="text-caption text-muted-foreground">extends</span>
      <Badge variant="secondary" className="text-[10px] h-4 px-1.5 font-mono">{s.baseType}</Badge>
      {s.format && <Badge variant="outline" className="text-[10px] h-4 px-1.5 font-mono">format: {s.format}</Badge>}
      {s.pattern && <Badge variant="outline" className="text-[10px] h-4 px-1.5 font-mono">pattern: {s.pattern}</Badge>}
    </>
  );
}

// ---------------------------------------------------------------------------
// Read-only data types inherited from a broader level
// ---------------------------------------------------------------------------

function InheritedSection({ group }: { group: InheritedDataTypes }) {
  return (
    <section
      className="mt-space-6 border-t border-border/50 pt-space-4"
      data-testid="inherited-data-types"
    >
      <div className="flex items-center gap-space-2 mb-space-2">
        <h3 className="text-body-small font-semibold text-foreground">
          <Link href={group.href} className="hover:text-primary hover:underline">
            {group.label}
          </Link>
        </h3>
        <Badge variant="outline" className="text-[10px] h-4 px-1.5">Read-only</Badge>
      </div>
      <div className="space-y-space-2">
        {group.sharedEnums.map((e) => (
          <div key={e.id} className="rounded-lg border border-border/30 p-space-3">
            <div className="flex items-center gap-space-2 flex-wrap">
              <Hash className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
              <span className="font-mono text-body-small text-foreground font-medium">{e.name}</span>
              <span className="text-caption text-muted-foreground">enum</span>
              {e.values.map((v) => (
                <Badge key={v} variant="secondary" className="text-[10px] h-4 px-1.5 font-mono">{v}</Badge>
              ))}
            </div>
            {e.description && <p className="text-caption text-muted-foreground mt-1">{e.description}</p>}
          </div>
        ))}
        {group.customScalars.map((s) => (
          <div key={s.id} className="rounded-lg border border-border/30 p-space-3">
            <div className="flex items-center gap-space-2 flex-wrap">
              <Sigma className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
              <span className="font-mono text-body-small text-foreground font-medium">{s.name}</span>
              <ScalarTypeBadges s={s} />
            </div>
            {s.description && <p className="text-caption text-muted-foreground mt-1">{s.description}</p>}
          </div>
        ))}
        {group.unionTypes.map((u) => (
          <div key={u.id} className="rounded-lg border border-border/30 p-space-3">
            <div className="flex items-center gap-space-2 flex-wrap">
              <GitMerge className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
              <span className="font-mono text-body-small text-foreground font-medium">{u.name}</span>
              <span className="text-caption text-muted-foreground">=</span>
              {u.memberTypes.map((m) => (
                <Badge key={m} variant="secondary" className="text-[10px] h-4 px-1.5 font-mono">{m}</Badge>
              ))}
            </div>
            {u.description && <p className="text-caption text-muted-foreground mt-1">{u.description}</p>}
          </div>
        ))}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Editable Enum Card with delete
// ---------------------------------------------------------------------------

function EnumCard({ e, onDelete }: { e: SharedEnumData; onDelete: (name: string) => void }) {
  const [values, setValues] = useState(e.values);
  const [isAdding, setIsAdding] = useState(false);
  const [newValue, setNewValue] = useState("");

  async function addValue() {
    const trimmed = newValue.trim();
    if (!trimmed || values.includes(trimmed)) return;
    const updated = [...values, trimmed];
    setValues(updated);
    setNewValue("");
    setIsAdding(false);
    const result = await updateSharedEnumAction(e.id, { values: updated });
    if (result.error) { toast.error(result.error); setValues(e.values); }
  }

  async function removeValue(val: string) {
    const updated = values.filter((v) => v !== val);
    setValues(updated);
    const result = await updateSharedEnumAction(e.id, { values: updated });
    if (result.error) { toast.error(result.error); setValues(e.values); }
  }

  return (
    <div className="rounded-lg border border-border/30 p-space-3 hover:border-border transition-colors group/enum">
      <div className="flex items-center gap-space-2 mb-1">
        <span className="font-mono text-body-small text-foreground font-medium">{e.name}</span>
        <Badge variant="secondary" className="text-[10px] h-4 px-1">{values.length} values</Badge>
        <button
          onClick={() => onDelete(e.name)}
          className="ml-auto opacity-0 group-hover/enum:opacity-100 text-muted-foreground hover:text-destructive transition-opacity"
        >
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      </div>
      {e.description && <p className="text-caption text-muted-foreground mb-1.5">{e.description}</p>}
      <div className="flex flex-wrap gap-1">
        {values.map((v) => (
          <Badge key={v} variant="outline" className="text-[10px] h-5 px-1.5 font-mono gap-0.5">
            {v}
            <button onClick={() => removeValue(v)} className="hover:text-destructive ml-0.5"><X className="w-2.5 h-2.5" /></button>
          </Badge>
        ))}
        {isAdding ? (
          <input autoFocus value={newValue} onChange={(ev) => setNewValue(ev.target.value)}
            onKeyDown={(ev) => { if (ev.key === "Enter") addValue(); if (ev.key === "Escape") { setIsAdding(false); setNewValue(""); } }}
            onBlur={() => { if (newValue.trim()) addValue(); else setIsAdding(false); }}
            placeholder="value" className="h-5 w-20 rounded border border-input bg-transparent px-1.5 text-[10px] font-mono focus:outline-none focus:ring-1 focus:ring-ring" />
        ) : (
          <button onClick={() => setIsAdding(true)} className="flex items-center gap-0.5 h-5 px-1.5 rounded-full border border-dashed border-border text-[10px] text-muted-foreground hover:text-foreground hover:border-foreground/30 transition-colors">
            <Plus className="w-2.5 h-2.5" />
          </button>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Editable Union Card with delete
// ---------------------------------------------------------------------------

function UnionCard({ u, onDelete }: { u: UnionTypeData; onDelete: (name: string) => void }) {
  const [members, setMembers] = useState(u.memberTypes);
  const [isAdding, setIsAdding] = useState(false);
  const [newMember, setNewMember] = useState("");

  async function addMember() {
    const trimmed = newMember.trim();
    if (!trimmed || members.includes(trimmed)) return;
    const updated = [...members, trimmed];
    setMembers(updated);
    setNewMember("");
    setIsAdding(false);
    const result = await updateUnionTypeAction(u.id, { memberTypes: updated });
    if (result.error) { toast.error(result.error); setMembers(u.memberTypes); }
  }

  async function removeMember(val: string) {
    const updated = members.filter((m) => m !== val);
    setMembers(updated);
    const result = await updateUnionTypeAction(u.id, { memberTypes: updated });
    if (result.error) { toast.error(result.error); setMembers(u.memberTypes); }
  }

  return (
    <div className="rounded-lg border border-border/30 p-space-3 hover:border-border transition-colors group/union">
      <div className="flex items-center gap-space-2 mb-1">
        <span className="font-mono text-body-small text-foreground font-medium">{u.name}</span>
        <span className="text-caption text-muted-foreground">=</span>
        <button
          onClick={() => onDelete(u.name)}
          className="ml-auto opacity-0 group-hover/union:opacity-100 text-muted-foreground hover:text-destructive transition-opacity"
        >
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      </div>
      {u.description && <p className="text-caption text-muted-foreground mb-1.5">{u.description}</p>}
      <div className="flex flex-wrap gap-1">
        {members.map((m, i) => (
          <span key={m} className="flex items-center gap-0.5">
            {i > 0 && <span className="text-[10px] text-muted-foreground/50 mx-0.5">|</span>}
            <Badge variant="outline" className="text-[10px] h-5 px-1.5 font-mono gap-0.5">
              {m}
              <button onClick={() => removeMember(m)} className="hover:text-destructive ml-0.5"><X className="w-2.5 h-2.5" /></button>
            </Badge>
          </span>
        ))}
        {isAdding ? (
          <input autoFocus value={newMember} onChange={(ev) => setNewMember(ev.target.value)}
            onKeyDown={(ev) => { if (ev.key === "Enter") addMember(); if (ev.key === "Escape") { setIsAdding(false); setNewMember(""); } }}
            onBlur={() => { if (newMember.trim()) addMember(); else setIsAdding(false); }}
            placeholder="type" className="h-5 w-20 rounded border border-input bg-transparent px-1.5 text-[10px] font-mono focus:outline-none focus:ring-1 focus:ring-ring" />
        ) : (
          <button onClick={() => setIsAdding(true)} className="flex items-center gap-0.5 h-5 px-1.5 rounded-full border border-dashed border-border text-[10px] text-muted-foreground hover:text-foreground hover:border-foreground/30 transition-colors">
            <Plus className="w-2.5 h-2.5" />
          </button>
        )}
      </div>
    </div>
  );
}
