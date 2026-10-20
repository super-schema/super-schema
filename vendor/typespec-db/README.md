# @typespec/db (vendored)

Runtime copy of the `@typespec/db` TypeSpec library (shared database decorators: `@table`, `@primaryKey`, `@schema`, `@decimalPrecision`, ...), used by the generated sources of the Spanner / PostgreSQL / BigQuery targets (`src/lib/typespec-official/db-source.ts`).

## Where it came from

- Copied on 2026-10-19 from `typespec/release/staging/db/` in the sibling repository (`/Users/jsenjaliya/src/my/typespec`, gitignored staging directory): `package.json`, `lib/main.tsp`, and the built `dist/` (`dist/src`, `dist/generated-defs`, the `.js` and `.d.ts` files).
- The package source (`packages/db` in the sibling repository) was lost: that directory is hollow (only `dist/` leftovers, no `package.json`, no `lib/main.tsp`, no TypeScript source, nothing tracked in git). The staged build is the only complete copy there is. Keep this vendored directory until a real source of `@typespec/db` exists again.
- Left out: tests (`dist/test`), source maps (the `//# sourceMappingURL` comments were removed with them) and the declaration maps.

## Changes against the staged copy

- `package.json`: `peerDependencies["@typespec/compiler"]` relaxed from `^1.16.0` to `>=1.10.0` (this repository pins `@typespec/compiler` 1.10.0; the library compiles and works with it). `scripts` and `devDependencies` were dropped (they used the pnpm `catalog:` protocol, which npm cannot read, and a vendored runtime copy has nothing to build). The `files` entry `!dist/test/**` was dropped because `dist/test` is not copied.
- Nothing else was edited: `lib/main.tsp` and every `.js` / `.d.ts` file is byte-identical to the staged copy apart from the removed `sourceMappingURL` comment line.

## How it is installed

`package.json` declares `"@typespec/db": "file:vendor/typespec-db"` (same convention as `@superschema/typespec-enterprise`), so `node_modules/@typespec/db` is a symlink to `../../vendor/typespec-db`.
