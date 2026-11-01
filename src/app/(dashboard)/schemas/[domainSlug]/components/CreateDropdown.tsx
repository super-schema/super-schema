"use client";

import { useState, useEffect, useRef } from "react";
import { ChevronDown, Plus, Puzzle } from "lucide-react";
import { EntityIcon, DataTypeIcon, ApiIcon, EventIcon } from "@/components/icons/feature-icons";
import { Button } from "@/components/ui/button";
import { NEW_PROPERTIES_DESCRIPTION, NEW_PROPERTIES_MENU } from "@/features/events/builder/labels";
import { useModKey } from "@/lib/platform";

// ---------------------------------------------------------------------------
// Create dropdown — New Entity, New Custom Data Type and (where the level allows
// them) New API, New Event (product level) and New Message Properties (Tenant /
// Domain library levels; "Trait" in brackets in its description). The kind of
// custom data type (Enum / Scalar / Union) is chosen on the Data Types tab, not
// listed here. Messages, channels and event specs are parts of an event, not menu entries.
// ---------------------------------------------------------------------------

export function CreateDropdown({
  onNewEntity,
  onNewCustomDataType,
  onNewApi,
  onNewEvent,
  onNewTrait,
}: {
  onNewEntity: () => void;
  onNewCustomDataType: () => void;
  /** Omit where APIs cannot be created (Enterprise level) to hide the item. */
  onNewApi?: () => void;
  /** Events are product-only; pass it only on the product workspace. */
  onNewEvent?: () => void;
  /** Library message properties live at the Tenant and Domain levels only; the product workspace does not pass it. */
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
    icon: EntityIcon,
    action: onNewEntity,
    description: "Schema entity with fields",
  };
  const customDataTypeItem: DropdownItem = {
    label: "New Custom Data Type",
    icon: DataTypeIcon,
    action: onNewCustomDataType,
    description: "Enum, scalar or union",
  };
  const apiItem: DropdownItem | null = onNewApi
    ? {
        label: "New API",
        icon: ApiIcon,
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
    optional("New Event", EventIcon, onNewEvent, "AsyncAPI event specification"),
    optional(NEW_PROPERTIES_MENU, Puzzle, onNewTrait, NEW_PROPERTIES_DESCRIPTION),
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
          {eventItems.map(renderItem)}
        </div>
      )}
    </div>
  );
}

