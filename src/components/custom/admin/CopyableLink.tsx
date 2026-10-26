"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";

/** How long the button says it copied. */
export const COPIED_MS = 2500;

interface CopyableLinkProps {
  /** The link: its absolute address when the server knows it, else the route (joined to this page's origin). */
  link: { path: string; url: string | null };
  /** Names the field for assistive technology (`Invitation link`, `Password reset link`). */
  label: string;
  /** Prefix of the test ids when two links could share a page. */
  testId?: string;
  /** Move focus to the copy button when it appears (a dialog that has just made the link). */
  autoFocus?: boolean;
}

/** The address a person opens: the server's absolute one, or the route on this page's own origin. */
export function absoluteLink(link: { path: string; url: string | null }, origin: string | null): string {
  if (link.url) return link.url;
  return origin ? new URL(link.path, origin).toString() : link.path;
}

/**
 * A one-time link a person copies and hands to someone (there is no e-mail service): a read-only field holding the whole address, selected on focus so it can
 * be copied by hand, and a Copy button. The button says "Copied" and so does a status region that is always in the page (screen readers announce a change
 * in a live region that was already there, not one that appears with its text), and the clipboard failing is said too, with the field to copy from.
 */
export function CopyableLink({ link, label, testId = "one-time-link", autoFocus }: CopyableLinkProps) {
  const [origin, setOrigin] = useState<string | null>(null);
  const [status, setStatus] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const field = useRef<HTMLInputElement>(null);

  useEffect(() => {
    // The page's own origin exists only in the browser: read after mount, never during render (the server has no window).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setOrigin(window.location.origin);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  const address = absoluteLink(link, origin);

  async function copy() {
    let ok = false;
    try {
      await navigator.clipboard.writeText(address);
      ok = true;
    } catch {
      field.current?.focus();
      field.current?.select();
    }
    setStatus(ok ? "copied" : "failed");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setStatus("idle"), COPIED_MS);
  }

  return (
    <div className="space-y-space-2">
      <label htmlFor={`${testId}-field`} className="block text-caption text-muted-foreground">{label}</label>
      <div className="flex items-center gap-space-2">
        <input
          ref={field}
          id={`${testId}-field`}
          data-testid={testId}
          type="text"
          readOnly
          value={address}
          onFocus={(event) => event.currentTarget.select()}
          className="min-w-0 flex-1 rounded-md bg-muted px-space-3 py-1.5 font-mono text-caption text-foreground outline-none focus-visible:ring-1 focus-visible:ring-primary"
        />
        <Button type="button" variant="outline" size="sm" data-testid={`${testId}-copy`} onClick={copy} autoFocus={autoFocus}>
          {status === "copied" ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
          {status === "copied" ? "Copied" : "Copy"}
        </Button>
      </div>
      <span role="status" aria-live="polite" data-testid={`${testId}-status`} className="sr-only">
        {status === "copied" ? "Copied" : status === "failed" ? "Could not copy. Select the link and copy it by hand." : ""}
      </span>
      {status === "failed" && <p className="text-caption text-destructive">Could not copy. The link is selected: copy it by hand.</p>}
    </div>
  );
}
