"use client";

import { useId, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Toggle } from "@base-ui/react/toggle";
import { ToggleGroup } from "@base-ui/react/toggle-group";
import {
  ArrowDown,
  ArrowUp,
  Check,
  Database,
  ExternalLink,
  GitBranch,
  GitPullRequest as GitHubIcon,
  LoaderCircle,
  Plus,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import type { TenantGitProfile } from "@/lib/gitops/tenant-storage-contracts";
import type { getTenantStorageSettings } from "@/services/tenant-storage.service";
import {
  bootstrapTenantStorageAction,
  createTenantStorageAction,
  saveTenantStorageAppAction,
  saveTenantStorageProfileAction,
  setTenantStorageAction,
  syncTenantStorageAction,
  tenantStorageSettingsAction,
} from "@/app/(dashboard)/admin/settings/storage/actions";

type Snapshot = Awaited<ReturnType<typeof getTenantStorageSettings>>;
type Mode = "database" | "git";
type Outcome = { error?: string; data?: unknown };

export function StorageChoice({
  value,
  onChange,
  database,
  disabled,
}: {
  value: Mode;
  onChange: (mode: Mode) => void;
  database: string;
  disabled?: boolean;
}) {
  return (
    <ToggleGroup
      aria-label="Content storage"
      value={[value]}
      onValueChange={(values) => {
        if (values[0]) onChange(values[0] as Mode);
      }}
      disabled={disabled}
      className="grid grid-cols-1 gap-3 sm:grid-cols-2"
    >
      {(
        [
          {
            value: "database",
            icon: Database,
            title: database,
            detail:
              "Keep schemas private in the application database. Save changes directly.",
          },
          {
            value: "git",
            icon: GitHubIcon,
            title: "GitHub",
            detail:
              "Store contracts in your repository. Review changes in PRs and promote through your environments.",
          },
        ] as const
      ).map((option) => (
        <Toggle
          key={option.value}
          value={option.value}
          className="flex min-w-0 items-start gap-3 rounded-xl border bg-background p-4 text-left outline-none transition-colors hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 data-pressed:border-primary data-pressed:bg-primary/5"
        >
          <option.icon
            className="mt-0.5 size-5 shrink-0 text-muted-foreground"
            aria-hidden="true"
          />
          <span className="flex min-w-0 flex-1 flex-col gap-1">
            <span className="font-medium">{option.title}</span>{" "}
            <span className="text-xs leading-5 text-muted-foreground">
              {option.detail}
            </span>
          </span>
          <span
            className={cn(
              "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border",
              value === option.value &&
                "border-primary bg-primary text-primary-foreground",
            )}
          >
            {value === option.value && (
              <Check className="size-3" aria-hidden="true" />
            )}
          </span>
        </Toggle>
      ))}
    </ToggleGroup>
  );
}

function TextField({
  label,
  description,
  ...props
}: React.ComponentProps<typeof Input> & {
  label: string;
  description?: string;
}) {
  const id = useId();
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input id={id} {...props} />
      {description && <FieldDescription>{description}</FieldDescription>}
    </Field>
  );
}

