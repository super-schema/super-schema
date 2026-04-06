"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import {
  type Locale,
  locales,
  defaultLocale,
  LOCALE_STORAGE_KEY,
} from "@/i18n/config";

// Eagerly import all message bundles so we can switch synchronously.
import en from "@/i18n/messages/en.json";
import es from "@/i18n/messages/es.json";
import fr from "@/i18n/messages/fr.json";
import de from "@/i18n/messages/de.json";
import ja from "@/i18n/messages/ja.json";
import zh from "@/i18n/messages/zh.json";

type Messages = typeof en;

const messageBundles: Record<Locale, Messages> = { en, es, fr, de, ja, zh };

/**
 * Read the stored locale from localStorage (falls back to defaultLocale).
 * Safe to call during SSR — returns defaultLocale when window is unavailable.
 */
export function getStoredLocale(): Locale {
  if (typeof window === "undefined") return defaultLocale;
  try {
    const stored = window.localStorage.getItem(LOCALE_STORAGE_KEY);
    if (stored && locales.includes(stored as Locale)) return stored as Locale;
  } catch {
    // localStorage may be unavailable (SSR, privacy mode, etc.)
  }
  return defaultLocale;
}

/**
 * Resolve a dot-path such as "settings.title" against a messages object.
 */
function resolve(messages: Messages, path: string): string {
  const parts = path.split(".");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let current: any = messages;
  for (const part of parts) {
    if (current == null || typeof current !== "object") return path;
    current = current[part];
  }
  return typeof current === "string" ? current : path;
}

/**
 * React hook that provides translated strings for the current locale.
 *
 * Usage:
 * ```ts
 * const t = useTranslations();
 * t("settings.title") // => "Settings"
 * ```
 *
 * Optionally scope to a namespace:
 * ```ts
 * const t = useTranslations("settings");
 * t("title") // => "Settings"
 * ```
 */
export function useTranslations(namespace?: string) {
  const [locale, setLocaleState] = useState<Locale>(defaultLocale);

  // Hydrate from localStorage on mount
  useEffect(() => {
    setLocaleState(getStoredLocale());

    // Listen for cross-tab / cross-component changes
    function onStorage(e: StorageEvent) {
      if (e.key === LOCALE_STORAGE_KEY) {
        const next = (e.newValue ?? defaultLocale) as Locale;
        if (locales.includes(next)) setLocaleState(next);
      }
    }

    // Custom event for same-tab reactivity
    function onLocaleChange(e: Event) {
      const detail = (e as CustomEvent<Locale>).detail;
      if (locales.includes(detail)) setLocaleState(detail);
    }

    window.addEventListener("storage", onStorage);
    window.addEventListener("super-schema:locale-change", onLocaleChange);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener(
        "super-schema:locale-change",
        onLocaleChange
      );
    };
  }, []);

  const messages = useMemo(() => messageBundles[locale] ?? en, [locale]);

  const t = useCallback(
    (key: string): string => {
      const fullKey = namespace ? `${namespace}.${key}` : key;
      return resolve(messages, fullKey);
    },
    [messages, namespace]
  );

  return t;
}

/**
 * Hook that returns the current locale and a setter.
 */
export function useLocale() {
  const [locale, setLocaleState] = useState<Locale>(defaultLocale);

  useEffect(() => {
    setLocaleState(getStoredLocale());

    function onLocaleChange(e: Event) {
      const detail = (e as CustomEvent<Locale>).detail;
      if (locales.includes(detail)) setLocaleState(detail);
    }
    window.addEventListener("super-schema:locale-change", onLocaleChange);
    return () =>
      window.removeEventListener(
        "super-schema:locale-change",
        onLocaleChange
      );
  }, []);

  const setLocale = useCallback((next: Locale) => {
    localStorage.setItem(LOCALE_STORAGE_KEY, next);
    setLocaleState(next);
    // Dispatch so all useTranslations hooks re-render
    window.dispatchEvent(
      new CustomEvent("super-schema:locale-change", { detail: next })
    );
  }, []);

  return { locale, setLocale };
}
