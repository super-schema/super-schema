# Developer Guide

How to set up Super Schema for local development.

## Prerequisites

- Node.js 22 (see `.nvmrc`; `package.json` accepts `>=20.9.0 <25`)
- npm (Super Schema itself)
- pnpm (only for building the sibling TypeSpec checkout; see below)

## Repository layout

Super Schema depends on a **sibling TypeSpec checkout**. Five TypeSpec emitter
packages are not on npm and are installed from that checkout by relative path
(`package.json`):

```json
"@typespec/avro":      "file:../typespec/packages/avro",
"@typespec/bigquery":  "file:../typespec/packages/bigquery",
"@typespec/java-pojo": "file:../typespec/packages/java-pojo",
"@typespec/postgres":  "file:../typespec/packages/postgres",
"@typespec/spanner":   "file:../typespec/packages/spanner",
```

So both repositories must sit in the **same parent directory**:

```
<parent>/
├── super-schema/
└── typespec/        # checkout whose packages/ has avro, bigquery, java-pojo, postgres, spanner
```

These five packages exist only on our TypeSpec branch, not in upstream
`microsoft/typespec` `main`. Check out the branch that has them.

All other TypeSpec packages (`@typespec/compiler`, `openapi3`, `json-schema`,
`protobuf`, the `http-*` emitters, ...) come from npm as normal.

## First-time setup

### 1. Build the TypeSpec emitters

npm links the five packages as symlinks into `node_modules/@typespec/`. Each
package's entry point is `dist/src/index.js`, and **`dist/` is not committed**,
so they must be built before Super Schema can load them.

```sh
cd <parent>/typespec
pnpm install
pnpm --filter "@typespec/avro..." --filter "@typespec/bigquery..." \
     --filter "@typespec/java-pojo..." --filter "@typespec/postgres..." \
     --filter "@typespec/spanner..." build
```

The trailing `...` on each filter also builds the packages' workspace
dependencies (the TypeSpec compiler) first. You don't need the monorepo-wide
`pnpm build`.

### 2. Install and run Super Schema

```sh
cd <parent>/super-schema
npm install
npm run dev
```

The database needs no configuration: PGlite is the default. See
[`docs/database.md`](./database.md) for PostgreSQL and migrations.

## Keeping the TypeSpec emitters current

Super Schema loads the emitters' **built** output through symlinks. After you
pull or edit anything in `<parent>/typespec`, rerun the `pnpm --filter … build`
command above and restart `npm run dev`. If you don't rebuild, Super Schema
keeps running the old `dist/`.

## Verifying the emitters

Run an emitter with the same `tsp` invocation the app uses
(`src/lib/typespec-official/emitter.service.ts`):

```sh
cd <parent>/super-schema
W=$(mktemp -d) && ln -s "$PWD/node_modules" "$W/node_modules"
cat > "$W/main.tsp" <<'EOF'
import "@typespec/postgres";
using TypeSpec.Postgres;
@schema("demo")
namespace Demo;
model Order { @primaryKey id: string; qty: int32; }
EOF
printf 'emit: ["@typespec/postgres"]\noptions:\n  "@typespec/postgres":\n    emitter-output-dir: "{project-root}/out"\n' > "$W/tspconfig.yaml"
(cd "$W" && "$OLDPWD/node_modules/.bin/tsp" compile main.tsp --config tspconfig.yaml)
cat "$W"/out/*.sql
```

The `bigquery`, `postgres` and `spanner` emitters only write tables for models
inside a namespace decorated with `@schema(...)`, and each table needs a
`@primaryKey` field. Without those, the compile succeeds but writes no files.
The app adds both decorators itself (`src/lib/typespec-official/db-source.ts`).

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `import "@typespec/<pkg>" is not allowed: it is not an installed TypeSpec library` | `node_modules/@typespec/<pkg>` is missing or is a dangling symlink: `../typespec` isn't next to `super-schema` | Put the TypeSpec checkout at `<parent>/typespec` (or symlink it there), then run `npm install` |
| Same error, symlink resolves | The package isn't built (no `dist/`) | Run the build in [step 1](#1-build-the-typespec-emitters) |
| `Emitter "@typespec/<pkg>" completed but did not write any files` | The source has no `@schema` namespace or no `@primaryKey` (bigquery / postgres / spanner) | Give the entity a primary key; check the generated TypeSpec |
| Emitter output ignores recent TypeSpec changes | Stale `dist/` | Rebuild ([Keeping the TypeSpec emitters current](#keeping-the-typespec-emitters-current)) |

Check the links quickly:

```sh
for p in avro bigquery java-pojo postgres spanner; do
  test -f node_modules/@typespec/$p/dist/src/index.js && echo "ok   $p" || echo "MISS $p"
done
```
