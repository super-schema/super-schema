/**
 * Platform detection utilities for keyboard shortcut display.
 */

export function isMac(): boolean {
  if (typeof navigator === "undefined") return false;
  return (
    navigator.platform?.startsWith("Mac") ||
    navigator.userAgent?.includes("Mac") ||
    false
  );
}

export function modKey(): string {
  return isMac() ? "Cmd" : "Ctrl";
}

export function modSymbol(): string {
  return isMac() ? "\u2318" : "Ctrl+";
}
