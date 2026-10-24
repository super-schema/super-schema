"use client";

import { useState, useRef, useEffect } from "react";
import { ChevronDown } from "lucide-react";
import {
  Command,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
} from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { getTypesByCategory, getTypeInfo, isComplexType, type DataType } from "@/lib/data-types";
import { TypeGrid } from "./TypeGrid";
import { ComplexTypePrompt, type ComplexTypeConfig, type PickableEntity } from "./ComplexTypePrompt";

/** The complex types that have a configuration prompt. */
export type PromptedComplexType = "array" | "map" | "reference" | "enum";

const ALL_PROMPTED_TYPES: ReadonlyArray<PromptedComplexType> = ["array", "map", "reference", "enum"];

interface TypePickerProps {
  value: string;
  onChange: (value: string) => void;
  className?: string;
  compact?: boolean;
  /**
   * Called when a complex type (array/map/reference/enum) is configured, AFTER `onChange(type)` with the same type: the caller that wants
   * to write the type and its configuration in one update does it here and ignores that `onChange`.
   */
  onComplexTypeConfig?: (type: string, config: ComplexTypeConfig) => void;
  /** Which complex types open their prompt when `onComplexTypeConfig` is given (default: all four); the others are chosen directly. */
  promptTypes?: ReadonlyArray<PromptedComplexType>;
  /** If true, hide complex types from selection */
  excludeComplex?: boolean;
  /**
   * Available entities for the reference prompt, which lists them as `domain / product / entity`. Without a reference prompt they are also
   * listed in the type search (choosing one sets the type to the entity's name).
   */
  entities?: PickableEntity[];
  /** Disable the picker */
  disabled?: boolean;
}

type PickerView = "grid" | "search" | "complex";

/**
 * The popup body is its own component so the type list (and its elements) is
 * only built while the popover is open; a field list mounts one picker per row.
 */
function TypePickerBody({
  view,
  complexType,
  value,
  searchQuery,
  onSearchQueryChange,
  excludeComplex,
  entities,
  searchEntities,
  onSelect,
  onComplexConfirm,
  onComplexBack,
}: {
  view: PickerView;
  complexType: PromptedComplexType | null;
  value: string;
  searchQuery: string;
  onSearchQueryChange: (query: string) => void;
  excludeComplex?: boolean;
  /** The entities the reference prompt lists. */
  entities?: PickableEntity[];
  /** The entities the type search lists as types (none when the reference prompt is the way to choose one). */
  searchEntities?: PickableEntity[];
  onSelect: (typeId: string) => void;
  onComplexConfirm: (config: ComplexTypeConfig) => void;
  onComplexBack: () => void;
}) {
  const categories = getTypesByCategory();

  function getIndent(type: DataType): string {
    if (!type.parent) return "";
    const parentType = getTypeInfo(type.parent);
    if (parentType?.parent) return "pl-6";
    return "pl-3";
  }

  return view === "complex" && complexType ? (
    <ComplexTypePrompt
      complexType={complexType}
      onConfirm={onComplexConfirm}
      onBack={onComplexBack}
      entities={entities}
    />
  ) : (
    <Command shouldFilter={false}>
      <CommandInput
        placeholder="Search types..."
        value={searchQuery}
        onValueChange={onSearchQueryChange}
      />
      {view === "grid" && !searchQuery.trim() ? (
        <div className="max-h-[480px] overflow-y-auto">
          <TypeGrid
            value={value}
            onSelect={onSelect}
            excludeComplex={excludeComplex}
          />
        </div>
      ) : (
        <CommandList>
          <CommandEmpty>No type found.</CommandEmpty>
          {categories.map(({ category, types }) => {
            const filteredTypes = excludeComplex
              ? types.filter((t) => !isComplexType(t.id))
              : types;

            // Filter by search query
            const matchingTypes = searchQuery.trim()
              ? filteredTypes.filter(
                  (t) =>
                    t.id.toLowerCase().includes(searchQuery.toLowerCase()) ||
                    t.label.toLowerCase().includes(searchQuery.toLowerCase()) ||
                    t.typespecScalar.toLowerCase().includes(searchQuery.toLowerCase()) ||
                    t.description.toLowerCase().includes(searchQuery.toLowerCase())
                )
              : filteredTypes;

            if (matchingTypes.length === 0) return null;

            return (
              <CommandGroup key={category} heading={category}>
                {matchingTypes.map((type) => (
                  <CommandItem
                    key={type.id}
                    value={`${type.id} ${type.label} ${type.typespecScalar}`}
                    onSelect={() => onSelect(type.id)}
                    data-checked={value === type.id ? "true" : undefined}
                    className={getIndent(type)}
                  >
                    <div className="flex flex-col gap-0">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-xs">{type.label}</span>
                        {type.typespecScalar !== type.id && (
                          <span className="text-[10px] text-muted-foreground/60">
                            {type.typespecScalar}
                          </span>
                        )}
                      </div>
                      <span className="text-[10px] text-muted-foreground/50 leading-tight">
                        {type.description}
                      </span>
                    </div>
                  </CommandItem>
                ))}
              </CommandGroup>
            );
          })}
          {/* Entity types */}
          {searchEntities && searchEntities.length > 0 && (() => {
            const matchingEntities = searchQuery.trim()
              ? searchEntities.filter((e) => e.name.toLowerCase().includes(searchQuery.toLowerCase()))
              : searchEntities;
            if (matchingEntities.length === 0) return null;
            return (
              <CommandGroup heading="Entities">
                {matchingEntities.map((ent) => (
                  <CommandItem
                    key={ent.id}
                    value={ent.name}
                    onSelect={() => onSelect(ent.name)}
                    data-checked={value === ent.name ? "true" : undefined}
                  >
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-xs">{ent.name}</span>
                      <span className="text-[10px] text-muted-foreground/60">entity reference</span>
                    </div>
                  </CommandItem>
                ))}
              </CommandGroup>
            );
          })()}
        </CommandList>
      )}
    </Command>
  );
}

