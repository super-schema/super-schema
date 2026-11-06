# Bulk import from a git host: `npm run import:git`

Imports JSON Schema documents (and every file they `$ref`) from an internal git host into a domain and product, with the same
importer and entity-creation code the "From URL" dialog uses. It exists for the cases where clicking through the dialog file by file is
impractical: a specification repository with a dozen schemas plus the shared-component repositories they point at.

```bash
# a spec repository into identity / Accounts
npm run import:git -- --domain identity --product Accounts \
  https://github.paypal.com/<org>/<repo>/blob/master/v1/schema/json/account_closed_event.json \
  https://github.paypal.com/<org>/<repo>/blob/master/v1/schema/json/login_event_schema.json

# the shared components it references, into a product of the same domain (one URL per line, `#` comments allowed)
npm run import:git -- --domain identity --product Common --file common-urls.txt --report common.json

# look first, write nothing (no database needed)
npm run import:git -- --dry-run --report preview.json <url> ...
```

| Option | Meaning |
|--------|---------|
| `--domain`, `--product` | target; created when missing (required unless `--dry-run`) |
| `--file <list>` | URLs, one per line; repeatable |
| `--report <file>` | full JSON: `imported`, `skipped`, `failed`, `unresolved`, `notes`, `perUrl` counts |
| `--git-mode any\|restricted` | overrides `SCHEMA_IMPORT_GIT_MODE` for this run |
| `--user <email>` | owner of the created entities (default: the first user) |
| `--dry-run` | fetch and parse only |

## Rules

- **Git access** is the importer's policy: `SCHEMA_IMPORT_GIT_MODE` / `SCHEMA_IMPORT_GIT_SCOPES` (`.env.example`). A refused repository is
  reported with the setting to change, e.g. `SCHEMA_IMPORT_GIT_SCOPES=ApiSpecifications-R`. Fetching uses the machine's `gh` login.
- **Idempotent.** An asset that already exists in the line is skipped and reported, so a partly failed run can be repeated.
- **Import order does not matter.** A field whose `$ref` could not be loaded is kept as a dangling reference (listed under `unresolved`);
  importing the referenced file later links it.
- **Shared references** that live in other repositories (a `../common_components/...` path that only resolves in a Maven build) cannot be
  fetched from the spec repository. Import them from their own repository URL (the `unresolved` list shows the paths).
- **One process on the embedded database.** Stop the dev server first (or set `PGLITE_DATA_DIR` to another directory). Exit code is 1
  when any URL failed, 2 for bad arguments.
