# GARUDA CLI verification — 17 September 2026

Runtime exercised: Linux, Node v22.16.0, Python 3.13.5. Development preview,
not a production certification or a full security audit.

`GARUDA_TEST_MCP=/absolute/path/gev-mcp node --test tests/*.test.mjs`

Observed: 64 tests passed, 0 failed, 0 skipped with the GEV MCP 0.1.0 companion.
49 base CLI tests plus the real-MCP group (12 subtests) and 2 lifecycle tests.
An initial failing test run preceded implementation; later regressions reproduced
an installed-symlink entry-point bug and irrelevant option handling before fixes.

Verified: Node-range boundaries; loopback and redirect restrictions; field-typed
filters (including leading-zero identities); config-only init; private config;
installed command; conflict refusal; HTTP authorization; no-snapshot semantics;
real Node client / Python bridge querying, statistics, provenance, unknown
observation times, truncation and snapshot pinning; stdio-only protocol; reversible
bridge patching against a matching entry-point fixture; child-process shutdown.

Companion baseline separately rerun: 49 Python tests plus 8 JavaScript adapter
tests passed. These are not 57 additional CLI tests.

Not tested: full GARUDA/WebGL UI, live map/data providers, real user's Mac,
Node 24/26 runtime execution, full app npm ci/build, cloud AI clients, public
HTTPS/OAuth, or upstream project's complete CI. App startup supervision was
exercised with local processes, not a production GEV browser session.

Synthetic fixture records are explicitly labeled simulated and are used only by
tests. No credentials or snapshots are shipped in this source addon.