export function GitProfileFields({
  value,
  onChange,
}: {
  value: TenantGitProfile;
  onChange: (profile: TenantGitProfile) => void;
}) {
  const [ownerText, setOwnerText] = useState(value.owners.join(", "));
  function binding(key: keyof TenantGitProfile["binding"], next: string) {
    onChange({
      ...value,
      binding: { ...value.binding, [key]: next },
      ...(key === "branch"
        ? {
            stages: value.stages.map((s, i) =>
              i === 0 ? { ...s, branch: next } : s,
            ),
          }
        : {}),
    });
  }
  function stage(index: number, key: "name" | "branch" | "path", next: string) {
    onChange({
      ...value,
      stages: value.stages.map((s, i) =>
        i === index ? { ...s, [key]: next } : s,
      ),
      ...(index === 0 && key === "branch"
        ? { binding: { ...value.binding, branch: next } }
        : {}),
    });
  }
  function move(index: number, direction: number) {
    const stages = [...value.stages];
    [stages[index], stages[index + direction]] = [
      stages[index + direction],
      stages[index],
    ];
    onChange({
      ...value,
      stages,
      binding: { ...value.binding, branch: stages[0].branch },
    });
  }
  return (
    <FieldGroup>
      <div className="grid gap-4 sm:grid-cols-[2fr_1fr]">
        <TextField
          label="Repository URL"
          type="url"
          value={value.binding.repositoryUrl}
          onChange={(e) => binding("repositoryUrl", e.target.value)}
          placeholder="https://github.com/your-org/schema-catalog"
          required
        />
        <TextField
          label="Installation ID"
          value={value.binding.installationId}
          onChange={(e) => binding("installationId", e.target.value)}
          inputMode="numeric"
          placeholder="GitHub App installation ID"
          required
        />
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField
          label="Repository root"
          value={value.binding.basePath}
          onChange={(e) => binding("basePath", e.target.value)}
          placeholder="Empty uses the whole repository"
          description="All contract files stay inside this folder. Leave empty to use the repository root."
        />
        <TextField
          label="Source branch"
          value={value.binding.branch}
          onChange={(e) => binding("branch", e.target.value)}
          required
          description="The first environment is the canonical source. Branches must already exist."
        />
      </div>
      <TextField
        label="Review owners"
        value={ownerText}
        onChange={(e) => {
          setOwnerText(e.target.value);
          onChange({
            ...value,
            owners: e.target.value.split(/[\s,]+/).filter(Boolean),
          });
        }}
        placeholder="@your-org/schema-reviewers"
        description="Optional GitHub users or teams, separated by commas."
      />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-medium">Environment order</h3>
          <p className="text-xs text-muted-foreground">
            Promote in this order. Branch and output paths are configurable.
          </p>
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={value.stages.length >= 50}
          onClick={() =>
            onChange({
              ...value,
              stages: [
                ...value.stages,
                {
                  name: `environment-${value.stages.length + 1}`,
                  branch: `gitops/environment-${value.stages.length + 1}`,
                  path: "environments",
                },
              ],
            })
          }
        >
          <Plus data-icon="inline-start" />
          Environment
        </Button>
      </div>
      <div className="flex flex-col gap-3">
        {value.stages.map((s, i) => (
          <fieldset key={i} className="min-w-0 rounded-lg border p-3">
            <legend className="px-1 text-xs text-muted-foreground">
              {i === 0 ? "1 · Canonical source" : `${i + 1} · Promotion`}
            </legend>
            <div className="grid items-start gap-3 sm:grid-cols-3">
              <TextField
                label={`Environment ${i + 1}`}
                value={s.name}
                onChange={(e) => stage(i, "name", e.target.value)}
                required
              />
              <TextField
                label={`Branch ${i + 1}`}
                value={s.branch}
                onChange={(e) => stage(i, "branch", e.target.value)}
                required
              />
              <TextField
                label={`Output path ${i + 1}`}
                value={s.path}
                onChange={(e) => stage(i, "path", e.target.value)}
              />
            </div>
            <div className="mt-2 flex justify-end gap-1">
              <Button
                type="button"
                size="icon-xs"
                variant="ghost"
                aria-label={`Move environment ${i + 1} up`}
                disabled={i === 0}
                onClick={() => move(i, -1)}
              >
                <ArrowUp />
              </Button>
              <Button
                type="button"
                size="icon-xs"
                variant="ghost"
                aria-label={`Move environment ${i + 1} down`}
                disabled={i === value.stages.length - 1}
                onClick={() => move(i, 1)}
              >
                <ArrowDown />
              </Button>
              <Button
                type="button"
                size="icon-xs"
                variant="ghost"
                aria-label={`Remove environment ${i + 1}`}
                disabled={value.stages.length === 1}
                onClick={() => {
                  const stages = value.stages.filter((_, n) => n !== i);
                  onChange({
                    ...value,
                    stages,
                    binding: { ...value.binding, branch: stages[0].branch },
                  });
                }}
              >
                <Trash2 />
              </Button>
            </div>
          </fieldset>
        ))}
      </div>
    </FieldGroup>
  );
}

