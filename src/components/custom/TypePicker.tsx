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
import { getTypesByCategory, getTypeInfo, type DataType } from "@/lib/data-types";

interface TypePickerProps {
  value: string;
  onChange: (value: string) => void;
  className?: string;
  compact?: boolean;
}

export function TypePicker({ value, onChange, className, compact }: TypePickerProps) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const categories = getTypesByCategory();
  const selectedType = getTypeInfo(value);

  function handleSelect(typeId: string) {
    onChange(typeId);
    setOpen(false);
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
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        ref={triggerRef}
        className={`flex items-center gap-1 bg-transparent text-body-small outline-none cursor-pointer hover:text-foreground transition-colors ${
          compact ? "text-muted-foreground" : "h-7 bg-muted rounded px-2 text-muted-foreground w-full justify-between"
        } ${className ?? ""}`}
      >
        <span className="truncate">{selectedType?.label ?? value}</span>
        <ChevronDown className="w-3 h-3 shrink-0 opacity-50" />
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-64 p-0"
      >
        <Command>
          <CommandInput placeholder="Search types..." />
          <CommandList>
            <CommandEmpty>No type found.</CommandEmpty>
            {categories.map(({ category, types }) => (
              <CommandGroup key={category} heading={category}>
                {types.map((type) => (
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
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
