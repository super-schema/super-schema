/**
 * What the Schemas tab says when `publishSchemaAction` did not publish a version. Most refusals are plain error toasts. A PREVIEW (a
 * version generated from the saved draft of the entities it references, `needsPublishedRegeneration`) comes with a one-click way out
 * on the same toast: regenerate the target from the published versions and publish the result (`publishSchemaAction(..., {
 * regenerateFromPublished: true })`). Pure, client-safe: the component passes what the toast calls.
 */

/** Long enough to read the message (it names the draft entities) and reach for the button. */
export const PUBLISH_REFUSAL_DURATION_MS = 15_000;

export const REGENERATE_AND_PUBLISH_LABEL = "Regenerate from published and publish";

/** The arguments of `toast.error(message, options)`; no `options` for a plain refusal. */
export interface PublishRefusalToast {
  message: string;
  options?: { duration: number; action: { label: string; onClick: () => void } };
}

export function publishRefusalToast(
  refusal: { error: string; needsPublishedRegeneration?: boolean },
  regenerateAndPublish: () => void
): PublishRefusalToast {
  if (!refusal.needsPublishedRegeneration) return { message: refusal.error };
  return {
    message: refusal.error,
    options: { duration: PUBLISH_REFUSAL_DURATION_MS, action: { label: REGENERATE_AND_PUBLISH_LABEL, onClick: regenerateAndPublish } },
  };
}