function AppConfiguration({
  data,
  busy,
  run,
}: {
  data: Snapshot;
  busy: boolean;
  run: (operation: () => Promise<Outcome>, message: string) => Promise<boolean>;
}) {
  const [app, setApp] = useState({
    appId: data.app?.appId ?? "",
    clientId: data.app?.clientId ?? "",
    baseUrl: data.app?.baseUrl ?? "https://github.com",
    privateKey: "",
    clientSecret: "",
    webhookSecret: "",
  });
  const edit = (key: keyof typeof app, value: string) =>
    setApp((old) => ({ ...old, [key]: value }));
  return (
    <details
      className="rounded-xl border bg-background"
      open={!data.app || undefined}
    >
      <summary className="cursor-pointer p-4 text-sm font-medium">
        GitHub App{" "}
        <span className="ml-2 font-normal text-muted-foreground">
          {data.app
            ? "Configured · shared across tenants"
            : "Required for Git storage"}
        </span>
      </summary>
      <form
        className="px-4 pb-4"
        onSubmit={async (e) => {
          e.preventDefault();
          if (
            await run(() => saveTenantStorageAppAction(app), "GitHub App saved")
          )
            setApp((old) => ({
              ...old,
              privateKey: "",
              clientSecret: "",
              webhookSecret: "",
            }));
        }}
      >
        <fieldset disabled={busy} className="flex min-w-0 flex-col gap-4">
          <p className="text-xs leading-5 text-muted-foreground">
            Install your App on the repository with Contents and Pull requests
            write access, plus Checks and Commit statuses read access. Enable
            user authorization and subscribe to pull_request,
            pull_request_review, check_run, check_suite, status and push events.{" "}
            <Link
              href="/admin/workflows/gitops"
              className="underline underline-offset-2"
            >
              App setup guide
            </Link>
          </p>
          <div className="grid gap-4 sm:grid-cols-3">
            <TextField
              label="App ID"
              value={app.appId}
              onChange={(e) => edit("appId", e.target.value)}
              required
            />
            <TextField
              label="Client ID"
              value={app.clientId}
              onChange={(e) => edit("clientId", e.target.value)}
              required
            />
            <TextField
              label="GitHub base URL"
              type="url"
              value={app.baseUrl}
              onChange={(e) => edit("baseUrl", e.target.value)}
              required
            />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <TextField
              label="Client secret"
              type="password"
              autoComplete="new-password"
              value={app.clientSecret}
              onChange={(e) => edit("clientSecret", e.target.value)}
              required
            />
            <TextField
              label="Webhook secret"
              type="password"
              autoComplete="new-password"
              value={app.webhookSecret}
              onChange={(e) => edit("webhookSecret", e.target.value)}
              required
            />
          </div>
          <Field>
            <FieldLabel htmlFor="tenant-github-private-key">
              Private key (PEM)
            </FieldLabel>
            <Textarea
              id="tenant-github-private-key"
              value={app.privateKey}
              onChange={(e) => edit("privateKey", e.target.value)}
              rows={3}
              required
              autoComplete="off"
              spellCheck={false}
            />
            <FieldDescription>
              Secrets are encrypted and never returned to this form. Replacing
              the App credentials requires users to reconnect GitHub.
            </FieldDescription>
          </Field>
          <div>
            <Button type="submit">Save GitHub App</Button>
          </div>
        </fieldset>
      </form>
    </details>
  );
}

