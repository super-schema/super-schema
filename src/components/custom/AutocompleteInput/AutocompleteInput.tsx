"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { Input } from "@/components/ui/input";
import type { AutocompleteSuggestion } from "@/lib/autocomplete/field-name-autocomplete";

interface AutocompleteInputProps {
  value: string;
  onChange: (value: string) => void;
  onSelect?: (suggestion: AutocompleteSuggestion) => void;
  getSuggestions: (query: string) => AutocompleteSuggestion[];
  placeholder?: string;
  className?: string;
  autoFocus?: boolean;
  onKeyDown?: (e: React.KeyboardEvent<HTMLInputElement>) => void;
}

export function AutocompleteInput({
  value,
  onChange,
  onSelect,
  getSuggestions,
  placeholder,
  className,
  autoFocus,
  onKeyDown: externalKeyDown,
}: AutocompleteInputProps) {
  const [suggestions, setSuggestions] = useState<AutocompleteSuggestion[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [isOpen, setIsOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const updateSuggestions = useCallback(
    (query: string) => {
      if (!query || query.length < 1) {
        setSuggestions([]);
        setIsOpen(false);
        return;
      }
      const results = getSuggestions(query);
      setSuggestions(results);
      setSelectedIndex(0);
      setIsOpen(results.length > 0);
    },
    [getSuggestions]
  );

  useEffect(() => {
    updateSuggestions(value);
    // Auto-close if the value exactly matches a suggestion (user finished typing)
    if (value && suggestions.some((s) => s.value.toLowerCase() === value.toLowerCase())) {
      // Keep open briefly for selection, then close
      const timer = setTimeout(() => setIsOpen(false), 1500);
      return () => clearTimeout(timer);
    }
  }, [value, updateSuggestions]); // eslint-disable-line react-hooks/exhaustive-deps

  function handleSelect(suggestion: AutocompleteSuggestion) {
    onChange(suggestion.value);
    setIsOpen(false);
    setSuggestions([]);
    onSelect?.(suggestion);
    inputRef.current?.focus();
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (isOpen && suggestions.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIndex((prev) => Math.min(prev + 1, suggestions.length - 1));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIndex((prev) => Math.max(prev - 1, 0));
        return;
      }
      if (e.key === "Enter" && suggestions[selectedIndex]) {
        e.preventDefault();
        handleSelect(suggestions[selectedIndex]);
        return;
      }
    }
    if (e.key === "Escape") {
      setIsOpen(false);
    }
    externalKeyDown?.(e);
  }

  // Scroll selected item into view
  useEffect(() => {
    if (!listRef.current) return;
    const item = listRef.current.children[selectedIndex] as HTMLElement;
    item?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  const sourceColors: Record<string, string> = {
    standard: "text-info",
    domain: "text-primary",
    pattern: "text-muted-foreground",
  };

  return (
    <div className="relative">
      <Input
        ref={inputRef}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={handleKeyDown}
        onBlur={() => {
          // Delay to allow click on suggestion
          setTimeout(() => setIsOpen(false), 200);
        }}
        onFocus={() => {
          if (value && suggestions.length > 0) setIsOpen(true);
        }}
        placeholder={placeholder}
        className={className}
        autoFocus={autoFocus}
      />

      {isOpen && suggestions.length > 0 && (
        <div
          ref={listRef}
          className="absolute z-50 top-full mt-1 w-full max-h-[160px] overflow-y-auto rounded-xl border border-border bg-popover shadow-lg pointer-events-auto"
        >
          {suggestions.map((suggestion, i) => (
            <button
              key={`${suggestion.value}-${suggestion.source}`}
              type="button"
              className={`w-full flex items-center gap-2 px-3 py-1.5 text-left transition-colors ${
                i === selectedIndex ? "bg-accent" : "hover:bg-accent/50"
              }`}
              onMouseDown={(e) => {
                e.preventDefault(); // prevent blur
                handleSelect(suggestion);
              }}
              onMouseEnter={() => setSelectedIndex(i)}
            >
              <span className="font-mono text-body-small text-foreground truncate">
                {highlightMatch(suggestion.value, value)}
              </span>
              {suggestion.sourceLabel && (
                <span className="text-[10px] text-muted-foreground truncate">
                  {suggestion.sourceLabel}
                </span>
              )}
              {!suggestion.sourceLabel && (
                <span className={`text-[10px] ${sourceColors[suggestion.source] ?? "text-muted-foreground"}`}>
                  {suggestion.source}
                </span>
              )}
              {suggestion.suggestedType && (
                <span className="text-[10px] text-muted-foreground ml-auto shrink-0">
                  {suggestion.suggestedType}
                </span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function highlightMatch(text: string, query: string): React.ReactNode {
  if (!query) return text;
  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return text;
  return (
    <>
      {text.slice(0, idx)}
      <span className="bg-primary/20 rounded-sm">{text.slice(idx, idx + query.length)}</span>
      {text.slice(idx + query.length)}
    </>
  );
}
