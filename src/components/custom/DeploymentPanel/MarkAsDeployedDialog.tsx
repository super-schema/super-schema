"use client";

import { useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { NativeSelect } from "@/components/ui/native-select";

interface MarkAsDeployedDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: (environment: string, version?: string) => void;
  versions?: number[];
  targetFormat: string;
  version: string;
  entityName: string;
  environments?: string[];
}

export function MarkAsDeployedDialog({
  isOpen,
  onClose,
  onConfirm,
  targetFormat,
  version,
  entityName,
  environments = [],
  versions,
}: MarkAsDeployedDialogProps) {
  const [selectedVersion, setSelectedVersion] = useState(version);
  const [environment, setEnvironment] = useState(environments[0] ?? "");

  function handleConfirm() {
    const env = environment;
    if (!environments.includes(env)) return;
    onConfirm(env, selectedVersion);
    onClose();
  }

  return (
    <Dialog open={isOpen} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent data-testid="mark-deployed-dialog" className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Mark as Deployed</DialogTitle>
          <DialogDescription>
            Mark <span className="font-medium text-foreground">{entityName}</span> version{" "}
            <span className="font-mono text-foreground">{selectedVersion}</span> as deployed to{" "}
            <span className="font-medium text-foreground">{targetFormat}</span>.
          </DialogDescription>
        </DialogHeader>

        <FieldGroup>
          {versions && (
            <Field>
              <FieldLabel htmlFor="record-version">Published artifact version</FieldLabel>
              <NativeSelect id="record-version" value={selectedVersion} onChange={(e) => setSelectedVersion(e.target.value)}>
                {versions.map((v) => <option key={v} value={`v${v}`}>v{v}</option>)}
              </NativeSelect>
            </Field>
          )}
          <Field>
            <FieldLabel htmlFor="record-environment">Environment</FieldLabel>
            <NativeSelect id="record-environment" data-testid="environment-selector" value={environment} onChange={(e) => setEnvironment(e.target.value)}>
              {!environments.length && <option value="">Configure environments in settings</option>}
              {environments.map((env) => <option key={env} value={env}>{env}</option>)}
            </NativeSelect>
            <FieldDescription>
              <Link href="/admin/workflows/environments" className="text-primary underline-offset-4 hover:underline">Manage environments in settings</Link>
            </FieldDescription>
          </Field>
        </FieldGroup>

        <DialogFooter>
          <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
          <Button data-testid="confirm-deploy-button" onClick={handleConfirm} disabled={!environments.includes(environment)}>
            Confirm
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
