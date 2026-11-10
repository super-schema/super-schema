/** Shared by the deployment form and server so the visible default is the submitted title. */
export function generatedGitPrTitle(input: { schema: string; format: string; version: number | string; environment: string; contractVersion: string }): string {
  return `Publish ${input.schema}: ${input.format} v${input.version} → ${input.environment} (${input.contractVersion})`.slice(0, 250);
}
