"use client";

import { useCallback, useEffect, useSyncExternalStore } from "react";

/** Available font-size scale labels. */
export type FontScale = "small" | "medium" | "large";

/** Multipliers applied to the 16px base. */
export const fontScaleValues: Record<FontScale, number> = {
  small: 0.875,
  medium: 1.0,
  large: 1.125,
};

export const FONT_SCALE_STORAGE_KEY = "super-schema:font-scale";

const CSS_VAR = "--font-scale";
const FONT_SCALE_CHANGE_EVENT = "super-schema:font-scale-change";


function getStoredScale(): FontScale {
  if (typeof window === "undefined") return "medium";
  const stored = localStorage.getItem(FONT_SCALE_STORAGE_KEY);
  return isFontScale(stored) ? stored : "medium";
}

function getServerScale(): FontScale {
  return "medium";
}

function isFontScale(value: string | null): value is FontScale {
  return value != null && value in fontScaleValues;
}

function subscribeToFontScale(callback: () => void) {
  if (typeof window === "undefined") return () => {};

  function handleStorage(event: StorageEvent) {
    if (event.key === FONT_SCALE_STORAGE_KEY) {
      callback();
    }
  }

  window.addEventListener("storage", handleStorage);
  window.addEventListener(FONT_SCALE_CHANGE_EVENT, callback);
  return () => {
    window.removeEventListener("storage", handleStorage);
    window.removeEventListener(FONT_SCALE_CHANGE_EVENT, callback);
  };
}

function applyScale(scale: FontScale) {
  document.documentElement.style.setProperty(
    CSS_VAR,
    String(fontScaleValues[scale])
  );
}

/**
 * React hook to manage the global font-size scale.
 *
 * Sets a `--font-scale` CSS variable on `<html>` so that
 * `font-size: calc(16px * var(--font-scale, 1))` in globals.css
 * scales all rem-based dimensions proportionally.
 */
export function useFontSize() {
  const scale = useSyncExternalStore(
    subscribeToFontScale,
    getStoredScale,
    getServerScale
  );

  useEffect(() => {
    applyScale(scale);
  }, [scale]);

  const setScale = useCallback((next: FontScale) => {
    localStorage.setItem(FONT_SCALE_STORAGE_KEY, next);
    applyScale(next);
    window.dispatchEvent(new CustomEvent(FONT_SCALE_CHANGE_EVENT));
  }, []);

  return { scale, setScale };
}
