"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { Search, Plus, CheckCircle, Circle, RefreshCw } from "lucide-react";
import {
  getDomainsAdminAction,
  createDomainAdminAction,
  updateDomainPolicyAction,
  listPolicyAttributeDefinitionsAction,
} from "@/app/(dashboard)/admin/actions";
import { useInvalidateDomainsTree } from "@/hooks/useDomainsTree";
import type { PolicyTemplate } from "@/types/schemas/domain-policy";
import type { MetadataAttributeDefinition } from "@/types/schemas/metadata-attribute";
import { PolicyTemplateEditor } from "./PolicyTemplateEditor";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

interface DomainRow {
  id: string;
  name: string;
  description: string;
  entityCount: number;
  policyTemplateStatus: "Configured" | "No template";
  policyTemplate: PolicyTemplate | null;
  createdAt: string;
}

export function DomainDataTable() {
  const invalidateDomainsTree = useInvalidateDomainsTree();
  const [search, setSearch] = useState("");
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [domains, setDomains] = useState<DomainRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [policyDomain, setPolicyDomain] = useState<DomainRow | null>(null);
  const [policySaving, setPolicySaving] = useState(false);
  const [policyError, setPolicyError] = useState<string | null>(null);
  const policyRequest = useRef(false);

  // create form
  const [newName, setNewName] = useState("");
  const [newDescription, setNewDescription] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const res = await getDomainsAdminAction();
    if ("error" in res) {
      setError(res.error ?? "Request failed");
      setLoading(false);
      return;
    }
    setDomains(
      res.data.map((d) => ({
        id: d.id,
        name: d.name,
        description: d.description,
        entityCount: d.entityCount,
        policyTemplateStatus: d.policyTemplateStatus,
        policyTemplate: d.policyTemplate ?? null,
        createdAt: new Date(d.createdAt).toLocaleDateString(),
      }))
    );
    setLoading(false);
  }, []);

  useEffect(() => {
    // Fetch once on mount; state updates occur after the async result resolves.
    void load();
  }, [load]);

  const [attributeDefs, setAttributeDefs] = useState<MetadataAttributeDefinition[]>([]);
  useEffect(() => {
    void (async () => {
      const res = await listPolicyAttributeDefinitionsAction();
      if (res && "data" in res) setAttributeDefs(res.data ?? []);
    })();
  }, []);

  function openCreate() {
    setNewName("");
    setNewDescription("");
    setCreateError(null);
    setShowCreateDialog(true);
  }

  async function savePolicy(template: PolicyTemplate) {
    if (!policyDomain || policyRequest.current) return;
    policyRequest.current = true;
    setPolicySaving(true);
    setPolicyError(null);
    try {
      const result = await updateDomainPolicyAction(policyDomain.id, template);
      if ("error" in result) { setPolicyError(result.error ?? "Could not save policy."); return; }
      setDomains((current) => current.map((domain) => domain.id === policyDomain.id ? {
        ...domain,
        policyTemplate: result.data.policyTemplate,
        policyTemplateStatus: result.data.policyTemplate ? "Configured" : "No template",
      } : domain));
      setPolicyDomain(null);
      void invalidateDomainsTree();
    } catch {
      setPolicyError("Could not save the domain policy. Try again.");
    } finally {
      policyRequest.current = false;
      setPolicySaving(false);
    }
  }

  async function handleCreate() {
    if (!newName.trim()) {
      setCreateError("Domain name is required");
      return;
    }
    setCreating(true);
    setCreateError(null);
    const res = await createDomainAdminAction({
      name: newName.trim(),
      description: newDescription.trim() || undefined,
    });
    if ("error" in res) {
      setCreateError(res.error ?? "Request failed");
      setCreating(false);
      return;
    }
    setCreating(false);
    setShowCreateDialog(false);
    // The explorer keeps the domains tree for a minute: a domain made here is in it from now on.
    void invalidateDomainsTree();
    await load();
  }

  const filtered = domains.filter(
    (d) => !search.trim() || d.name.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="space-y-space-4">
      {error && (
        <div
          role="alert"
          data-testid="domain-error"
          className="rounded-md border border-destructive bg-destructive/5 px-space-3 py-space-2 text-body-small text-destructive"
        >
          {error}
        </div>
      )}

      {/* Toolbar */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-space-2 max-w-sm flex-1">
          <div className="flex items-center gap-space-2 bg-muted rounded-lg px-space-3 py-1.5 flex-1">
            <Search className="w-4 h-4 text-muted-foreground shrink-0" />
            <input
              type="text"
              data-testid="domain-filter"
              aria-label="Filter domains"
              placeholder="Filter domains..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="bg-transparent text-body-small text-foreground placeholder:text-muted-foreground outline-none w-full"
            />
          </div>
        </div>
        <Button
          onClick={openCreate}
          data-testid="domain-create-open"
        >
          <Plus className="size-4" />
          Create Domain
        </Button>
      </div>

      {/* Table */}
      <div className="border border-border rounded-lg overflow-hidden">
        <Table className="text-body-small" data-testid="domain-table">
          <TableHeader>
            <TableRow className="bg-muted/50 hover:bg-muted/50">
              <TableHead className="text-muted-foreground">Name</TableHead>
              <TableHead className="text-muted-foreground">Description</TableHead>
              <TableHead className="text-muted-foreground">Entities</TableHead>
              <TableHead className="text-muted-foreground">Policy Template</TableHead>
              <TableHead className="text-muted-foreground">Created</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              <TableRow>
                <TableCell colSpan={5} className="py-space-6 text-center text-muted-foreground">
                  <span className="inline-flex items-center gap-space-2">
                    <RefreshCw className="w-4 h-4 animate-spin" />
                    Loading domains…
                  </span>
                </TableCell>
              </TableRow>
            ) : filtered.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="py-space-6 text-center text-muted-foreground">
                  {search ? "No matching domains" : "No domains yet. Create one to get started."}
                </TableCell>
              </TableRow>
            ) : (
              filtered.map((domain) => (
                <TableRow
                  key={domain.id}
                  data-testid="domain-row"
                  data-name={domain.name}
                >
                  <TableCell className="text-foreground font-medium">{domain.name}</TableCell>
                  <TableCell className="text-muted-foreground truncate max-w-xs">{domain.description}</TableCell>
                  <TableCell className="text-foreground">{domain.entityCount}</TableCell>
                  <TableCell>
                    <div className="flex flex-wrap items-center gap-space-2">
                    {domain.policyTemplateStatus === "Configured" ? (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-caption bg-success/20 text-success">
                        <CheckCircle className="w-3 h-3" />
                        Configured
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-caption bg-muted text-muted-foreground">
                        <Circle className="w-3 h-3" />
                        No template
                      </span>
                    )}
                      <Button type="button" size="sm" variant="outline" aria-label={`Configure policy for ${domain.name}`} onClick={() => { setPolicyError(null); setPolicyDomain(domain); }}>Configure policy</Button>
                    </div>
                  </TableCell>
                  <TableCell className="text-muted-foreground">{domain.createdAt}</TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      <Dialog open={policyDomain !== null} onOpenChange={(open) => { if (!open && !policySaving) setPolicyDomain(null); }} disablePointerDismissal={policySaving}>
        <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-2xl" showCloseButton={!policySaving}>
          <DialogHeader>
            <DialogTitle>Policy for {policyDomain?.name}</DialogTitle>
            <DialogDescription>Configure domain defaults and the required or suggested information for each field type.</DialogDescription>
          </DialogHeader>
          {policyDomain && (
            <fieldset disabled={policySaving} className="min-w-0">
              <PolicyTemplateEditor key={policyDomain.id} value={policyDomain.policyTemplate} attributeDefinitions={attributeDefs} onChange={(template) => { void savePolicy(template); }} />
            </fieldset>
          )}
          {policySaving && <p role="status" className="text-body-small text-muted-foreground">Saving policy…</p>}
          {policyError && <p role="alert" className="text-body-small text-destructive">{policyError}</p>}
        </DialogContent>
      </Dialog>

      {/* Create dialog */}
      <Dialog open={showCreateDialog} onOpenChange={(open) => { if (!open && !creating) setShowCreateDialog(false); }} disablePointerDismissal={creating}>
        <DialogContent data-testid="domain-create-dialog" className="sm:max-w-md" showCloseButton={!creating}>
          <form
            className="flex flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              void handleCreate();
            }}
          >
            <DialogHeader>
              <DialogTitle>Create Domain</DialogTitle>
              <DialogDescription>A domain groups the data products, entities and types one team owns.</DialogDescription>
            </DialogHeader>

            {createError && (
              <div
                role="alert"
                data-testid="domain-create-error"
                className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
              >
                {createError}
              </div>
            )}

            <FieldGroup className="gap-3">
              <Field>
                <FieldLabel htmlFor="domain-name">Name</FieldLabel>
                <Input
                  id="domain-name"
                  data-testid="domain-create-name"
                  type="text"
                  autoFocus
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="e.g. Payments"
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="domain-description">Description</FieldLabel>
                <Textarea
                  id="domain-description"
                  data-testid="domain-create-description"
                  value={newDescription}
                  onChange={(e) => setNewDescription(e.target.value)}
                  rows={3}
                  placeholder="Optional description"
                />
              </Field>
            </FieldGroup>

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setShowCreateDialog(false)} disabled={creating}>
                Cancel
              </Button>
              <Button type="submit" data-testid="domain-create-submit" disabled={creating}>
                {creating && <RefreshCw className="animate-spin" aria-hidden="true" />}
                Create
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
