export function generateSlug(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s_-]/g, '')  // keep underscores
    .replace(/[\s_]+/g, '-')         // spaces AND underscores → hyphens
    .replace(/-+/g, '-')             // collapse multiple hyphens
    .replace(/^-|-$/g, '');           // trim leading/trailing hyphens
}
