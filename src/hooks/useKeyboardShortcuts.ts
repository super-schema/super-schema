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
 * (except Cmd+S, Cmd+N and Cmd+E). Cmd+S always keeps the browser's "Save page" dialog away; Cmd+E is taken from the browser only
 * when a handler is registered for it.
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

      // Cmd+E — only when something here emits
      if (mod && e.key === "e" && handlers.onEmit) {
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
