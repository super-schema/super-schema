"use client";

import { useState } from "react";
import { ArrowLeft, Wand2, AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";

interface NaturalLanguageInputProps {
  onSubmit: (description: string) => void;
  onBack: () => void;
  isLoading?: boolean;
  isAiConfigured?: boolean;
  error?: string | null;
}

export function NaturalLanguageInput({
  onSubmit,
  onBack,
  isLoading = false,
  isAiConfigured = false,
  error,
}: NaturalLanguageInputProps) {
  const [description, setDescription] = useState("");

  return (
    <div className="space-y-space-4">
      <button
        onClick={onBack}
        className="flex items-center gap-1 text-body-small text-muted-foreground hover:text-foreground transition-colors"
      >
        <ArrowLeft className="w-4 h-4" />
        Back
      </button>

      <div>
        <h3 className="text-heading-2 text-foreground mb-space-2">
          Describe your entity
        </h3>
        <p className="text-body-small text-muted-foreground mb-space-4">
          Describe the entity you want to create in natural language. The AI will generate
          a schema with suggested fields, types, and classifications.
        </p>
      </div>

      {!isAiConfigured && (
        <div data-testid="nl-ai-not-configured" role="status" className="flex items-start gap-space-3 p-space-4 rounded-lg border border-amber-500/30 bg-amber-500/5">
          <AlertCircle className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
          <div>
            <p className="text-body-small text-foreground font-medium">
              AI not configured
            </p>
            <p className="text-caption text-muted-foreground mt-1">
              Natural language entity generation requires a local LLM backend (Ollama or vLLM).
              Set the AI_PROVIDER and AI_BASE_URL environment variables to enable this feature.
              You can still use other creation methods.
            </p>
          </div>
        </div>
      )}

      <textarea
        data-testid="nl-description"
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder={`Example: "A customer entity for an e-commerce platform with name, email, shipping address, phone number, account creation date, and loyalty tier (bronze, silver, gold, platinum)"`}
        className="w-full h-32 bg-muted rounded-lg p-space-4 text-body text-foreground placeholder:text-muted-foreground/50 outline-none resize-none border border-border/50 focus:border-primary/40 transition-colors"
        disabled={!isAiConfigured || isLoading}
        autoFocus={isAiConfigured}
      />

      {error && (
        <p className="text-body-small text-destructive">{error}</p>
      )}

      <Button
        data-testid="nl-generate"
        onClick={() => onSubmit(description)}
        disabled={!description.trim() || !isAiConfigured || isLoading || description.trim().length < 10}
        className="gap-2"
      >
        <Wand2 className="w-4 h-4" />
        {isLoading ? "Generating..." : "Generate Schema"}
      </Button>
    </div>
  );
}
