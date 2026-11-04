// The pure parts of `npm run import:git` (scripts/import-git.ts): argument parsing, the URL list file and the report summary.
// Dependency-free; unit tested in tests/unit/scripts/import-git-cli.test.ts.

const FLAGS_WITH_VALUE = new Set(["--domain", "--product", "--file", "--report", "--git-mode", "--user"]);

/**
 * @param {string[]} argv
 * @returns {{ ok: true, options: { domain?: string, product?: string, dryRun: boolean, urls: string[], files: string[], report?: string, gitMode?: string, user?: string } } | { ok: false, error: string }}
 */
export function parseImportArgs(argv) {
  const options = { domain: undefined, product: undefined, dryRun: false, urls: [], files: [], report: undefined, gitMode: undefined, user: undefined };
  for (let i = 0; i < argv.length; i++) {
    let arg = argv[i];
    let value;
    const eq = arg.startsWith("--") ? arg.indexOf("=") : -1;
    if (eq > 0) {
      value = arg.slice(eq + 1);
      arg = arg.slice(0, eq);
    }
    if (arg === "--dry-run") options.dryRun = true;
    else if (FLAGS_WITH_VALUE.has(arg)) {
      value = value ?? argv[++i];
      if (value === undefined || value === "") return { ok: false, error: `${arg} needs a value` };
      if (arg === "--file") options.files.push(value);
      else if (arg === "--domain") options.domain = value;
      else if (arg === "--product") options.product = value;
      else if (arg === "--report") options.report = value;
      else if (arg === "--git-mode") options.gitMode = value;
      else options.user = value;
    } else if (arg.startsWith("--")) return { ok: false, error: `unknown argument "${arg}"` };
    else if (/^https:\/\//i.test(arg)) options.urls.push(arg);
    else return { ok: false, error: `"${arg}" is not an https URL` };
  }
  if (options.gitMode !== undefined && !["any", "restricted"].includes(options.gitMode)) return { ok: false, error: '--git-mode is "any" or "restricted"' };
  if (!options.dryRun && !options.domain) return { ok: false, error: "--domain <name> is required (or --dry-run)" };
  if (!options.dryRun && !options.product) return { ok: false, error: "--product <name> is required (or --dry-run)" };
  if (options.urls.length === 0 && options.files.length === 0) return { ok: false, error: "give at least one https URL (or --file <list>)" };
  return { ok: true, options };
}

/** One https URL per line; blank lines and `#` comments ignored; duplicates dropped; order kept. @param {string} text */
export function parseUrlList(text) {
  const seen = new Set();
  const urls = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || seen.has(line)) continue;
    seen.add(line);
    urls.push(line);
  }
  return urls;
}

/** @param {{ imported: string[], skipped: string[], failed: string[], unresolved: string[], notes: string[] }} report */
export function summarizeReport(report) {
  const count = (kind) => report.imported.filter((line) => line.startsWith(`${kind} `)).length;
  const distinct = new Set(report.unresolved).size;
  return `imported ${count("entity")} entities, ${count("enum")} enums, ${count("scalar")} scalars, ${count("union")} unions; ${report.skipped.length} skipped; ${report.failed.length} failed; ${distinct} distinct unresolved reference(s)`;
}
