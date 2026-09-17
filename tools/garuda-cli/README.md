# GARUDA CLI 0.1.0

Local development CLI for the GARUDA fork of God's Eye View. No npm dependencies.
The CLI runs on Node 22+. App commands enforce the inspected package.json range:
`>=24.14.0 <25 || >=26 <27`. They refuse Node 22 and unfamiliar future ranges.

## Install / เริ่มใช้

From your GARUDA checkout on `feature/garuda-cli`:

```bash
node tools/garuda-cli/garuda.mjs init .
node tools/garuda-cli/garuda.mjs install-cli
export PATH="$HOME/.local/bin:$PATH"
garuda --version
garuda doctor
```

You may also use `sh ./garuda ...` without installing. `install-cli` copies only
the CLI into `~/.local/share/garuda-cli` and adds a `~/.local/bin/garuda` symlink.
No sudo, global npm install, Node upgrade or shell-profile edits. Add the PATH
line yourself to `~/.zshrc` to keep it for future terminals.

If Node is still v22, use your existing version manager to select supported Node.
With nvm already installed: `nvm install 24` then `nvm use 24`. Verify `node -v`.

## App

```bash
garuda deps  # runs npm ci; downloads packages and may run npm lifecycle scripts
garuda dev   # foreground at http://127.0.0.1:4173; Ctrl+C to stop
```

Only run scripts in a trusted checkout. This CLI does not edit package.json or
package-lock.json and does not force engine compatibility.

## GEV MCP companion

The GitHub addon does NOT vendor the separate GEV MCP Python package. Unzip the
previously supplied `gev-mcp-v0.1.0.zip`, or use the companion included in the
GARUDA CLI downloadable ZIP. Then configure its real absolute path:

```bash
garuda init --mcp-dir "$HOME/Downloads/gev-mcp"
garuda mcp install
garuda up
```

MCP needs Python 3.10+ (override with `--python /path/to/python3`). `mcp install`
creates local credentials and patches `src/main.js` with an opt-in bridge and a
backup, using the companion's reversible installer. `up` runs app and MCP in the
foreground and stops both on Ctrl+C. It never kills an unrelated port owner.
Use `garuda dev` / `garuda mcp serve` separately instead of running `up` twice.

In another terminal, run `garuda mcp token publisher`, copy the token locally,
open the app, enable relevant layers and click **MCP OFF**. Confirm sharing and
paste the token for `http://127.0.0.1:8765`. **Never post tokens in chat or Git.**
Reloading the page requires another opt-in. `up` does not silently opt you in.

## Queries / ค้นข้อมูล

```bash
garuda status
garuda layers
garuda context
garuda sources
garuda query flights --limit 10
garuda query flights --scope view --filter 'altitudeM:gt:10000'
garuda query vessels --text Southampton
garuda query vessels --filter 'speedKts:lt:5'
garuda get flights YOUR_RECORD_ID
garuda summary flights --field altitudeM --scope view
```

Output is JSON (also with `--json`) with snapshot identity, source, capture times,
coverage and truncation flags. Counts cover exported browser records only.
`no_snapshot` is not an empty world. Capture time is not observation time.
No records, positions or timestamps are fabricated. Missing values stay missing.

Aliases: vessels/ships = ais-live-vessels; fires = local-firms. Numeric fields:
lat, lon, altitudeM, speedMps, verticalRateMps, speedKts, courseDeg, frp, magnitude,
depthKm. Units stay those encoded by the field names.

Filters are ANDed, up to 8 `--filter field:operator:value` options. Operators:
eq, neq, contains, gt, gte, lt, lte (type checked). Numeric-looking text IDs stay
strings. `--bounds west,south,east,north` supports antimeridian crossing; do not
combine it with `--scope view`. Pagination: --limit 1..100, --offset and
--snapshot ID. If the pinned snapshot changes, the server rejects mixed pages.

## MCP client

`garuda mcp config` prints an entry named `garuda` with absolute paths and no
tokens. Merge that entry into your client's existing configuration, not over it.
`garuda mcp stdio` is protocol-only. Tool names remain `gev_*` for compatibility.
MCP is local loopback only; it is not a hosted ChatGPT connection.

## Boundaries

This is not LLM chat, voice recognition, web search, history, map control or
hardware control. Remote MCP URLs and redirects are refused. Only the existing
read-only snapshot tools are exposed. AI clients may send tool results to their
cloud models; check permissions before sharing. The GARUDA app itself may contact
its configured map/feed/AI providers.

CLI paths: ~/.garuda/cli.json (no tokens); MCP defaults to ~/.gev-mcp for private
credentials, snapshots and backups. Use --config/--state-dir for isolation.
Do not change the state directory between bridge install and uninstall.
`garuda mcp uninstall` restores only files unchanged since installation.

## Tests

From tools/garuda-cli:

```bash
GARUDA_TEST_MCP=/absolute/path/gev-mcp node --test tests/*.test.mjs
```

Without the companion, the real-MCP integration group is explicitly skipped.
See VERIFICATION.md. Full GARUDA/WebGL and upstream CI are not claimed tested.

## Sources

Inspected fork head: 0d41b6be5490db1f10a171f238be75db4d4ec3b4.
https://github.com/theerayutbo/GARUDA/blob/main/package.json
https://docs.npmjs.com/cli/commands/npm-ci/
https://nodejs.org/en/download/archive/v24.14.0

Original CLI code is MIT. Upstream code and third-party data retain their own
licenses. This addon changes neither map attribution nor dataset permissions.