function NewTenantDialog({
  data,
  open,
  onOpenChange,
  onCreated,
}: {
  data: Snapshot;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: () => Promise<void>;
}) {
  const [name, setName] = useState(""),
    [description, setDescription] = useState(""),
    [mode, setMode] = useState<Mode>("database");
  const [domainName, setDomainName] = useState("General"),
    [productName, setProductName] = useState("Workspace");
  const [profile, setProfile] = useState<TenantGitProfile>({
    binding: {
      repositoryUrl: "",
      installationId: "",
      branch: data.defaults.branch,
      basePath: "superschema",
      enabled: true,
    },
    owners: [],
    stages: data.defaults.stages,
  });
  const [rootEdited, setRootEdited] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<string>();
  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!busy) onOpenChange(value);
      }}
    >
      <DialogContent
        className="max-h-[90dvh] overflow-y-auto sm:max-w-3xl"
        showCloseButton={!busy}
      >
        <DialogHeader>
          <DialogTitle>New tenant</DialogTitle>
          <DialogDescription>
            Give this workspace its own content backend and access boundary.
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError(undefined);
            try {
              const result = await createTenantStorageAction({
                name,
                description,
                storage: mode,
                domainName,
                productName,
                ...(mode === "git" ? { git: profile } : {}),
              });
              if (result.error) {
                setError(result.error);
                return;
              }
              if (result.data?.notice) toast.message(result.data.notice);
              else toast.success("Tenant created");
              await onCreated();
              onOpenChange(false);
            } catch {
              setError("Could not reach the server. Retry tenant setup.");
            } finally {
              setBusy(false);
            }
          }}
        >
          <fieldset disabled={busy} className="flex min-w-0 flex-col gap-5">
            <TextField
              label="Tenant name"
              value={name}
              required
              maxLength={100}
              placeholder="Schema workspace"
              onChange={(e) => {
                setName(e.target.value);
                if (!rootEdited) {
                  const slug = e.target.value
                    .toLowerCase()
                    .replace(/[^a-z0-9]+/g, "-")
                    .replace(/^-|-$/g, "");
                  setProfile((old) => ({
                    ...old,
                    binding: {
                      ...old.binding,
                      basePath: `superschema${slug ? `/${slug}` : ""}`,
                    },
                  }));
                }
              }}
            />
            <TextField
              label="Description"
              value={description}
              maxLength={2000}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What belongs in this tenant?"
            />
            <StorageChoice
              value={mode}
              onChange={setMode}
              database={data.database}
            />
            <div className="grid gap-4 sm:grid-cols-2">
              <TextField
                label="Initial domain"
                value={domainName}
                onChange={(e) => setDomainName(e.target.value)}
                required
              />
              <TextField
                label="Initial product"
                value={productName}
                onChange={(e) => setProductName(e.target.value)}
                required
              />
            </div>
            {mode === "git" && (
              <div className="flex min-w-0 flex-col gap-4 border-t pt-4">
                {!data.app && (
                  <p className="rounded-lg bg-muted p-3 text-sm">
                    Configure the shared GitHub App on the Storage page before
                    creating a Git-backed tenant.
                  </p>
                )}
                <GitProfileFields
                  value={profile}
                  onChange={(next) => {
                    if (next.binding.basePath !== profile.binding.basePath)
                      setRootEdited(true);
                    setProfile(next);
                  }}
                />
                <p className="text-xs leading-5 text-muted-foreground">
                  We verify repository access before creating the tenant. You
                  can then connect your GitHub account, review the initial
                  import PR and index the merged contracts.
                </p>
              </div>
            )}
          </fieldset>
          {error && <FieldError className="my-4">{error}</FieldError>}
          <DialogFooter className="mt-5">
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={busy || (mode === "git" && !data.app)}
            >
              {busy && (
                <LoaderCircle
                  className="animate-spin"
                  data-icon="inline-start"
                />
              )}
              Create tenant
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

const STATUS: Record<string, string> = {
  database: "Database active",
  app_required: "App required",
  repository_required: "Repository required",
  workspace_required: "Workspace required",
  ready: "Git active",
  index_error: "Index needs attention",
  review: "Initial PR in review",
  sync_required: "Ready to index",
  bootstrap_required: "Initial import required",
};

