"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { stringify } from "yaml";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  FieldGroup,
  FieldDescription,
  FieldError,
} from "@/components/ui/field";
import {
  DeploymentField as Field,
  DeploymentChoice as Choice,
} from "@/components/custom/deployments/DeploymentFields";
import { emptyEventDocument } from "@/lib/events/document/types";
import type { ObjectKind, CanonicalDocument } from "@/lib/gitops/contracts";
import type { getGitOpsWorkspace } from "@/services/gitops/workspace";
import * as actions from "@/app/(dashboard)/gitops/actions";

type Workspace = Awaited<ReturnType<typeof getGitOpsWorkspace>>;
type Reply<T> = { data: T; error?: never } | { error: string; data?: never };
const kinds = [
  "Entity",
  "Event",
  "Enum",
  "Scalar",
  "Union",
  "Trait",
  "Service",
  "Interface",
  "Model",
  "Decorator",
] as const;
export function GitOpsWorkspace({ initial }: { initial: Workspace }) {
  const router = useRouter(),
    [data, setData] = useState(initial),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null);
  const [editor, setEditor] = useState(""),
    [kind, setKind] = useState<ObjectKind>("Entity"),
    [name, setName] = useState(""),
    [title, setTitle] = useState(""),
    [description, setDescription] = useState("");
  const product = data.products.find((p) => p.id === data.selectedProductId);
  const draft = data.changeSets.find(
    (c) =>
      c.authorId === data.userId &&
      c.kind === "EDIT" &&
      !["MERGED", "CLOSED"].includes(c.state),
  );
  async function run<T>(work: () => Promise<Reply<T>>, message?: string) {
    setBusy(true);
    setError(null);
    try {
      const result = await work();
      if (result.error) throw new Error(result.error);
      const refreshed = await actions.gitOpsWorkspaceAction(
        data.selectedProductId,
      );
      if (refreshed.error) throw new Error(refreshed.error);
      if (refreshed.data) setData(refreshed.data);
      if (message) toast.success(message);
    } catch (e) {
      setError(e instanceof Error ? e.message : "GitOps operation failed");
    } finally {
      setBusy(false);
    }
  }
  function newDocument() {
    if (!product) return;
    const id = crypto.randomUUID(),
      slug = name
        .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "");
    const scope: CanonicalDocument["scope"] = {
      tenantId: data.tenant.id,
      tenantSlug: data.tenant.slug,
      domainId: product.domainId,
      domainSlug: product.domainSlug,
      productId: product.id,
      productSlug: product.slug,
    };
    const record: Record<string, unknown> = {
        id,
        name,
        tenantId: scope.tenantId,
        domainId: scope.domainId,
        productId: scope.productId,
        description: "",
      },
      children: Record<string, unknown[]> = {};
    if (kind === "Entity") {
      Object.assign(record, {
        slug,
        status: "DRAFT",
        ownerId: data.userId,
        version: 1,
        metadata: {},
      });
      children.fields = [];
    }
    if (kind === "Event")
      Object.assign(record, {
        specType: "asyncapi@3.0",
        document: emptyEventDocument(name),
      });
    if (kind === "Enum") record.values = [];
    if (kind === "Scalar") record.baseType = "string";
    if (kind === "Union") record.memberTypes = [];
    if (kind === "Trait") {
      record.kind = "MESSAGE";
      record.spec = {};
      delete record.description;
      record.productId = null;
      delete scope.productId;
      delete scope.productSlug;
    }
    if (kind === "Service") {
      record.basePath = "/";
      record.scope = "DOMAIN";
      children.operations = [];
      children.parameters = [];
      children.responses = [];
    }
    if (["Model", "Decorator", "Interface"].includes(kind)) {
      delete record.tenantId;
      delete record.productId;
      delete scope.productId;
      delete scope.productSlug;
    }
    if (kind === "Model") {
      record.sourceFormat = "typespec";
      children.fields = [];
    }
    if (kind === "Decorator") {
      record.signature = "";
      record.targetTypes = [];
    }
    if (kind === "Interface") record.operationIds = [];
    setEditor(
      stringify({
        apiVersion: "superschema.io/v1",
        kind,
        id,
        scope,
        version: "1.0.0_snapshot",
        stage: "SNAPSHOT",
        owners: [],
        references: [],
        spec: { record, children },
      }),
    );
  }
  async function saveDocument() {
    await run(
      async () => {
        const { parse } = await import("yaml");
        const document = parse(editor) as CanonicalDocument;
        return actions.saveGitOpsDraftAction(
          { productId: product!.id, document },
          draft?.revision,
        );
      },
      draft?.prNumber ? "PR updated" : "Private draft saved",
    );
  }
  const stages = Array.isArray(data.settings?.stages)
    ? (data.settings.stages as { name: string; branch: string; path: string }[])
    : [];
  return (
    <div className="flex min-w-0 flex-col gap-6" data-testid="gitops-workspace">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <h1 className="text-heading-2">GitOps storage</h1>
          <p className="text-sm text-muted-foreground">
            Browse contracts, author private drafts, and follow their GitHub
            review and environment history.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="info">
            {data.mode === "git"
              ? "Git is the source of truth"
              : "Database mode · GitOps setup"}
          </Badge>
          {data.link ? (
            <>
              <span className="text-sm">@{data.link.login}</span>
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() => void run(() => actions.unlinkGitHubAction())}
              >
                Disconnect
              </Button>
            </>
          ) : (
            <Link
              href="/api/gitops/connect"
              className="text-sm text-primary underline"
            >
              Connect GitHub
            </Link>
          )}
        </div>
      </header>
      {error && <FieldError>{error}</FieldError>}
      {!data.app && (
        <p className="text-sm text-muted-foreground">
          A platform administrator must configure the GitHub App before the
          repository can be connected.
        </p>
      )}
      <FieldGroup className="grid sm:grid-cols-[1fr_auto]">
        <Field id="gitops-product" label="Product">
          <Choice
            id="gitops-product"
            value={data.selectedProductId ?? ""}
            options={data.products.map((p) => ({
              value: p.id,
              label: `${p.domainSlug} / ${p.name}`,
            }))}
            onChange={(value) =>
              router.push(`/gitops?productId=${encodeURIComponent(value)}`)
            }
          />
        </Field>
        <Button
          className="self-end"
          variant="outline"
          disabled={busy || !product || !data.binding || !data.canEdit}
          onClick={() =>
            void run(
              () => actions.syncGitOpsAction(product!.id),
              "Synchronization queued",
            )
          }
        >
          Sync now
        </Button>
      </FieldGroup>
      {data.binding && (
        <section
          className="flex min-w-0 flex-col gap-1"
          aria-label="Repository freshness"
        >
          <a
            className="break-all text-sm font-medium text-primary underline"
            href={`${data.binding.repositoryUrl}/tree/${encodeURIComponent(data.binding.branch)}${data.binding.basePath ? `/${data.binding.basePath.split("/").map(encodeURIComponent).join("/")}` : ""}`}
            target="_blank"
            rel="noreferrer"
          >
            {data.binding.repositoryUrl} ·{" "}
            {data.binding.basePath || "repository root"}
          </a>
          <p className="text-xs text-muted-foreground">
            {data.binding.branch}@
            {data.binding.indexedSha?.slice(0, 10) ?? "not indexed"} ·{" "}
            {data.binding.lastSyncStatus}
            {data.binding.lastSyncAt
              ? ` · ${new Date(String(data.binding.lastSyncAt)).toLocaleString()}`
              : ""}
          </p>
          {data.canConfigure && product && (
            <Button
              size="sm"
              variant="ghost"
              className="self-start"
              disabled={busy}
              onClick={() =>
                void run(
                  () => actions.rebuildGitOpsAction(product.id),
                  "Projection rebuild queued",
                )
              }
            >
              Rebuild projection from Git
            </Button>
          )}
          {data.binding.lastError && (
            <FieldError>{data.binding.lastError}</FieldError>
          )}
        </section>
      )}
      {!!data.errors.length && (
        <section aria-label="Index errors" className="flex flex-col gap-2">
          <h2 className="text-heading-3">Files requiring attention</h2>
          {data.errors.map((e) => (
            <FieldError key={e.id}>
              {e.path}: {e.message}
            </FieldError>
          ))}
        </section>
      )}
      {data.canConfigure && (
        <BindingSettings data={data} busy={busy} run={run} />
      )}
      {data.canManageApp && <AppSettings busy={busy} run={run} />}
      {product && (
        <>
          {data.canRun && (
            <ProductSettings
              key={data.settings?.revision ?? 0}
              data={data}
              busy={busy}
              run={run}
            />
          )}
          <section
            className="flex min-w-0 flex-col gap-3"
            aria-labelledby="gitops-environments"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 id="gitops-environments" className="text-heading-3">
                Environment lifecycle
              </h2>
              <span className="text-xs text-muted-foreground">
                Default workflow · same repository
              </span>
            </div>
            <div className="flex flex-wrap gap-3">
              {stages.map((stage, i) => {
                const receipt = data.deliveries.find(
                  (d) =>
                    d.kind === "ENVIRONMENT" &&
                    d.target === stage.name &&
                    d.sourceSha ===
                      (data.settings?.sourceSha ?? data.binding?.indexedSha),
                );
                return (
                  <fieldset
                    key={stage.name}
                    className="flex min-w-48 flex-1 flex-col gap-2 rounded-lg border border-border p-4"
                  >
                    <legend className="px-1 text-sm font-medium">
                      {i + 1}. {stage.name}
                    </legend>
                    <p className="break-all text-xs text-muted-foreground">
                      {stage.branch}
                    </p>
                    <Badge
                      variant={
                        receipt?.state === "DELIVERED" ||
                        (i === 0 && !!data.binding?.indexedSha)
                          ? "success"
                          : "secondary"
                      }
                    >
                      {receipt?.state ??
                        (i === 0 && data.binding?.indexedSha
                          ? "Source indexed"
                          : "Pending")}
                    </Badge>
                    {receipt?.prUrl && (
                      <a
                        href={receipt.prUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="text-sm text-primary underline"
                      >
                        Open PR #{receipt.prNumber}
                      </a>
                    )}
                    {i > 0 && (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={
                          busy ||
                          !data.canRun ||
                          !data.link ||
                          !data.binding?.indexedSha ||
                          !!receipt
                        }
                        onClick={() =>
                          void run(
                            () =>
                              actions.promoteGitOpsEnvironmentAction(
                                product.id,
                                stage.name,
                              ),
                            "Environment PR opened",
                          )
                        }
                      >
                        Promote to {stage.name}
                      </Button>
                    )}
                  </fieldset>
                );
              })}
            </div>
          </section>
          <section
            className="flex min-w-0 flex-col gap-3"
            aria-labelledby="gitops-entries"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 id="gitops-entries" className="text-heading-3">
                Repository entries{" "}
                <span className="text-muted-foreground">
                  ({data.documents.length})
                </span>
              </h2>
              {data.canRun &&
                !data.documents.some((d) => d.productId === product.id) && (
                  <Button
                    variant="outline"
                    disabled={busy || !data.link || !data.binding}
                    onClick={() =>
                      void run(
                        () => actions.bootstrapGitOpsAction(product.id),
                        "Bootstrap draft prepared; submit it below",
                      )
                    }
                  >
                    Initialize / export product
                  </Button>
                )}
            </div>
            {!data.documents.length && (
              <p className="text-sm text-muted-foreground">
                Merge the bootstrap PR, then synchronize to see the repository
                entries here.
              </p>
            )}
            <div className="flex min-w-0 flex-col divide-y divide-border">
              {data.documents.map((entry) => {
                const local = draft?.items.find(
                  (i) =>
                    i.objectKind === entry.kind &&
                    i.objectId === entry.objectId &&
                    i.objectKey.endsWith(`:${entry.version}`),
                );
                return (
                  <div
                    key={entry.id}
                    className="flex min-w-0 flex-wrap items-center gap-2 py-3"
                  >
                    <Badge variant="secondary">{entry.kind}</Badge>
                    <button
                      type="button"
                      className="order-first w-full min-w-0 break-all text-left text-sm text-primary hover:underline sm:order-none sm:w-auto sm:flex-1"
                      onClick={() =>
                        setEditor(stringify(local?.document ?? entry.document))
                      }
                    >
                      {entry.path}
                    </button>
                    {entry.stage && (
                      <Badge
                        variant={
                          entry.stage === "RELEASED" ? "success" : "info"
                        }
                      >
                        {entry.version}
                      </Badge>
                    )}
                    <a
                      href={`${data.binding!.repositoryUrl}/blob/${entry.commitSha}/${entry.path.split("/").map(encodeURIComponent).join("/")}`}
                      className="text-xs text-muted-foreground underline"
                      target="_blank"
                      rel="noreferrer"
                    >
                      GitHub
                    </a>
                    {entry.stage === "RELEASED" && data.canEdit && (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy}
                        onClick={() => {
                          const d = structuredClone(
                            entry.document,
                          ) as unknown as CanonicalDocument;
                          d.stage = "SNAPSHOT";
                          d.version = `${entry.version}_snapshot`;
                          delete d.spec.versionRecord;
                          setEditor(stringify(d));
                        }}
                      >
                        New snapshot
                      </Button>
                    )}
                    {entry.stage === "SNAPSHOT" && data.canRun && (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy}
                        onClick={() =>
                          void run(
                            () =>
                              actions.promoteGitOpsAction(product.id, entry.id),
                            "Promotion draft prepared; submit it below",
                          )
                        }
                      >
                        Promote version
                      </Button>
                    )}
                  </div>
                );
              })}
            </div>
          </section>
          {(data.canEdit || !!editor) && (
            <section
              className="flex min-w-0 flex-col gap-3"
              aria-labelledby="gitops-authoring"
            >
              <h2 id="gitops-authoring" className="text-heading-3">
                {data.canEdit ? "Author a change" : "Canonical source"}
              </h2>
              <fieldset disabled={busy} className="flex min-w-0 flex-col gap-3">
                {data.canEdit && (
                  <FieldGroup className="grid sm:grid-cols-[1fr_1fr_auto]">
                    <Field id="gitops-kind" label="New entry kind">
                      <Choice
                        id="gitops-kind"
                        value={kind}
                        options={kinds.map((value) => ({
                          value,
                          label: value,
                        }))}
                        onChange={(v) => setKind(v as ObjectKind)}
                      />
                    </Field>
                    <Field id="gitops-new-name" label="Name">
                      <Input
                        id="gitops-new-name"
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                      />
                    </Field>
                    <Button
                      variant="outline"
                      className="self-end"
                      disabled={!name.trim()}
                      onClick={newDocument}
                    >
                      New entry
                    </Button>
                  </FieldGroup>
                )}
                <Field id="gitops-document" label="Canonical YAML">
                  <Textarea
                    id="gitops-document"
                    readOnly={!data.canEdit}
                    value={editor}
                    onChange={(e) => setEditor(e.target.value)}
                    rows={18}
                    className="font-mono text-xs"
                    spellCheck={false}
                  />
                  <FieldDescription>
                    Open an entry above or create one. Changes stay private
                    until submission; saving an entry already in review updates
                    the same PR.
                  </FieldDescription>
                </Field>
                {data.canEdit && (
                  <Button
                    className="self-end"
                    disabled={
                      !editor.trim() ||
                      !data.binding?.indexedSha ||
                      data.mode !== "git"
                    }
                    onClick={() => void saveDocument()}
                  >
                    {draft?.prNumber
                      ? "Save and update PR"
                      : "Save private draft"}
                  </Button>
                )}
              </fieldset>
            </section>
          )}
          <section
            className="flex min-w-0 flex-col gap-3"
            aria-labelledby="gitops-changes"
          >
            <h2 id="gitops-changes" className="text-heading-3">
              Change sets and pull requests
            </h2>
            {data.canEdit && (
              <FieldGroup className="grid sm:grid-cols-2">
                <Field id="gitops-pr-title" label="PR title">
                  <Input
                    id="gitops-pr-title"
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    maxLength={250}
                  />
                </Field>
                <Field id="gitops-pr-description" label="Description">
                  <Textarea
                    id="gitops-pr-description"
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    rows={2}
                  />
                </Field>
              </FieldGroup>
            )}
            {!data.changeSets.length && (
              <p className="text-sm text-muted-foreground">
                No visible change sets yet. Other authors&apos; unsubmitted
                drafts remain private.
              </p>
            )}
            {data.changeSets.map((cs) => (
              <fieldset
                key={cs.id}
                className="flex min-w-0 flex-col gap-3 rounded-lg border border-border p-4"
              >
                <legend className="px-1 text-sm font-medium">
                  {cs.title || cs.kind.toLowerCase()} · {cs.items.length}{" "}
                  entries
                </legend>
                <div className="flex flex-wrap items-center gap-2">
                  <Badge
                    variant={cs.state === "MERGED" ? "success" : "secondary"}
                  >
                    {cs.state}
                  </Badge>
                  {cs.prUrl && (
                    <a
                      href={cs.prUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="text-sm text-primary underline"
                    >
                      PR #{cs.prNumber}
                    </a>
                  )}
                  <span className="ml-auto text-xs text-muted-foreground">
                    {cs.headSha?.slice(0, 10) ?? "Private draft"}
                  </span>
                </div>
                {cs.items.map((item) => (
                  <div key={item.id} className="flex min-w-0 flex-col gap-1">
                    <button
                      className="break-all text-left text-xs text-primary hover:underline"
                      onClick={() => setEditor(stringify(item.document))}
                    >
                      {item.path}
                    </button>
                    {item.outOfDate && (
                      <FieldError>
                        Out of date. Refresh the draft, review the conflicts,
                        then save the resolved document.
                      </FieldError>
                    )}
                    {Array.isArray(item.conflicts) &&
                      item.conflicts.length > 0 && (
                        <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all text-xs">
                          {JSON.stringify(item.conflicts, null, 2)}
                        </pre>
                      )}
                  </div>
                ))}
                {cs.authorId === data.userId &&
                  !["MERGED", "CLOSED"].includes(cs.state) && (
                    <div className="flex flex-wrap justify-end gap-2">
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busy}
                        onClick={() =>
                          void run(
                            () => actions.discardGitOpsAction(cs.id),
                            "Change set discarded",
                          )
                        }
                      >
                        Discard
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={busy}
                        onClick={() =>
                          void run(
                            () => actions.refreshGitOpsDraftAction(cs.id),
                            "Draft refreshed",
                          )
                        }
                      >
                        Refresh draft
                      </Button>
                      <Button
                        size="sm"
                        disabled={
                          busy ||
                          !data.link ||
                          cs.items.some((i) => i.outOfDate)
                        }
                        onClick={() =>
                          void run(
                            () =>
                              actions.submitGitOpsAction(
                                cs.id,
                                title.trim() ||
                                  cs.title ||
                                  `Update ${product.name}`,
                                description || cs.description,
                              ),
                            "PR submitted",
                          )
                        }
                      >
                        {cs.prNumber ? "Update PR" : "Submit PR"}
                      </Button>
                    </div>
                  )}
              </fieldset>
            ))}
          </section>
          <section
            className="flex min-w-0 flex-col gap-3"
            aria-label="Artifact delivery history"
          >
            <h2 className="text-heading-3">Artifact delivery</h2>
            {!data.deliveries.some((d) => d.kind === "ARTIFACT") && (
              <p className="text-sm text-muted-foreground">
                Artifact PRs appear after canonical changes merge and the worker
                renders their targets.
              </p>
            )}
            {data.deliveries
              .filter((d) => d.kind === "ARTIFACT")
              .map((d) => (
                <div
                  key={d.id}
                  className="flex min-w-0 flex-wrap items-center gap-2"
                >
                  <span className="text-sm">{d.target}</span>
                  <Badge
                    variant={d.state === "DELIVERED" ? "success" : "secondary"}
                  >
                    {d.state}
                  </Badge>
                  <span className="text-xs text-muted-foreground">
                    {d.sourceSha.slice(0, 10)}
                  </span>
                  {d.prUrl && (
                    <a
                      href={d.prUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="text-sm text-primary underline"
                    >
                      PR #{d.prNumber}
                    </a>
                  )}
                  {d.lastError && <FieldError>{d.lastError}</FieldError>}
                </div>
              ))}
          </section>
        </>
      )}
      {!!data.jobs.length && (
        <section
          className="flex flex-col gap-2"
          aria-label="Failed GitOps jobs"
        >
          <h2 className="text-heading-3">Work requiring a retry</h2>
          {data.jobs.map((j) => (
            <div key={j.id} className="flex flex-wrap items-center gap-2">
              <FieldError>
                {j.kind}: {j.lastError}
              </FieldError>
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() =>
                  void run(
                    () => actions.retryGitOpsJobAction(j.id),
                    "Retry queued",
                  )
                }
              >
                Retry
              </Button>
            </div>
          ))}
        </section>
      )}
    </div>
  );
}

