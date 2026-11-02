/**
 * The text to show for a failed call: the error's own message when it has one, otherwise a generic line. Client components use it for
 * toasts and inline errors, so a rejected server action always says something.
 */
export function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : "Unexpected error";
}