export function TypePicker({
  value,
  onChange,
  className,
  compact,
  onComplexTypeConfig,
  promptTypes = ALL_PROMPTED_TYPES,
  excludeComplex,
  entities,
  disabled,
}: TypePickerProps) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<PickerView>("grid");
  const [searchQuery, setSearchQuery] = useState("");
  const [complexType, setComplexType] = useState<PromptedComplexType | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const prompts = (typeId: string): typeId is PromptedComplexType =>
    onComplexTypeConfig !== undefined && (promptTypes as ReadonlyArray<string>).includes(typeId);

  const selectedType = getTypeInfo(value);

  // Reset view when popover opens/closes
  useEffect(() => {
    if (open) {
      setView("grid");
      setSearchQuery("");
      setComplexType(null);
    }
  }, [open]);

  // Switch to search view when user types
  useEffect(() => {
    if (searchQuery.trim()) {
      setView("search");
    } else if (view === "search") {
      setView("grid");
    }
  }, [searchQuery]); // eslint-disable-line react-hooks/exhaustive-deps

  function handleSelect(typeId: string) {
    if (prompts(typeId)) {
      setComplexType(typeId);
      setView("complex");
      return;
    }

    onChange(typeId);
    setOpen(false);
  }

  function handleComplexConfirm(config: ComplexTypeConfig) {
    if (complexType) {
      onChange(complexType);
      onComplexTypeConfig?.(complexType, config);
      setOpen(false);
    }
  }

  function handleComplexBack() {
    setComplexType(null);
    setView("grid");
  }

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open]);

  return (
    <Popover open={open} onOpenChange={disabled ? undefined : setOpen}>
      <PopoverTrigger
        ref={triggerRef}
        disabled={disabled}
        className={`flex items-center gap-1 bg-transparent text-body-small outline-none cursor-pointer hover:text-foreground transition-colors ${
          compact ? "text-muted-foreground" : "h-7 bg-muted rounded px-2 text-muted-foreground w-full justify-between"
        } ${disabled ? "opacity-50 cursor-not-allowed" : ""} ${className ?? ""}`}
      >
        <span className="truncate">{selectedType?.label ?? value}</span>
        <ChevronDown className="w-3 h-3 shrink-0 opacity-50" />
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className={`p-0 ${view === "complex" ? "w-80" : "w-[420px]"}`}
      >
        <TypePickerBody
          view={view}
          complexType={complexType}
          value={value}
          searchQuery={searchQuery}
          onSearchQueryChange={setSearchQuery}
          excludeComplex={excludeComplex}
          entities={entities}
          // With the reference prompt, choosing an entity goes through it (its id and qualified name); listing entities as TYPES too would set
          // the field's type to an entity's name.
          searchEntities={prompts("reference") ? undefined : entities}
          onSelect={handleSelect}
          onComplexConfirm={handleComplexConfirm}
          onComplexBack={handleComplexBack}
        />
      </PopoverContent>
    </Popover>
  );
}
