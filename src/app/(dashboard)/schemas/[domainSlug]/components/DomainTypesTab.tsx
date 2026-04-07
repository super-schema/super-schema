"use client";

import { useState } from "react";
import { ChevronDown, ChevronRight, Hash, Sigma, GitMerge, Plus, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import {
  updateSharedEnumAction,
  updateUnionTypeAction,
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

interface DomainTypesTabProps {
  sharedEnums: SharedEnumData[];
  customScalars: CustomScalarData[];
  unionTypes: UnionTypeData[];
}

// ---------------------------------------------------------------------------
// Collapsible section wrapper
// ---------------------------------------------------------------------------

function TypeSection({
  title,
  icon: Icon,
  count,
  defaultOpen,
  children,
}: {
  title: string;
  icon: React.ComponentType<{ className?: string }>;
  count: number;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen ?? count > 0);

  return (
    <div className="border border-border/50 rounded-lg overflow-hidden">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-space-2 w-full px-space-4 py-space-3 hover:bg-muted/30 transition-colors"
      >
        {open ? (
          <ChevronDown className="w-3.5 h-3.5 text-muted-foreground" />
        ) : (
          <ChevronRight className="w-3.5 h-3.5 text-muted-foreground" />
        )}
        <Icon className="w-4 h-4 text-muted-foreground" />
        <span className="text-body-small font-medium text-foreground">{title}</span>
        <Badge variant="secondary" className="text-[10px] h-4 px-1.5 ml-auto">
          {count}
        </Badge>
      </button>
      {open && <div className="border-t border-border/30 px-space-4 py-space-3">{children}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Editable Enum Card
// ---------------------------------------------------------------------------

function EnumCard({ e }: { e: SharedEnumData }) {
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
    if (result.error) {
      toast.error(result.error);
      setValues(e.values); // revert
    }
  }

  async function removeValue(val: string) {
    const updated = values.filter((v) => v !== val);
    setValues(updated);
    const result = await updateSharedEnumAction(e.id, { values: updated });
    if (result.error) {
      toast.error(result.error);
      setValues(e.values); // revert
    }
  }

  return (
    <div className="rounded-lg border border-border/30 p-space-3 hover:border-border transition-colors">
      <div className="flex items-center gap-space-2 mb-1">
        <span className="font-mono text-body-small text-foreground font-medium">{e.name}</span>
        <Badge variant="secondary" className="text-[10px] h-4 px-1">
          {values.length} values
        </Badge>
      </div>
      {e.description && (
        <p className="text-caption text-muted-foreground mb-1.5">{e.description}</p>
      )}
      <div className="flex flex-wrap gap-1">
        {values.map((v) => (
          <Badge key={v} variant="outline" className="text-[10px] h-5 px-1.5 font-mono gap-0.5">
            {v}
            <button
              onClick={() => removeValue(v)}
              className="hover:text-destructive ml-0.5"
              title={`Remove ${v}`}
            >
              <X className="w-2.5 h-2.5" />
            </button>
          </Badge>
        ))}
        {isAdding ? (
          <input
            autoFocus
            value={newValue}
            onChange={(e) => setNewValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") addValue();
              if (e.key === "Escape") { setIsAdding(false); setNewValue(""); }
            }}
            onBlur={() => { if (newValue.trim()) addValue(); else setIsAdding(false); }}
            placeholder="value"
            className="h-5 w-20 rounded border border-input bg-transparent px-1.5 text-[10px] font-mono focus:outline-none focus:ring-1 focus:ring-ring"
          />
        ) : (
          <button
            onClick={() => setIsAdding(true)}
            className="flex items-center gap-0.5 h-5 px-1.5 rounded-full border border-dashed border-border text-[10px] text-muted-foreground hover:text-foreground hover:border-foreground/30 transition-colors"
          >
            <Plus className="w-2.5 h-2.5" />
          </button>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Editable Union Card
// ---------------------------------------------------------------------------

function UnionCard({ u }: { u: UnionTypeData }) {
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
    if (result.error) {
      toast.error(result.error);
      setMembers(u.memberTypes);
    }
  }

  async function removeMember(val: string) {
    const updated = members.filter((m) => m !== val);
    setMembers(updated);
    const result = await updateUnionTypeAction(u.id, { memberTypes: updated });
    if (result.error) {
      toast.error(result.error);
      setMembers(u.memberTypes);
    }
  }

  return (
    <div className="rounded-lg border border-border/30 p-space-3 hover:border-border transition-colors">
      <div className="flex items-center gap-space-2 mb-1">
        <span className="font-mono text-body-small text-foreground font-medium">{u.name}</span>
        <span className="text-caption text-muted-foreground">=</span>
      </div>
      {u.description && (
        <p className="text-caption text-muted-foreground mb-1.5">{u.description}</p>
      )}
      <div className="flex flex-wrap gap-1">
        {members.map((m, i) => (
          <span key={m} className="flex items-center gap-0.5">
            {i > 0 && <span className="text-[10px] text-muted-foreground/50 mx-0.5">|</span>}
            <Badge variant="outline" className="text-[10px] h-5 px-1.5 font-mono gap-0.5">
              {m}
              <button
                onClick={() => removeMember(m)}
                className="hover:text-destructive ml-0.5"
                title={`Remove ${m}`}
              >
                <X className="w-2.5 h-2.5" />
              </button>
            </Badge>
          </span>
        ))}
        {isAdding ? (
          <input
            autoFocus
            value={newMember}
            onChange={(e) => setNewMember(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") addMember();
              if (e.key === "Escape") { setIsAdding(false); setNewMember(""); }
            }}
            onBlur={() => { if (newMember.trim()) addMember(); else setIsAdding(false); }}
            placeholder="type"
            className="h-5 w-20 rounded border border-input bg-transparent px-1.5 text-[10px] font-mono focus:outline-none focus:ring-1 focus:ring-ring"
          />
        ) : (
          <button
            onClick={() => setIsAdding(true)}
            className="flex items-center gap-0.5 h-5 px-1.5 rounded-full border border-dashed border-border text-[10px] text-muted-foreground hover:text-foreground hover:border-foreground/30 transition-colors"
          >
            <Plus className="w-2.5 h-2.5" />
          </button>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function DomainTypesTab({ sharedEnums, customScalars, unionTypes }: DomainTypesTabProps) {
  const totalCount = sharedEnums.length + customScalars.length + unionTypes.length;

  if (totalCount === 0) {
    return (
      <div className="text-center py-16 text-muted-foreground">
        <Hash className="w-8 h-8 mx-auto mb-2 text-muted-foreground/30" />
        <p className="text-body-small">No reusable types defined yet</p>
        <p className="text-caption mt-1">
          Import a TypeSpec file or create shared enums, scalars, and unions to see them here.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-space-3" data-testid="domain-types-tab">
      {/* Enums section */}
      <TypeSection title="Enums" icon={Hash} count={sharedEnums.length}>
        {sharedEnums.length === 0 ? (
          <p className="text-caption text-muted-foreground/60 italic">No shared enums</p>
        ) : (
          <div className="space-y-space-2">
            {sharedEnums.map((e) => (
              <EnumCard key={e.id} e={e} />
            ))}
          </div>
        )}
      </TypeSection>

      {/* Custom Scalars section */}
      <TypeSection title="Custom Scalars" icon={Sigma} count={customScalars.length}>
        {customScalars.length === 0 ? (
          <p className="text-caption text-muted-foreground/60 italic">No custom scalars</p>
        ) : (
          <div className="space-y-space-2">
            {customScalars.map((s) => (
              <div key={s.id} className="rounded-lg border border-border/30 p-space-3 hover:border-border transition-colors">
                <div className="flex items-center gap-space-2 mb-1">
                  <span className="font-mono text-body-small text-foreground font-medium">{s.name}</span>
                  <span className="text-caption text-muted-foreground">extends</span>
                  <Badge variant="secondary" className="text-[10px] h-4 px-1.5 font-mono">
                    {s.baseType}
                  </Badge>
                  {s.format && (
                    <Badge variant="outline" className="text-[10px] h-4 px-1.5 font-mono">
                      format: {s.format}
                    </Badge>
                  )}
                  {s.pattern && (
                    <Badge variant="outline" className="text-[10px] h-4 px-1.5 font-mono">
                      pattern: {s.pattern}
                    </Badge>
                  )}
                </div>
                {s.description && (
                  <p className="text-caption text-muted-foreground">{s.description}</p>
                )}
              </div>
            ))}
          </div>
        )}
      </TypeSection>

      {/* Unions section */}
      <TypeSection title="Unions" icon={GitMerge} count={unionTypes.length}>
        {unionTypes.length === 0 ? (
          <p className="text-caption text-muted-foreground/60 italic">No union types</p>
        ) : (
          <div className="space-y-space-2">
            {unionTypes.map((u) => (
              <UnionCard key={u.id} u={u} />
            ))}
          </div>
        )}
      </TypeSection>
    </div>
  );
}