export function TenantStorageSettings({ initial }: { initial: Snapshot }) {
  const router = useRouter();
  const [data, setData] = useState(initial),
    [mode, setMode] = useState<Mode>(initial.tenant.mode),
    [profile, setProfile] = useState<TenantGitProfile>(initial.profile);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string>(),
    [newTenant, setNewTenant] = useState(false);
  async function reload(reset = false) {
    const result = await tenantStorageSettingsAction();
    if (result.error || !result.data)
      throw new Error(result.error ?? "Could not refresh storage settings");
    setData(result.data);
    if (reset) {
      setMode(result.data.tenant.mode);
      setProfile(result.data.profile);
    }
    router.refresh();
  }
  async function run(operation: () => Promise<Outcome>, message: string) {
    setBusy(true);
    setError(undefined);
    try {
      const result = await operation();
      if (result.error) {
        setError(result.error);
        return false;
      }
      await reload();
      toast.success(message);
      return true;
    } catch {
      setError(
        "Could not complete storage setup. Refresh this page and retry.",
      );
      return false;
    } finally {
      setBusy(false);
    }
  }
  const modeChanged = mode !== data.tenant.mode;
  const profileVerified =
    data.binding?.enabled &&
    JSON.stringify(profile) === JSON.stringify(data.profile);
  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 p-4 sm:p-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-1.5">
          <Link
            href="/admin/tenant"
            className="text-xs text-muted-foreground hover:text-foreground"
          >
            Tenant / Storage
          </Link>
          <h1 className="text-2xl font-semibold tracking-tight">
            Tenant storage
          </h1>
          <p className="text-sm text-muted-foreground">
            <span className="font-medium text-foreground">
              {data.tenant.name}
            </span>{" "}
            · Choose where this tenant&apos;s contracts live.
          </p>
        </div>
        {data.canCreateTenant && (
          <Button onClick={() => setNewTenant(true)}>
            <Plus data-icon="inline-start" />
            New tenant
          </Button>
        )}
      </header>
      <section
        aria-label="Current storage"
        className="flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-muted/30 p-4"
      >
        <div className="flex min-w-0 items-center gap-3">
          {data.tenant.mode === "git" ? (
            <GitBranch className="size-5 shrink-0" />
          ) : (
            <Database className="size-5 shrink-0" />
          )}
          <div className="min-w-0">
            <p className="text-sm font-medium">
              {data.tenant.mode === "git"
                ? "GitHub is the content source"
                : `${data.database} is the content source`}
            </p>
            <p className="text-xs leading-5 text-muted-foreground">
              Storage is configured per tenant. Other tenants keep their own
              backend.
            </p>
          </div>
        </div>
        <Badge variant="outline">{STATUS[data.state]}</Badge>
      </section>
      {error && (
        <FieldError className="rounded-lg border border-destructive/30 p-3">
          {error}
        </FieldError>
      )}
      <section
        aria-labelledby="tenant-storage-backend"
        className="flex min-w-0 flex-col gap-4"
      >
        <div>
          <h2 id="tenant-storage-backend" className="font-medium">
            Content backend
          </h2>
          <p className="text-xs leading-5 text-muted-foreground">
            Users, access, settings and search indexes stay in the application
            database.
          </p>
        </div>
        <StorageChoice
          value={mode}
          onChange={setMode}
          database={data.database}
          disabled={busy}
        />
        {mode === "git" && (
          <form
            className="rounded-xl border p-4 sm:p-5"
            onSubmit={async (e) => {
              e.preventDefault();
              await run(
                () => saveTenantStorageProfileAction(profile),
                data.tenant.mode === "git" && data.state === "ready"
                  ? "Repository verified; workflow changes saved as private drafts in the GitOps workspace"
                  : "Repository verified and workflow settings saved",
              );
            }}
          >
            <fieldset disabled={busy} className="flex min-w-0 flex-col gap-5">
              <div>
                <h2 className="font-medium">Repository &amp; workflow</h2>
                <p className="text-xs leading-5 text-muted-foreground">
                  Use an entire repository or a dedicated folder. Environment
                  PRs use the same project by default.
                </p>
              </div>
              <GitProfileFields
                key={data.tenant.id}
                value={profile}
                onChange={setProfile}
              />
              <div className="flex flex-wrap items-center gap-3">
                <Button type="submit" disabled={!data.app}>
                  {busy && (
                    <LoaderCircle
                      data-icon="inline-start"
                      className="animate-spin"
                    />
                  )}
                  Verify &amp; save repository
                </Button>
                <span className="text-xs text-muted-foreground">
                  {data.app
                    ? "The App verifies access to every configured branch."
                    : "A platform administrator must configure the shared GitHub App first."}
                </span>
              </div>
            </fieldset>
          </form>
        )}
        {modeChanged && (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border p-4">
            <p className="max-w-xl text-sm leading-6 text-muted-foreground">
              {mode === "git"
                ? "Verify the repository first. Switching to Git pauses direct edits until you merge and index the initial import PR; your existing content stays readable."
                : data.canReturnToDatabase
                  ? "Resume direct authoring in this tenant's application database."
                  : "This tenant has Git history or drafts. Returning to database storage requires an explicit content migration."}
            </p>
            <Button
              disabled={
                busy ||
                (mode === "git" ? !profileVerified : !data.canReturnToDatabase)
              }
              onClick={() =>
                run(
                  () => setTenantStorageAction(mode, data.tenant.revision),
                  `${mode === "git" ? "Git" : "Database"} storage selected`,
                )
              }
            >
              Use {mode === "git" ? "GitHub" : "database"} storage
            </Button>
          </div>
        )}
      </section>
      {data.tenant.mode === "git" && (
        <section
          aria-labelledby="tenant-storage-readiness"
          className="flex flex-col gap-4 rounded-xl border p-4 sm:p-5"
        >
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 id="tenant-storage-readiness" className="font-medium">
                {data.state === "ready"
                  ? "Git repository status"
                  : "Finish Git setup"}
              </h2>
              <p className="text-xs leading-5 text-muted-foreground">
                {data.state === "ready"
                  ? "Merged contracts are indexed and available in the schema UI."
                  : "Review the initial import before Git becomes authoritative."}
              </p>
            </div>
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() =>
                run(
                  () => syncTenantStorageAction(),
                  "Repository indexing queued",
                )
              }
            >
              <RefreshCw data-icon="inline-start" />
              Index repository
            </Button>
          </div>
          <ol className="flex flex-col gap-4 text-sm">
            <li className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <span className="font-medium">
                  1. Connect your GitHub account
                </span>
                <p className="text-xs text-muted-foreground">
                  {data.github?.connected
                    ? `Connected as ${data.github.login}`
                    : "Source PRs are attributed to the person making the change."}
                </p>
              </div>
              <Button
                variant="outline"
                nativeButton={false}
                disabled={!data.app || busy}
                render={<a href="/api/gitops/connect?returnTo=settings" />}
              >
                <GitHubIcon data-icon="inline-start" />
                {data.github?.connected ? "Reconnect GitHub" : "Connect GitHub"}
              </Button>
            </li>
            <li className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <span className="font-medium">
                  2. Review the initial import
                </span>
                <p className="text-xs text-muted-foreground">
                  One PR per product exports current contracts into the selected
                  root.
                </p>
              </div>
              <Button
                variant="outline"
                disabled={
                  busy ||
                  !data.binding?.enabled ||
                  !data.github?.connected ||
                  data.state === "ready"
                }
                onClick={() =>
                  run(
                    () => bootstrapTenantStorageAction(),
                    "Initial import PRs are ready for review",
                  )
                }
              >
                Create initial PRs
              </Button>
            </li>
            <li>
              <span className="font-medium">
                3. Merge in GitHub, then index
              </span>
              <p className="text-xs text-muted-foreground">
                Merged entries appear in the schema UI and GitOps workspace.
                Keep the GitOps worker running for automatic updates.
              </p>
            </li>
          </ol>
          {data.binding?.lastError && (
            <FieldError className="break-words">
              {data.binding.lastError}
            </FieldError>
          )}
          {data.initialPrs.length > 0 && (
            <ul className="flex flex-col gap-2 border-t pt-3">
              {data.initialPrs.map((pr) => (
                <li
                  key={pr.id}
                  className="flex flex-wrap items-center justify-between gap-2 text-sm"
                >
                  <a
                    href={pr.prUrl ?? undefined}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex min-w-0 items-center gap-1.5 underline underline-offset-4"
                  >
                    {pr.productName} #{pr.prNumber}
                    <ExternalLink className="size-3 shrink-0" />
                  </a>
                  <Badge variant="outline">{pr.state}</Badge>
                </li>
              ))}
            </ul>
          )}
          <div className="flex flex-wrap gap-2 border-t pt-4">
            <Button
              variant="outline"
              nativeButton={false}
              render={<Link href="/admin/workflows/gitops" />}
            >
              Open GitOps workspace
            </Button>
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() =>
                run(async () => ({ data: true }), "Storage status refreshed")
              }
            >
              Refresh status
            </Button>
          </div>
        </section>
      )}
      {data.canManageApp && (
        <AppConfiguration
          key={data.app?.appId ?? "setup"}
          data={data}
          busy={busy}
          run={run}
        />
      )}
      {data.canCreateTenant && (
        <NewTenantDialog
          key={newTenant ? "open" : "closed"}
          data={data}
          open={newTenant}
          onOpenChange={setNewTenant}
          onCreated={() => reload(true)}
        />
      )}
    </div>
  );
}
