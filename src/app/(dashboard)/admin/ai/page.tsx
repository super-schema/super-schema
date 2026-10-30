import { AiSettingsForm } from "@/components/custom/admin/AiSettingsForm";

/**
 * Admin Panel — AI tab.
 * The AI provider behind natural-language entity creation and field suggestions. What is saved here wins over the server environment.
 */
export default function AdminAiPage() {
  return (
    <div className="space-y-space-4">
      <div>
        <h2 className="text-heading-3 text-foreground">AI</h2>
        <p className="text-body-small text-muted-foreground">
          Choose the local LLM server used for natural-language entity creation and field suggestions. Values saved here take precedence over the
          server environment.
        </p>
      </div>
      <AiSettingsForm />
    </div>
  );
}
