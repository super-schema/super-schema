# Installing when the lockfile names another npm registry

`package-lock.json` records the registry host in each `resolved` URL. If your npm registry is a different host (a corporate
mirror that does not serve the recorded one), `npm ci` stops on the first package that host refuses, for example
`403 Forbidden - GET https://<old-host>/.../zustand-4.5.7.tgz`.

The committed lockfile is mixed today (most URLs on one Artifactory host, some on the current mirror), so this is expected.

## Install without changing the committed lockfile

```bash
cp package-lock.json /tmp/package-lock.orig
npm run lockfile:registry            # rewrite `resolved` to `npm config get registry`, in place
npm ci
cp /tmp/package-lock.orig package-lock.json   # or: git checkout package-lock.json
```

`integrity` hashes are untouched, so npm still verifies every tarball.

## Options

| Command | Effect |
|---------|--------|
| `npm run lockfile:registry` | rewrite to the configured registry |
| `npm run lockfile:registry -- --registry <url>` | rewrite to `<url>` |
| `npm run lockfile:registry -- --drop` | remove registry `resolved` URLs; npm resolves from the configured registry |
| `npm run lockfile:registry -- --check` | exit 1 and list hosts if any URL is on another host; writes nothing |
| `... -- --file <p> --out <p>` | read `<p>`, write the result to another file |

Links, git and file dependencies are never changed, and running it twice changes nothing.
