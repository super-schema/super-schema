"use client";

import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { DomainDeletionImpact } from "@/types/domain-deletion";
import { eventsAssetParts, eventsAssetTotal, joinList } from "@/lib/product-deletion";

interface DomainDeletionDialogProps {
  open: boolean;
  domainName: string;
  impact: DomainDeletionImpact;
  isDeleting: boolean;
  error?: string | null;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void | Promise<void>;
}

const impactLabels: Array<{
  key: Exclude<keyof DomainDeletionImpact, "productLevelAssets">;
  singular: string;
  plural: string;
}> = [
  { key: "entities", singular: "entity", plural: "entities" },
  { key: "products", singular: "product", plural: "products" },
  { key: "modelDefinitions", singular: "model", plural: "models" },
  {
    key: "decoratorDefinitions",
    singular: "decorator definition",
    plural: "decorator definitions",
  },
  { key: "sharedEnums", singular: "shared enum", plural: "shared enums" },
  { key: "customScalars", singular: "custom scalar", plural: "custom scalars" },
  { key: "unionTypes", singular: "union type", plural: "union types" },
  { key: "services", singular: "API service", plural: "API services" },
  { key: "interfaces", singular: "interface", plural: "interfaces" },
  { key: "userRoles", singular: "role assignment", plural: "role assignments" },
  { key: "traits", singular: "trait", plural: "traits" },
  { key: "eventSpecs", singular: "event", plural: "events" },
];

export function DomainDeletionDialog({
  open,
  domainName,
  impact,
  isDeleting,
  error,
  onOpenChange,
  onConfirm,
}: DomainDeletionDialogProps) {
  const populatedAssets = impactLabels
    .map((item) => ({ ...item, count: impact[item.key] }))
    .filter((item) => item.count > 0);
  const hasEntities = impact.entities > 0;
  const hasEventsAssets = eventsAssetTotal(impact) > 0;
  // Entities and Events assets block the delete (they never cascade silently); the rest is deleted with the domain.
  const blockingParts = [
    ...(hasEntities ? [`${impact.entities} ${impact.entities === 1 ? "entity" : "entities"}`] : []),
    ...eventsAssetParts(impact),
  ];
  const blockedHeading = hasEntities
    ? hasEventsAssets
      ? "Delete or move all entities and Events assets first."
      : "Delete or move all entities first."
    : "Delete or move all Events assets first.";

  return (
    <Dialog
      open={open}
      modal
      disablePointerDismissal={isDeleting}
      onOpenChange={(nextOpen) => {
        if (!isDeleting) onOpenChange(nextOpen);
      }}
    >
      <DialogContent
        showCloseButton={!isDeleting}
        data-testid="domain-deletion-dialog"
        className="gap-0 overflow-hidden bg-background p-0 sm:max-w-md"
      >
        <DialogHeader className="border-b border-border p-space-5">
          <div className="flex items-start gap-space-3">
            <div className="rounded-lg bg-destructive/10 p-2 text-destructive">
              <AlertTriangle className="size-5" aria-hidden="true" />
            </div>
            <div className="min-w-0 space-y-space-1 pr-space-6">
              <DialogTitle className="text-heading-3 text-foreground">
                Delete domain
              </DialogTitle>
              <DialogDescription className="text-body-small text-muted-foreground">
                Remove{" "}
                <span className="break-all font-mono text-foreground">
                  {domainName}
                </span>{" "}
                from this workspace.
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div className="space-y-space-3 p-space-5">
          {blockingParts.length > 0 ? (
            <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-space-3">
              <p className="text-body-small font-medium text-destructive">
                {blockedHeading}
              </p>
              <p className="mt-space-1 text-caption text-muted-foreground">
                This domain currently contains {joinList(blockingParts)}.
              </p>
            </div>
          ) : (
            <div className="rounded-lg border border-destructive/20 bg-destructive/5 p-space-3" data-testid="domain-deletion-warning">
              <p className="text-body-small text-foreground">
                {populatedAssets.length > 0
                  ? "The domain, its products, and every asset listed below (including product-level Data Types and APIs) will be permanently deleted."
                  : "This domain is empty. Its domain record will be permanently deleted."}
              </p>
              <p className="mt-space-1 text-caption text-muted-foreground">
                This action cannot be undone.
              </p>
            </div>
          )}

          {populatedAssets.length > 0 ? (
            <div>
              <p className="mb-space-2 text-caption font-medium text-muted-foreground">
                Current contents
              </p>
              <ul className="grid grid-cols-1 gap-space-2 sm:grid-cols-2" data-testid="domain-deletion-impact">
                {populatedAssets.map((item) => (
                  <li
                    key={item.key}
                    data-testid={`domain-deletion-impact-${item.key}`}
                    className="rounded-md border border-border/70 bg-muted/30 px-space-3 py-space-2"
                  >
                    <span className="text-caption text-foreground">
                      {item.count}{" "}
                      {item.count === 1 ? item.singular : item.plural}
                    </span>
                  </li>
                ))}
              </ul>
              {impact.productLevelAssets > 0 ? (
                <p className="mt-space-2 text-caption text-muted-foreground">
                  Includes {impact.productLevelAssets} product-level{" "}
                  {impact.productLevelAssets === 1
                    ? "Data Type or API"
                    : "Data Types and APIs"}
                  , deleted together with their products.
                </p>
              ) : null}
            </div>
          ) : null}

          {error ? (
            <p role="alert" className="text-body-small text-destructive">
              {error}
            </p>
          ) : null}
        </div>

        <DialogFooter className="mx-0 mb-0 rounded-none border-t border-border bg-muted/30 p-space-4">
          <DialogClose
            render={<Button type="button" variant="outline" data-testid="domain-deletion-cancel" />}
            disabled={isDeleting}
          >
            Cancel
          </DialogClose>
          <Button
            type="button"
            variant="destructive"
            onClick={onConfirm}
            disabled={isDeleting || blockingParts.length > 0}
            data-testid="domain-deletion-confirm"
          >
            {isDeleting ? "Deleting..." : "Delete Domain"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
