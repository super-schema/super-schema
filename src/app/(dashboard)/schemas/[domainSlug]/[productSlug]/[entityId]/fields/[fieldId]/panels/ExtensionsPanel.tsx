"use client";
import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import {
  FieldGroup,
  FieldDescription,
  FieldError,
} from "@/components/ui/field";
import {
  AttributeControl,
  SELECT_CLASS,
} from "@/components/custom/FieldAttributes/AttributeControl";
import type { Extensions } from "@/types/schemas/typespec-decorator.schema";

type ValueKind = "string" | "number" | "boolean" | "null" | "json";
function valueKind(v: unknown): ValueKind {
  return v === null
    ? "null"
    : typeof v === "object"
      ? "json"
      : (typeof v as ValueKind);
}
export function ExtensionsPanel({
  extensions,
  onChange,
}: {
  extensions: Extensions;
  showXml?: boolean;
  onChange: (v: Extensions) => void;
}) {
  const [key, setKey] = useState("");
  const [text, setText] = useState("");
  const [kind, setKind] = useState<ValueKind>("string");
  const [editing, setEditing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  function reset() {
    setKey("");
    setText("");
    setKind("string");
    setEditing(null);
    setError(null);
  }
  function save() {
    const name =
      editing && key.trim() === editing
        ? editing
        : key.trim().startsWith("x-")
          ? key.trim()
          : `x-${key.trim()}`;
    if (name === "x-") {
      setError("Enter an extension name.");
      return;
    }
    if (name !== editing && Object.hasOwn(extensions.openapi ?? {}, name)) {
      setError("This extension already exists. Edit its existing entry.");
      return;
    }
    try {
      let value: unknown = text;
      if (kind === "null") value = null;
      if (kind === "boolean") {
        if (!["true", "false"].includes(text))
          throw new Error("Choose true or false.");
        value = text === "true";
      }
      if (kind === "number") {
        value = Number(text);
        if (!text.trim() || !Number.isFinite(value))
          throw new Error("Enter a finite number.");
        if (Number.isInteger(value) && !Number.isSafeInteger(value))
          throw new Error(
            "Use a string to preserve integers beyond the safe numeric range.",
          );
      }
      if (kind === "json") value = JSON.parse(text);
      const entries = { ...extensions.openapi };
      if (editing) delete entries[editing];
      entries[name] = value;
      onChange({ ...extensions, openapi: entries });
      reset();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Enter a valid value.");
    }
  }
  return (
    <FieldGroup>
      <FieldDescription>
        Advanced schema metadata. Names use an x- prefix. JSON Schema and
        OpenAPI preserve these extensions; other targets may ignore them.
      </FieldDescription>
      {Object.entries(extensions.openapi ?? {}).map(([name, value]) => (
        <div
          key={name}
          className="flex min-w-0 flex-wrap items-start gap-2 rounded-md border border-border p-2"
        >
          <div className="min-w-0 flex-1">
            <code className="break-all text-xs">{name}</code>
            <pre className="whitespace-pre-wrap break-all text-xs text-muted-foreground">
              {JSON.stringify(value)}
            </pre>
          </div>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            aria-label={`Edit extension ${name}`}
            onClick={() => {
              setEditing(name);
              setKey(name);
              setKind(valueKind(value));
              setText(
                typeof value === "string" ? value : JSON.stringify(value),
              );
              setError(null);
            }}
          >
            Edit
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            aria-label={`Remove extension ${name}`}
            onClick={() => {
              const next = { ...extensions.openapi };
              delete next[name];
              onChange({ ...extensions, openapi: next });
              if (editing === name) reset();
            }}
          >
            Remove
          </Button>
        </div>
      ))}
      <AttributeControl label="Extension name">
        <Input
          value={key}
          spellCheck={false}
          placeholder="x-company-policy"
          onChange={(e) => setKey(e.target.value)}
        />
      </AttributeControl>
      <AttributeControl label="Extension value type">
        <select
          className={SELECT_CLASS}
          value={kind}
          onChange={(e) => {
            const value = e.target.value as ValueKind;
            setKind(value);
            if (value === "boolean") setText("false");
            setError(null);
          }}
        >
          {["string", "number", "boolean", "null", "json"].map((v) => (
            <option key={v} value={v}>
              {v}
            </option>
          ))}
        </select>
      </AttributeControl>
      {kind !== "null" && (
        <AttributeControl label="Extension value">
          {kind === "boolean" ? (
            <select
              className={SELECT_CLASS}
              value={text}
              onChange={(e) => setText(e.target.value)}
            >
              <option value="false">false</option>
              <option value="true">true</option>
            </select>
          ) : (
            <Textarea
              value={text}
              rows={kind === "json" ? 4 : 2}
              spellCheck={false}
              onChange={(e) => {
                setText(e.target.value);
                setError(null);
              }}
            />
          )}
        </AttributeControl>
      )}
      {error && <FieldError>{error}</FieldError>}
      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" disabled={!key.trim()} onClick={save}>
          {editing ? "Update extension" : "Add extension"}
        </Button>
        {editing && (
          <Button type="button" variant="ghost" size="sm" onClick={reset}>
            Cancel edit
          </Button>
        )}
      </div>
      {extensions.xml && Object.values(extensions.xml).some(Boolean) && (
        <details>
          <summary>Preserved XML settings</summary>
          <FieldDescription>
            XML settings are preserved for source compatibility. This
            application does not currently offer an XML output target.
          </FieldDescription>
          <pre className="whitespace-pre-wrap break-all text-xs">
            {JSON.stringify(extensions.xml, null, 2)}
          </pre>
        </details>
      )}
    </FieldGroup>
  );
}
