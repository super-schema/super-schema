"use client";

import { useSyncExternalStore } from "react";

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

function subscribeToPlatform() {
  return () => {};
}

function getServerModKey(): string {
  return "Ctrl";
}

function getServerModSymbol(): string {
  return "Ctrl+";
}


export function modKey(): string {
  return isMac() ? "Cmd" : "Ctrl";
}

export function useModKey(): string {
  return useSyncExternalStore(subscribeToPlatform, modKey, getServerModKey);
}


export function modSymbol(): string {
  return isMac() ? "\u2318" : "Ctrl+";
}

export function useModSymbol(): string {
  return useSyncExternalStore(subscribeToPlatform, modSymbol, getServerModSymbol);
}