type Runner = <T>(
  work: () => Promise<Reply<T>>,
  message?: string,
) => Promise<void>;
function BindingSettings({
  data,
  busy,
  run,
}: {
  data: Workspace;
  busy: boolean;
  run: Runner;
}) {
  const b = data.tenantBinding,
    [repositoryUrl, setUrl] = useState(b?.repositoryUrl ?? ""),
    [installationId, setInstallation] = useState(b?.installationId ?? ""),
    [branch, setBranch] = useState(b?.branch ?? "main"),
    [basePath, setRoot] = useState(b?.basePath ?? "superschema");
  return (
    <details open={!b} className="min-w-0">
      <summary className="cursor-pointer text-sm font-medium">
        Tenant repository binding
      </summary>
      <fieldset disabled={busy} className="mt-4 flex min-w-0 flex-col gap-4">
        <FieldGroup className="grid sm:grid-cols-2">
          <Field id="gitops-repository" label="GitHub repository URL">
            <Input
              id="gitops-repository"
              value={repositoryUrl}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://github.com/your-organization/your-repository"
            />
          </Field>
          <Field id="gitops-installation" label="GitHub App installation ID">
            <Input
              id="gitops-installation"
              value={installationId}
              onChange={(e) => setInstallation(e.target.value)}
            />
          </Field>
          <Field id="gitops-branch" label="Canonical source branch">
            <Input
              id="gitops-branch"
              value={branch}
              onChange={(e) => setBranch(e.target.value)}
            />
          </Field>
          <Field id="gitops-root" label="Repository root folder">
            <Input
              id="gitops-root"
              value={basePath}
              onChange={(e) => setRoot(e.target.value)}
              placeholder="Leave empty for the whole repository"
            />
            <FieldDescription>
              Every GitOps file stays under this folder. Empty means the
              repository root.
            </FieldDescription>
          </Field>
        </FieldGroup>
        <Button
          className="self-end"
          onClick={() =>
            void run(
              () =>
                actions.saveGitOpsBindingAction({
                  repositoryUrl,
                  installationId,
                  branch,
                  basePath,
                  enabled: true,
                }),
              "Repository verified and default workflows configured",
            )
          }
        >
          Verify and save binding
        </Button>
      </fieldset>
    </details>
  );
}
function AppSettings({ busy, run }: { busy: boolean; run: Runner }) {
  const [app, setApp] = useState({
    appId: "",
    privateKey: "",
    webhookSecret: "",
    clientId: "",
    clientSecret: "",
    baseUrl: "https://github.com",
  });
  return (
    <details className="min-w-0">
      <summary className="cursor-pointer text-sm font-medium">
        GitHub App · platform settings
      </summary>
      <fieldset disabled={busy} className="mt-4 flex min-w-0 flex-col gap-4">
        <FieldGroup className="grid sm:grid-cols-2">
          {(
            [
              "appId",
              "clientId",
              "baseUrl",
              "webhookSecret",
              "clientSecret",
            ] as const
          ).map((key) => (
            <Field key={key} id={`gitops-app-${key}`} label={key}>
              <Input
                id={`gitops-app-${key}`}
                type={
                  key.toLowerCase().includes("secret") ? "password" : "text"
                }
                autoComplete="off"
                value={app[key]}
                onChange={(e) => setApp({ ...app, [key]: e.target.value })}
              />
            </Field>
          ))}
        </FieldGroup>
        <Field id="gitops-app-key" label="PEM private key">
          <Textarea
            id="gitops-app-key"
            autoComplete="off"
            value={app.privateKey}
            onChange={(e) => setApp({ ...app, privateKey: e.target.value })}
            rows={4}
          />
          <FieldDescription>
            Secrets are encrypted and are never loaded back into this form.
            Saving App credentials requires users to reconnect GitHub.
          </FieldDescription>
        </Field>
        <Button
          className="self-end"
          onClick={() =>
            void run(
              () => actions.saveGitOpsAppAction(app),
              "GitHub App configured",
            )
          }
        >
          Save GitHub App
        </Button>
      </fieldset>
    </details>
  );
}
function ProductSettings({
  data,
  busy,
  run,
}: {
  data: Workspace;
  busy: boolean;
  run: Runner;
}) {
  const [stages, setStages] = useState(
      (Array.isArray(data.settings?.stages) ? data.settings.stages : []) as {
        name: string;
        branch: string;
        path: string;
      }[],
    ),
    [owners, setOwners] = useState(data.settings?.owners.join(", ") ?? ""),
    [targets, setTargets] = useState(
      JSON.stringify(data.settings?.targets ?? [], null, 2),
    );
  const [override, setOverride] = useState(
      !!data.settings && data.settings.bindingId !== data.tenantBinding?.id,
    ),
    [url, setUrl] = useState(
      data.settings?.repositoryUrl ?? data.binding?.repositoryUrl ?? "",
    ),
    [branch, setBranch] = useState(
      data.settings?.branch ?? data.binding?.branch ?? "main",
    ),
    [root, setRoot] = useState(
      data.settings?.basePath ?? data.binding?.basePath ?? "",
    ),
    [installationId, setInstallation] = useState(
      data.settings?.installationId ?? data.binding?.installationId ?? "",
    );
  return (
    <details className="min-w-0">
      <summary className="cursor-pointer text-sm font-medium">
        Product Git workflow and environments
      </summary>
      <fieldset disabled={busy} className="mt-4 flex min-w-0 flex-col gap-4">
        <p className="text-sm text-muted-foreground">
          The default workflow uses this product&apos;s bound repository. Order
          the environments and map each to an existing branch; the first branch
          is the canonical source.
        </p>
        {stages.map((s, i) => (
          <FieldGroup key={i} className="grid sm:grid-cols-[1fr_1fr_auto]">
            <Field id={`stage-name-${i}`} label={`Environment ${i + 1}`}>
              <Choice
                id={`stage-name-${i}`}
                value={s.name}
                options={data.tenant.environments.map((value) => ({
                  value,
                  label: value,
                }))}
                onChange={(name) =>
                  setStages(
                    stages.map((v, n) => (n === i ? { ...v, name } : v)),
                  )
                }
              />
            </Field>
            <Field id={`stage-branch-${i}`} label="Branch">
              <Input
                id={`stage-branch-${i}`}
                value={s.branch}
                onChange={(e) =>
                  setStages(
                    stages.map((v, n) =>
                      n === i ? { ...v, branch: e.target.value } : v,
                    ),
                  )
                }
              />
            </Field>
            <Button
              variant="ghost"
              className="self-end"
              onClick={() => setStages(stages.filter((_v, n) => n !== i))}
            >
              Remove
            </Button>
          </FieldGroup>
        ))}
        <Button
          variant="outline"
          className="self-start"
          disabled={stages.length >= data.tenant.environments.length}
          onClick={() => {
            const name = data.tenant.environments.find(
              (n) => !stages.some((s) => s.name === n),
            );
            if (name)
              setStages([
                ...stages,
                {
                  name,
                  branch: stages.length
                    ? name
                    : (data.binding?.branch ?? "main"),
                  path: "environments",
                },
              ]);
          }}
        >
          Add environment
        </Button>
        <Field id="gitops-owners" label="GitHub owners">
          <Input
            id="gitops-owners"
            value={owners}
            onChange={(e) => setOwners(e.target.value)}
            placeholder="@alice, @organization/schema-team"
          />
          <FieldDescription>
            Use GitHub usernames or teams. Fewer than two owners may leave an
            author without an independent reviewer.
          </FieldDescription>
        </Field>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={override}
            onChange={(e) => setOverride(e.target.checked)}
          />
          Override the tenant repository binding for this product
        </label>
        {override && (
          <FieldGroup className="grid sm:grid-cols-2">
            <Field id="product-git-url" label="Repository URL">
              <Input
                id="product-git-url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
              />
            </Field>
            <Field id="product-git-installation" label="Installation ID">
              <Input
                id="product-git-installation"
                value={installationId}
                onChange={(e) => setInstallation(e.target.value)}
              />
            </Field>
            <Field id="product-git-branch" label="Source branch">
              <Input
                id="product-git-branch"
                value={branch}
                onChange={(e) => setBranch(e.target.value)}
              />
            </Field>
            <Field
              id="product-git-root"
              label="Root folder (empty = whole repository)"
            >
              <Input
                id="product-git-root"
                value={root}
                onChange={(e) => setRoot(e.target.value)}
              />
            </Field>
          </FieldGroup>
        )}
        <Field
          id="gitops-targets"
          label="Additional artifact target bindings (JSON)"
        >
          <Textarea
            id="gitops-targets"
            rows={5}
            value={targets}
            onChange={(e) => setTargets(e.target.value)}
            className="font-mono text-xs"
          />
          <FieldDescription>
            An empty list uses the enabled schema targets on this same
            repository, beneath its root folder.
          </FieldDescription>
        </Field>
        <Button
          className="self-end"
          disabled={!data.binding || !stages.length}
          onClick={() =>
            void run(
              async () => {
                let parsed: unknown;
                try {
                  parsed = JSON.parse(targets);
                } catch {
                  return { error: "Artifact targets must be valid JSON" };
                }
                return actions.saveGitOpsProductAction(
                  data.selectedProductId!,
                  {
                    stages,
                    owners: owners
                      .split(",")
                      .map((s) => s.trim())
                      .filter(Boolean),
                    targets: parsed,
                    ...(override
                      ? {
                          repositoryUrl: url,
                          installationId,
                          branch,
                          basePath: root,
                        }
                      : {}),
                  },
                );
              },
              data.mode === "git"
                ? "Workflow draft prepared; submit its PR below"
                : "Product workflow saved",
            )
          }
        >
          Verify and save workflow
        </Button>
      </fieldset>
    </details>
  );
}
