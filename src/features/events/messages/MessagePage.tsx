"use client";

import Link from "next/link";
import { Mail } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { HideEmptyRightPanel } from "@/components/layout/HideEmptyRightPanel";
import {
  getMessagePublishPreviewAction, publishMessageAction,
} from "@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/message-version-actions";
import { assetHref } from "@/lib/navigation/asset-href";
import { EventBreadcrumb } from "@/features/events/shared/EventBreadcrumb";
import { EventVersionList } from "@/features/events/shared/EventVersionList";
import { PublishVersionButton } from "@/features/events/shared/PublishVersionButton";
import { UsedByPanel } from "@/features/events/shared/UsedByPanel";
import { MessageEditor } from "./MessageEditor";
import type { MessagePageData } from "./load-message-page";

const PIN_LABELS = { payload: "Payload", headers: "Headers", key: "Kafka key" } as const;

export function MessagePage({
  message, productId, domainSlug, productSlug, crumbs, listHref, entityOptions, traitOptions, versions, viewing, owner = null,
}: MessagePageData) {
  const ref = { kind: "message", id: message.id, domainSlug, productSlug } as const;
  const draftHref = assetHref(ref);
  const versionHref = (label: string) => assetHref(ref, { version: label });
  // Another product's message is never editable or publishable from here, whatever else the props say (defence in depth).
  const editable = !viewing && !owner;
  const pins = viewing
    ? (["payload", "headers", "key"] as const).flatMap((role) => {
        const pin = viewing.resolvedSpec[role];
        return pin ? [{ role, pin }] : [];
      })
    : [];

  return (
    <div className="animate-auth-fade-up space-y-space-6">
      <HideEmptyRightPanel />
      <EventBreadcrumb crumbs={crumbs} />
      <div className="flex flex-wrap items-center justify-between gap-space-3">
        <div className="flex items-center gap-space-2">
          <Mail className="w-6 h-6" />
          <h1 className="text-display text-foreground">{message.name}</h1>
          <Badge variant="secondary">{message.latestVersionLabel ? `latest v${message.latestVersionLabel}` : "unpublished"}</Badge>
          {message.latestVersionLabel && message.hasUnpublishedChanges && <Badge variant="outline">unpublished changes</Badge>}
        </div>
        {editable && (
          <PublishVersionButton
            subjectName={message.name}
            description="Publishing freezes this draft — pinned entity versions included — as an immutable message version event specs can pin."
            loadPreview={() => getMessagePublishPreviewAction(message.id, productId)}
            publish={(input) => publishMessageAction(message.id, productId, input)}
            testId="message-publish"
          />
        )}
      </div>

      {viewing && (
        <section className="space-y-space-3 rounded-lg border border-border/60 p-space-4" data-testid="message-version-view">
          <p className="text-body-small text-foreground">
            Viewing v{viewing.label} (published, read-only).{" "}
            {owner ? (
              <>
                Owned by {owner.label} — <Link href={owner.href} className="text-primary hover:underline">open in its own product</Link>
              </>
            ) : (
              <Link href={draftHref} className="text-primary hover:underline">Back to draft</Link>
            )}
          </p>
          <ul className="text-body-small text-muted-foreground">
            {pins.map(({ role, pin }) => (
              <li key={role}>{PIN_LABELS[role]}: {pin.entityName} v{pin.label}</li>
            ))}
          </ul>
          <pre className="max-h-96 overflow-auto rounded-md bg-muted/30 p-space-3 text-caption font-mono">{JSON.stringify(viewing.resolvedSpec.spec, null, 2)}</pre>
        </section>
      )}
      {editable && (
        <MessageEditor key={message.id} message={message} productId={productId} listHref={listHref} entityOptions={entityOptions} traitOptions={traitOptions} />
      )}

      <section className="space-y-space-3">
        <h2 className="text-heading-2 text-foreground">Published versions</h2>
        <EventVersionList versions={versions} hrefFor={versionHref} emptyText="Not published yet. Publish to cut version 1.0." />
      </section>

      <UsedByPanel subject={{ kind: "message", messageId: message.id }} title="Used by event specs" />
    </div>
  );
}
