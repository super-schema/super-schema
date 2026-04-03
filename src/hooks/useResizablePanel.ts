"use client";

import { useState, useCallback, useEffect, useRef } from "react";

interface UseResizablePanelOptions {
  minWidth: number;
  maxWidth: number;
  defaultWidth: number;
  panelId: string;
  side: "left" | "right";
}

export function useResizablePanel({
  minWidth,
  maxWidth,
  defaultWidth,
  panelId,
  side,
}: UseResizablePanelOptions) {
  const [width, setWidth] = useState(defaultWidth);
  const [isCollapsed, setIsCollapsed] = useState(false);
  const lastWidthRef = useRef(defaultWidth);
  const isDraggingRef = useRef(false);

  // Restore from localStorage on mount
  useEffect(() => {
    const stored = localStorage.getItem(`panel-width-${panelId}`);
    if (stored) {
      const parsed = JSON.parse(stored);
      setWidth(parsed.width);
      setIsCollapsed(parsed.collapsed);
      lastWidthRef.current = parsed.width;
    }
  }, [panelId]);

  // Persist to localStorage
  useEffect(() => {
    localStorage.setItem(
      `panel-width-${panelId}`,
      JSON.stringify({ width, collapsed: isCollapsed })
    );
  }, [width, isCollapsed, panelId]);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      isDraggingRef.current = true;
      const startX = e.clientX;
      const startWidth = isCollapsed ? 0 : width;

      const handleMouseMove = (moveEvent: MouseEvent) => {
        if (!isDraggingRef.current) return;
        const delta =
          side === "left"
            ? moveEvent.clientX - startX
            : startX - moveEvent.clientX;
        const newWidth = Math.max(minWidth, Math.min(maxWidth, startWidth + delta));
        setWidth(newWidth);
        setIsCollapsed(false);
        lastWidthRef.current = newWidth;
      };

      const handleMouseUp = () => {
        isDraggingRef.current = false;
        document.removeEventListener("mousemove", handleMouseMove);
        document.removeEventListener("mouseup", handleMouseUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      };

      document.addEventListener("mousemove", handleMouseMove);
      document.addEventListener("mouseup", handleMouseUp);
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    },
    [width, isCollapsed, minWidth, maxWidth, side]
  );

  const handleDoubleClick = useCallback(() => {
    if (isCollapsed) {
      setIsCollapsed(false);
      setWidth(lastWidthRef.current || defaultWidth);
    } else {
      lastWidthRef.current = width;
      setIsCollapsed(true);
    }
  }, [isCollapsed, width, defaultWidth]);

  const collapse = useCallback(() => {
    if (!isCollapsed) {
      lastWidthRef.current = width;
      setIsCollapsed(true);
    }
  }, [isCollapsed, width]);

  const expand = useCallback(() => {
    if (isCollapsed) {
      setIsCollapsed(false);
      setWidth(lastWidthRef.current || defaultWidth);
    }
  }, [isCollapsed, defaultWidth]);

  const setWidthExternal = useCallback(
    (newWidth: number) => {
      setWidth(Math.max(minWidth, Math.min(maxWidth, newWidth)));
      setIsCollapsed(false);
      lastWidthRef.current = newWidth;
    },
    [minWidth, maxWidth]
  );

  return {
    width: isCollapsed ? 0 : width,
    isCollapsed,
    handleMouseDown,
    handleDoubleClick,
    collapse,
    expand,
    setWidth: setWidthExternal,
  };
}
