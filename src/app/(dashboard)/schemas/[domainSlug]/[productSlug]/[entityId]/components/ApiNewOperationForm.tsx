"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { HTTP_METHODS, type ApiOperation } from "@/types/schemas/api-operation";
import type { ApiOperationIssue } from "@/lib/api-operations/validate";
import { collectionPath, issuesByPath, recordFromOperation, syncPathParameters, validateDraft, type OperationDraft } from "./api-tab-model";
import { FieldError, LABEL } from "./ApiFormControls";

import { NativeSelect } from "@/components/ui/native-select";
interface ApiNewOperationFormProps {
  entityName: string;
  siblings: readonly OperationDraft[];
  /** Resolves with the server's issues ([] when created). */
  onCreate: (op: ApiOperation) => Promise<ApiOperationIssue[]>;
  onCancel: () => void;
}

/** The "New Operation" form: name, method, path (its `{placeholders}` become path parameters), description. */
export function ApiNewOperationForm({ entityName, siblings, onCreate, onCancel }: ApiNewOperationFormProps) {
  const [name, setName] = useState("");
  const [method, setMethod] = useState<ApiOperation["httpMethod"]>("GET");
  const [path, setPath] = useState(collectionPath(entityName));
  const [description, setDescription] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [serverIssues, setServerIssues] = useState<ApiOperationIssue[]>([]);
  const [busy, setBusy] = useState(false);

  const op: ApiOperation = {
    name: name.trim(),
    summary: "",
    description,
    httpMethod: method,
    httpPath: path.trim(),
    tags: [],
    deprecated: false,
    parameters: syncPathParameters([], "", path.trim()),
    requestBody: null,
    responses: [{ statusCode: 200, type: entityName, isArray: false, contentType: "application/json", description: "Successful response" }],
  };
  // Client issues show once the user tried to create (no red on a fresh form); server issues always.
  const clientIssues = submitted ? validateDraft(recordFromOperation("", "", op), siblings) : [];
  const errors = issuesByPath([...serverIssues, ...clientIssues]);
  const general = [...serverIssues, ...clientIssues].filter((i) => !["name", "httpMethod", "httpPath", "description"].includes(i.path));

  const create = async () => {
    setSubmitted(true);
    if (!op.name || validateDraft(recordFromOperation("", "", op), siblings).length) return;
    setBusy(true);
    const issues = await onCreate(op);
    setBusy(false);
    setServerIssues(issues);
  };

  return (
    <div className="rounded-lg border border-primary/30 bg-primary/5 p-space-4 space-y-space-3" data-testid="api-new-operation">
      <h3 className="text-body-small font-semibold text-foreground">New Operation</h3>
      <div className="grid grid-cols-2 gap-space-2">
        <div>
          <label htmlFor="api-new-name" className={LABEL}>Name</label>
          <Input
            id="api-new-name"
            value={name}
            onChange={(e) => { setName(e.target.value); setServerIssues([]); }}
            data-testid="api-op-name"
            placeholder="getUser"
            aria-invalid={errors.name ? true : undefined}
            className="h-8 font-mono"
            autoFocus
          />
          <FieldError message={errors.name} />
        </div>
        <div>
          <label htmlFor="api-new-method" className={LABEL}>Method</label>
          <NativeSelect
            id="api-new-method"
            data-testid="api-op-method"
            value={method}
            onChange={(e) => { setMethod(e.target.value as ApiOperation["httpMethod"]); setServerIssues([]); }}
            className="h-8 w-full"
          >
            {HTTP_METHODS.map((m) => <option key={m} value={m}>{m}</option>)}
          </NativeSelect>
        </div>
      </div>
      <div>
        <label htmlFor="api-new-path" className={LABEL}>Path</label>
        <Input
          id="api-new-path"
          value={path}
          data-testid="api-op-path"
          onChange={(e) => { setPath(e.target.value); setServerIssues([]); }}
          placeholder="/users/{id}"
          aria-invalid={errors.httpPath ? true : undefined}
          className={cn("h-8 font-mono")}
        />
        <FieldError message={errors.httpPath} />
      </div>
      <div>
        <label htmlFor="api-new-description" className={LABEL}>Description</label>
        <Input
          id="api-new-description"
          value={description}
          data-testid="api-op-description"
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Retrieve a user by ID"
          className="h-8"
        />
      </div>
      {general.length > 0 && (
        <ul role="alert" className="text-[11px] text-destructive space-y-0.5">
          {general.map((i, n) => <li key={n}>{i.path ? `${i.path}: ` : ""}{i.message}</li>)}
        </ul>
      )}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
        <Button size="sm" onClick={() => void create()} disabled={!name.trim() || busy} data-testid="api-op-create">
          Create Operation
        </Button>
      </div>
    </div>
  );
}
