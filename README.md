# Turso Cloud create→serve 404 race — minimal reproduction

After the Platform API **acknowledges** a database create, Turso's **control plane** reports the database
as existing within ~100ms — but the database's **libSQL data-plane endpoint does not serve for ~2.5
seconds afterward**, returning HTTP **404** in between. There is no readiness signal to wait on, and the
404 is **byte-identical** to the one a database that *never existed* returns — so it's indistinguishable
from "database not found".

```
LibsqlError: SERVER_ERROR: Server returned HTTP status 404
  (cause: HttpServerError, status 404)
```

## TL;DR

`repro.mjs` creates fresh databases and, for each, samples **both planes against one clock**:

```
baseline: data-plane query to a NEVER-created db → 404  (identical to the create→serve 404)

# 1 reprotest-cd7d1c04: POST-ack@456ms | control "exists"@75ms  → data query NOW=404 | data serves@2597ms | gap=2522ms  ← create→serve 404
# 2 reprotest-21600704: POST-ack@329ms | control "exists"@124ms → data query NOW=404 | data serves@2490ms | gap=2366ms  ← create→serve 404
# 3 reprotest-79cdd72b: POST-ack@292ms | control "exists"@125ms → data query NOW=404 | data serves@2504ms | gap=2379ms  ← create→serve 404
...
RESULT: 6/6 reproduced the create→serve 404 (control plane said "exists" AND the data plane returned 404); 0 served immediately.
```

Reproduces **6/6 – 10/10** every run.

## Run it

```sh
npm install
TURSO_API_TOKEN=…  TURSO_ORG=…  TURSO_GROUP=…  TURSO_GROUP_AUTH_TOKEN=…  node repro.mjs
# optional: N=20 node repro.mjs
```

- `TURSO_API_TOKEN` — org-scoped Platform API token (create/list/delete databases)
- `TURSO_ORG` — organization slug
- `TURSO_GROUP` — the group to create databases in
- `TURSO_GROUP_AUTH_TOKEN` — group auth token (the libSQL connect credential)

Every database it creates is named `reprotest-*` and **deleted at the end**. No credentials are hardcoded.

## What's happening (and how it's distinguished from a read-before-write)

Two planes, sampled on the same clock from `t0` (just before `POST /v1/organizations/{org}/databases`):

| signal | when |
|---|---|
| control plane `GET /databases/{name}` first returns `200` ("exists") | **~75–130ms** |
| `POST /databases` returns to the caller (the create is ACKed) | ~260–460ms |
| a data-plane `SELECT 1` issued **at the instant the control plane said "exists"** | **`404`** |
| the data-plane endpoint first actually serves | **~2.4–2.6s** |
| **gap (control "exists" → data serves)** | **~2.3–2.5s** |

The data-plane query happens **after** the control plane has confirmed the database exists — i.e. after
Turso has durably registered the create. So this is **not** a client reading before its write landed: the
write demonstrably landed (the control plane is an independent witness), yet the **same hostname, same
credentials** 404s for ~2.5s and then serves with no change on the caller's side. That is a control→data
propagation/serve gap **inside Turso**.

The `baseline` line proves the second half of the problem: a query to a database that was never created
returns the **identical** 404, so the error on its own cannot tell "not ready yet" from "doesn't exist".

## Region

Measured from a client **outside** the group's region the gap is ~2.5s (above). **In-region** (e.g. a
Vercel function in `iad1` against an `aws-us-east-1` group) the control plane reports "exists" within
~20ms and the gap is shorter, but it is **still reliably hit**: a fan-out of cold readers that connect at
the "exists" signal saw **62/80** queries 404 across **7/8** fresh databases in `iad1`. The window exists
both in- and cross-region; it is merely larger the farther the reader is from the group.

## Why it's a problem

A database-per-tenant / per-session / per-agent pattern (what Turso markets Cloud for) creates a fresh
database on the hot path. Any reader that connects based on the control plane's "exists" signal — a
separate process, a cold serverless instance, a second request — lands in this window and 404s on the
first query of a brand-new database.

## Suggested fixes (any one helps)

1. **A readiness signal.** Expose database status (`provisioning` → `ready`) on the Platform API, or don't
   let `GET /databases/{name}` return `200` until the data-plane endpoint serves.
2. **Make the not-ready response unambiguous.** Return a distinct, retryable status (e.g. `425 Too Early` /
   `409` / a `provisioning` error code) instead of a bare `404` that collides with "does not exist".
3. **Make `POST /databases` not ACK until the endpoint serves** (synchronous create), so the create's
   completion is itself the readiness signal.

## Workaround we use today

A client-side readiness gate: after opening a connection to a freshly-created database, probe `SELECT 1`
with bounded exponential backoff, retrying **only** the 404 / unresolved-host transients, before treating
the connection as usable. It reliably absorbs the window — but it's a guess at an opaque, unbounded delay
that a readiness signal would make unnecessary.
