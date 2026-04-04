"use client";

import { useEffect } from "react";

interface KeyboardShortcutHandlers {
  onSave?: () => void;
  onNewEntity?: () => void;
  onEmit?: () => void;
  onSlashCommand?: () => void;
  onEscape?: () => void;
}

function isInputFocused(): boolean {
  const el = document.activeElement;
  if (!el) return false;
  const tag = el.tagName.toLowerCase();
  if (tag === "input" || tag === "textarea") return true;
  if ((el as HTMLElement).isContentEditable) return true;
  // Also check for cmdk-input (command palette search)
  if (el.getAttribute("data-slot") === "command-input") return true;
  return false;
}

/**
 * Registers global keyboard shortcuts for the dashboard.
 * Shortcuts are only active when no input element is focused
 * (except Cmd+S and Cmd+E which always fire with preventDefault).
 */
export function useKeyboardShortcuts(handlers: KeyboardShortcutHandlers) {
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const mod = e.metaKey || e.ctrlKey;

      // Cmd+S — always prevent browser save, fire handler
      if (mod && e.key === "s") {
        e.preventDefault();
        handlers.onSave?.();
        return;
      }

      // Cmd+N — always prevent browser new window
      if (mod && e.key === "n") {
        e.preventDefault();
        handlers.onNewEntity?.();
        return;
      }

      // Cmd+E — always prevent
      if (mod && e.key === "e") {
        e.preventDefault();
        handlers.onEmit?.();
        return;
      }

      // Escape — close panels (works even in inputs via command palette's own handler)
      if (e.key === "Escape") {
        handlers.onEscape?.();
        return;
      }

      // "/" slash command — only when no input focused
      if (e.key === "/" && !isInputFocused()) {
        e.preventDefault();
        handlers.onSlashCommand?.();
        return;
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [handlers]);
}
