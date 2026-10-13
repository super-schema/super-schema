"use client";

import { useCallback, useEffect, useSyncExternalStore } from "react";
import type { Dispatch, ReactNode, SetStateAction } from "react";

export type Theme = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

export const THEME_STORAGE_KEY = "theme";
export const DEFAULT_THEME: Theme = "dark";
const DEFAULT_RESOLVED_THEME: ResolvedTheme = "dark";

const THEME_CHANGE_EVENT = "super-schema:theme-change";
const THEMES: Theme[] = ["light", "dark", "system"];

type ThemeSnapshot = `${Theme}:${ResolvedTheme}`;

function isTheme(value: unknown): value is Theme {
  return value === "light" || value === "dark" || value === "system";
}

function getStoredTheme(): Theme {
  if (typeof window === "undefined") return DEFAULT_THEME;

  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    return isTheme(stored) ? stored : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
}

function getSystemTheme(): ResolvedTheme {
  if (typeof window === "undefined") return DEFAULT_RESOLVED_THEME;

  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

function resolveTheme(theme: Theme, systemTheme = getSystemTheme()): ResolvedTheme {
  return theme === "system" ? systemTheme : theme;
}

function getThemeSnapshot(): ThemeSnapshot {
  const theme = getStoredTheme();
  return `${theme}:${getSystemTheme()}`;
}

function getServerThemeSnapshot(): ThemeSnapshot {
  return `${DEFAULT_THEME}:${DEFAULT_RESOLVED_THEME}`;
}

function applyTheme(theme: Theme) {
  if (typeof document === "undefined") return;

  const resolved = resolveTheme(theme);
  const root = document.documentElement;
  root.classList.remove("light", "dark");
  root.classList.add(resolved);
  root.style.colorScheme = resolved;
}

function subscribeToTheme(callback: () => void) {
  if (typeof window === "undefined") return () => {};

  const media = window.matchMedia("(prefers-color-scheme: dark)");
  const handleStorage = (event: StorageEvent) => {
    if (event.key === THEME_STORAGE_KEY) callback();
  };

  window.addEventListener("storage", handleStorage);
  window.addEventListener(THEME_CHANGE_EVENT, callback);
  media.addEventListener("change", callback);

  return () => {
    window.removeEventListener("storage", handleStorage);
    window.removeEventListener(THEME_CHANGE_EVENT, callback);
    media.removeEventListener("change", callback);
  };
}

export function useTheme() {
  const snapshot = useSyncExternalStore(
    subscribeToTheme,
    getThemeSnapshot,
    getServerThemeSnapshot
  );
  const [theme, systemTheme] = snapshot.split(":") as [Theme, ResolvedTheme];
  const resolvedTheme = resolveTheme(theme, systemTheme);

  useEffect(() => {
    applyTheme(theme);
  }, [theme, systemTheme]);

  const setTheme = useCallback<Dispatch<SetStateAction<string>>>((value) => {
    const current = getStoredTheme();
    const next = typeof value === "function" ? value(current) : value;

    if (!isTheme(next)) return;

    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // Storage can be unavailable in private browsing; still apply in-memory.
    }

    applyTheme(next);
    window.dispatchEvent(new CustomEvent(THEME_CHANGE_EVENT));
  }, []);

  return {
    themes: THEMES,
    theme,
    setTheme,
    resolvedTheme,
    systemTheme,
  };
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  useTheme();
  return <>{children}</>;
}
