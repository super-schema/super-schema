"use client";

// src/features/events/builder/sections/focus-on-add.ts
// A new item (channel, operation, server) starts with the cursor in its first field, so the user can type at once. The form for the new
// item is on screen when this runs (it is built with the page, not loaded lazily).
import { useEffect } from "react";

/**
 * `addedKey` is the key of the item that was just added (null when none, or once the user has moved on); `activeKey` the key of the
 * item whose form shows. When they are the same item, `firstFieldId` (a DOM id) is focused once.
 */
export function useFocusOnAdd(addedKey: string | null, activeKey: string | null, firstFieldId: string): void {
  useEffect(() => {
    if (addedKey === null || addedKey !== activeKey) return;
    document.getElementById(firstFieldId)?.focus();
  }, [addedKey, activeKey, firstFieldId]);
}
