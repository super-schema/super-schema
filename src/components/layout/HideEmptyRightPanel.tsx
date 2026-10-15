"use client";

import { useEffect } from "react";
import { useRightPanelContent } from "@/hooks/useRightPanelContent";

/**
 * Render on a page that has nothing for the global right panel (e.g. the
 * new-entity wizard): the empty "Detail Panel" placeholder is hidden while the
 * page is mounted. Pages that push content into the panel still show it.
 */
export function HideEmptyRightPanel() {
  const { setHideWhenEmpty } = useRightPanelContent();

  useEffect(() => {
    setHideWhenEmpty(true);
    return () => setHideWhenEmpty(false);
  }, [setHideWhenEmpty]);

  return null;
}
