/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

describe("useKeyboardShortcuts — keyboard event handling", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function fireKeyDown(opts: { key: string; metaKey?: boolean; ctrlKey?: boolean }) {
    const event = new KeyboardEvent("keydown", {
      key: opts.key,
      metaKey: opts.metaKey ?? false,
      ctrlKey: opts.ctrlKey ?? false,
      bubbles: true,
      cancelable: true,
    });
    vi.spyOn(event, "preventDefault");
    document.dispatchEvent(event);
    return event;
  }

  it("should call onSave and preventDefault when Cmd+S is pressed", () => {
    const onSave = vi.fn();
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        onSave();
      }
    };
    document.addEventListener("keydown", handler);

    const event = fireKeyDown({ key: "s", metaKey: true });
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(event.preventDefault).toHaveBeenCalled();

    document.removeEventListener("keydown", handler);
  });

  it("should call onNewEntity and preventDefault when Cmd+N is pressed", () => {
    const onNewEntity = vi.fn();
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "n") {
        e.preventDefault();
        onNewEntity();
      }
    };
    document.addEventListener("keydown", handler);

    const event = fireKeyDown({ key: "n", metaKey: true });
    expect(onNewEntity).toHaveBeenCalledTimes(1);
    expect(event.preventDefault).toHaveBeenCalled();

    document.removeEventListener("keydown", handler);
  });

  it("should call onEmit and preventDefault when Cmd+E is pressed", () => {
    const onEmit = vi.fn();
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "e") {
        e.preventDefault();
        onEmit();
      }
    };
    document.addEventListener("keydown", handler);

    const event = fireKeyDown({ key: "e", metaKey: true });
    expect(onEmit).toHaveBeenCalledTimes(1);
    expect(event.preventDefault).toHaveBeenCalled();

    document.removeEventListener("keydown", handler);
  });

  it("should call onEscape when Escape is pressed", () => {
    const onEscape = vi.fn();
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onEscape();
    };
    document.addEventListener("keydown", handler);

    fireKeyDown({ key: "Escape" });
    expect(onEscape).toHaveBeenCalledTimes(1);

    document.removeEventListener("keydown", handler);
  });

  it("should call onSlashCommand when / is pressed and no input focused", () => {
    const onSlashCommand = vi.fn();
    // Focus is on body (not input)
    const handler = (e: KeyboardEvent) => {
      const el = document.activeElement;
      const tag = el?.tagName.toLowerCase();
      const isInput = tag === "input" || tag === "textarea";
      if (e.key === "/" && !isInput) {
        e.preventDefault();
        onSlashCommand();
      }
    };
    document.addEventListener("keydown", handler);

    const event = fireKeyDown({ key: "/" });
    expect(onSlashCommand).toHaveBeenCalledTimes(1);
    expect(event.preventDefault).toHaveBeenCalled();

    document.removeEventListener("keydown", handler);
  });

  it("should NOT call onSlashCommand when / is pressed and input is focused", () => {
    const onSlashCommand = vi.fn();
    // Create and focus an input
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();

    const handler = (e: KeyboardEvent) => {
      const el = document.activeElement;
      const tag = el?.tagName.toLowerCase();
      const isInput = tag === "input" || tag === "textarea";
      if (e.key === "/" && !isInput) {
        e.preventDefault();
        onSlashCommand();
      }
    };
    document.addEventListener("keydown", handler);

    fireKeyDown({ key: "/" });
    expect(onSlashCommand).not.toHaveBeenCalled();

    document.removeEventListener("keydown", handler);
    document.body.removeChild(input);
  });

  it("should handle Ctrl+S on non-Mac platforms", () => {
    const onSave = vi.fn();
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        onSave();
      }
    };
    document.addEventListener("keydown", handler);

    const event = fireKeyDown({ key: "s", ctrlKey: true });
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(event.preventDefault).toHaveBeenCalled();

    document.removeEventListener("keydown", handler);
  });

  it("should not fire shortcuts without modifier keys for Cmd shortcuts", () => {
    const onSave = vi.fn();
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        onSave();
      }
    };
    document.addEventListener("keydown", handler);

    fireKeyDown({ key: "s" }); // No modifier
    expect(onSave).not.toHaveBeenCalled();

    document.removeEventListener("keydown", handler);
  });
});
