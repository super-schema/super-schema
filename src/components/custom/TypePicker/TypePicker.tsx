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
import { ComplexTypePrompt, type ComplexTypeConfig } from "./ComplexTypePrompt";

interface TypePickerProps {
  value: string;
  onChange: (value: string) => void;
  className?: string;
  compact?: boolean;
  /** Called when a complex type (array/map/reference/enum) is configured */
  onComplexTypeConfig?: (type: string, config: ComplexTypeConfig) => void;
  /** If true, hide complex types from selection */
  excludeComplex?: boolean;
  /** Available entities for reference type picker */
  entities?: { id: string; name: string }[];
  /** Disable the picker */
  disabled?: boolean;
}

type PickerView = "grid" | "search" | "complex";

export function TypePicker({
  value,
  onChange,
  className,
  compact,
  onComplexTypeConfig,
  excludeComplex,
  entities,
  disabled,
}: TypePickerProps) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<PickerView>("grid");
  const [searchQuery, setSearchQuery] = useState("");
  const [complexType, setComplexType] = useState<"array" | "map" | "reference" | "enum" | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const categories = getTypesByCategory();
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
    const COMPLEX_TYPES_WITH_PROMPT = new Set(["array", "map", "reference", "enum"]);

    if (COMPLEX_TYPES_WITH_PROMPT.has(typeId) && onComplexTypeConfig) {
      setComplexType(typeId as "array" | "map" | "reference" | "enum");
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

  function getIndent(type: DataType): string {
    if (!type.parent) return "";
    const parentType = getTypeInfo(type.parent);
    if (parentType?.parent) return "pl-6";
    return "pl-3";
  }

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
        {view === "complex" && complexType ? (
          <ComplexTypePrompt
            complexType={complexType}
            onConfirm={handleComplexConfirm}
            onBack={handleComplexBack}
            entities={entities}
          />
        ) : (
          <Command shouldFilter={false}>
            <CommandInput
              placeholder="Search types..."
              value={searchQuery}
              onValueChange={setSearchQuery}
            />
            {view === "grid" && !searchQuery.trim() ? (
              <div className="max-h-[480px] overflow-y-auto">
                <TypeGrid
                  value={value}
                  onSelect={handleSelect}
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
                          onSelect={() => handleSelect(type.id)}
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
              </CommandList>
            )}
          </Command>
        )}
      </PopoverContent>
    </Popover>
  );
}
