"use client";

import { useState, useEffect, useRef } from "react";
import { ChevronDown, Database, FileCode2, Globe, Hash, Mail, Plus, Puzzle, Radio } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useModKey } from "@/lib/platform";

// ---------------------------------------------------------------------------
// Create dropdown — New Entity, New Custom Data Type and (where the level allows
// them) New API and the events items (Event Spec / Message / Channel / Trait). The
// kind of custom data type (Enum / Scalar / Union) is chosen on the Data Types
// tab, not listed here.
// ---------------------------------------------------------------------------

export function CreateDropdown({
  onNewEntity,
  onNewCustomDataType,
  onNewApi,
  onNewEventSpec,
  onNewMessage,
  onNewChannel,
  onNewTrait,
}: {
  onNewEntity: () => void;
  onNewCustomDataType: () => void;
  /** Omit where APIs cannot be created (Enterprise level) to hide the item. */
  onNewApi?: () => void;
  /** Events kinds are product-only (spec §4.1); pass them only on the product workspace. */
  onNewEventSpec?: () => void;
  onNewMessage?: () => void;
  onNewChannel?: () => void;
  /** Traits exist at every level. */
  onNewTrait?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const mod = useModKey();

  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  type DropdownItem = {
    label: string;
    icon: React.ComponentType<{ className?: string }>;
    action: () => void;
    description: string;
  };

  const entityItem: DropdownItem = {
    label: "New Entity",
    icon: Database,
    action: onNewEntity,
    description: "Schema entity with fields",
  };
  const customDataTypeItem: DropdownItem = {
    label: "New Custom Data Type",
    icon: Hash,
    action: onNewCustomDataType,
    description: "Enum, scalar or union",
  };
  const apiItem: DropdownItem | null = onNewApi
    ? {
        label: "New API",
        icon: Globe,
        action: onNewApi,
        description: "API service definition",
      }
    : null;
  const optional = (
    label: string,
    icon: DropdownItem["icon"],
    action: (() => void) | undefined,
    description: string
  ): DropdownItem | null => (action ? { label, icon, action, description } : null);
  const eventItems = [
    optional("New Event Spec", FileCode2, onNewEventSpec, "AsyncAPI event specification"),
    optional("New Message", Mail, onNewMessage, "Event message with a pinned payload"),
    optional("New Channel", Radio, onNewChannel, "Topic / queue with a format profile"),
    optional("New Trait", Puzzle, onNewTrait, "Reusable message or operation trait"),
  ].filter((item): item is DropdownItem => item !== null);

  function renderItem(item: DropdownItem) {
    return (
      <button
        key={item.label}
        role="menuitem"
        onClick={() => { item.action(); setOpen(false); }}
        className="flex items-start gap-2 w-full text-left py-2 px-3 hover:bg-accent transition-colors"
      >
        <item.icon className="w-4 h-4 text-muted-foreground mt-0.5 shrink-0" />
        <div>
          <div className="text-body-small text-foreground">{item.label}</div>
          <div className="text-[10px] text-muted-foreground">{item.description}</div>
        </div>
      </button>
    );
  }

  return (
    <div className="relative" ref={ref}>
      <div className="flex">
        <Button onClick={onNewEntity} className="gap-2 rounded-r-none" title={`New Entity (${mod}+N)`}>
          <Plus className="w-4 h-4" />
          New Entity
        </Button>
        <Button
          onClick={() => setOpen(!open)}
          className="px-1.5 rounded-l-none border-l border-primary-foreground/20"
          title="More options"
        >
          <ChevronDown className={`w-3.5 h-3.5 transition-transform ${open ? "rotate-180" : ""}`} />
        </Button>
      </div>
      {open && (
        <div role="menu" className="absolute right-0 top-full mt-1 z-50 bg-popover border border-border rounded-lg shadow-lg py-1 min-w-[220px]">
          {renderItem(entityItem)}
          {renderItem(customDataTypeItem)}
          {apiItem && renderItem(apiItem)}
          {eventItems.length > 0 && <div role="separator" className="my-1 border-t border-border" />}
          {eventItems.map(renderItem)}
        </div>
      )}
    </div>
  );
}

