"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import {
  Command,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
} from "@/components/ui/command";
import { Database, Clock, Zap } from "lucide-react";

interface CommandPaletteProps {
  entities?: { id: string; name: string; domainName: string; domainSlug: string }[];
}

export function CommandPalette({ entities = [] }: CommandPaletteProps) {
  const [open, setOpen] = useState(false);
  const router = useRouter();

  // Get recent entities from localStorage
  const getRecent = useCallback((): string[] => {
    if (typeof window === "undefined") return [];
    try {
      return JSON.parse(localStorage.getItem("super-schema:recent-entities") || "[]");
    } catch {
      return [];
    }
  }, []);

  // Cmd+K / Ctrl+K listener
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setOpen((prev) => !prev);
      }
      if (e.key === "Escape") {
        setOpen(false);
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, []);

  function navigateToEntity(entityId: string, domainSlug: string) {
    // Track recent
    const recent = getRecent().filter((id) => id !== entityId);
    recent.unshift(entityId);
    localStorage.setItem(
      "super-schema:recent-entities",
      JSON.stringify(recent.slice(0, 5))
    );

    router.push(`/schemas/${domainSlug}/${entityId}`);
    setOpen(false);
  }

  if (!open) return null;

  const recentIds = new Set(getRecent());
  const recentEntities = entities.filter((e) => recentIds.has(e.id));

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[20vh]">
      {/* Backdrop */}
      <div
        className="absolute inset-0 surface-overlay"
        onClick={() => setOpen(false)}
      />

      {/* Command dialog */}
      <div className="relative w-full max-w-lg surface-glass rounded-xl border border-border shadow-2xl overflow-hidden">
        <Command className="bg-transparent">
          <CommandInput
            placeholder="Search entities, actions..."
            className="h-12 text-body border-b border-border"
          />
          <CommandList className="max-h-80 overflow-y-auto">
            <CommandEmpty className="py-6 text-center text-body-small text-muted-foreground">
              No results found.
            </CommandEmpty>

            {recentEntities.length > 0 && (
              <CommandGroup heading="Recent">
                {recentEntities.map((entity) => (
                  <CommandItem
                    key={`recent-${entity.id}`}
                    onSelect={() => navigateToEntity(entity.id, entity.domainSlug)}
                    className="gap-2 cursor-pointer"
                  >
                    <Clock className="w-4 h-4 text-muted-foreground" />
                    <span className="font-mono">{entity.name}</span>
                    <span className="text-caption text-muted-foreground ml-auto">
                      {entity.domainName}
                    </span>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}

            <CommandGroup heading="Entities">
              {entities.map((entity) => (
                <CommandItem
                  key={entity.id}
                  onSelect={() => navigateToEntity(entity.id, entity.domainSlug)}
                  className="gap-2 cursor-pointer"
                >
                  <Database className="w-4 h-4 text-muted-foreground" />
                  <span className="font-mono">{entity.name}</span>
                  <span className="text-caption text-muted-foreground ml-auto">
                    {entity.domainName}
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>

            <CommandGroup heading="Actions">
              <CommandItem
                onSelect={() => { router.push("/schemas"); setOpen(false); }}
                className="gap-2 cursor-pointer"
              >
                <Zap className="w-4 h-4 text-muted-foreground" />
                Go to Domains
              </CommandItem>
            </CommandGroup>
          </CommandList>
        </Command>
      </div>
    </div>
  );
}
