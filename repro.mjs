// Minimal, self-contained reproduction of the Turso Cloud "create → serve" 404 race.
//
// What it shows: after the Platform API `POST /v1/organizations/{org}/databases` succeeds and the control
// plane (`GET /databases/{name}`) reports the database as existing, the database's libSQL DATA-PLANE
// endpoint does NOT serve for hundreds of ms (seconds, from outside the group's region) afterwards. A query
// in that window throws `LibsqlError: SERVER_ERROR: Server returned HTTP status 404`.
//
// It is NOT a client read-before-write: the harness records a data-plane 404 BOTH (a) at the moment the
// control plane first reports the db, AND (b) AFTER the create `POST` has returned 200 to the caller — and
// it only counts a reproduction when that same database LATER serves (proving the 404 was a transient
// create→serve gap, not a permanent failure / bad creds). The 404 is also byte-identical to the one a
// never-created database returns, so it is indistinguishable from "database not found".
//
// Requires env (no secrets are hardcoded):
//   TURSO_API_TOKEN         org-scoped Platform API token (create/list/delete databases)
//   TURSO_ORG               organization slug
//   TURSO_GROUP             group the databases are created in
//   TURSO_GROUP_AUTH_TOKEN  group auth token (libSQL connect credential)
// Optional: N (default 10) iterations.
//
//   npm i && TURSO_API_TOKEN=… TURSO_ORG=… TURSO_GROUP=… TURSO_GROUP_AUTH_TOKEN=… node repro.mjs
//
// Every database it creates is named `reprotest-*` and DELETED at the end (in a finally).
import { createClient } from "@libsql/client";

const API = "https://api.turso.tech";
const ORG = req("TURSO_ORG");
const API_TOKEN = req("TURSO_API_TOKEN");
const GROUP = req("TURSO_GROUP");
const GROUP_AUTH = req("TURSO_GROUP_AUTH_TOKEN");
const N = Number(process.env.N || 10);

function req(k) {
  const v = process.env[k];
  if (!v) {
    console.error(`missing env: ${k}`);
    process.exit(2);
  }
  return v;
}

const rnd = () => Math.random().toString(16).slice(2, 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function statusInCause(e) {
  for (let cur = e, i = 0; cur != null && i < 10; cur = cur.cause, i++) {
    if (typeof cur.status === "number") return cur.status;
  }
  return undefined;
}
function is404(e) {
  const msg = e instanceof Error ? e.message : String(e);
  return statusInCause(e) === 404 || /Server returned HTTP status 404/.test(msg);
}

async function createDb(name) {
  const r = await fetch(`${API}/v1/organizations/${ORG}/databases`, {
    method: "POST",
    headers: { authorization: `Bearer ${API_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ name, group: GROUP }),
  });
  const body = await r.text();
  if (!r.ok) throw new Error(`POST /databases ${r.status}: ${body.slice(0, 160)}`);
}
const deleteDb = (name) =>
  fetch(`${API}/v1/organizations/${ORG}/databases/${name}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${API_TOKEN}` },
  });
const controlPlaneStatus = (name) =>
  fetch(`${API}/v1/organizations/${ORG}/databases/${name}`, {
    headers: { authorization: `Bearer ${API_TOKEN}` },
  })
    .then((r) => r.status)
    .catch(() => -1);
async function dataPlaneQuery(name) {
  const c = createClient({ url: `libsql://${name}-${ORG}.turso.io`, authToken: GROUP_AUTH });
  try {
    await c.execute("SELECT 1");
    return "ok";
  } catch (e) {
    return is404(e) ? "404" : `err:${(e?.message || e).toString().slice(0, 40)}`;
  } finally {
    c.close();
  }
}

// Baseline: a never-created database returns the SAME HTTP 404 → the error alone is ambiguous.
const baseline = await dataPlaneQuery(`reprotest-never-${rnd()}`);
console.log(
  `baseline: data-plane query to a NEVER-created db → ${baseline}  (same HTTP 404 as the create→serve case)\n`,
);

let reproduced = 0;
let served = 0;
let inconclusive = 0;
const gaps = [];
const created = [];
try {
  for (let i = 0; i < N; i++) {
    const name = `reprotest-${rnd()}`;
    created.push(name);
    const t0 = Date.now();
    // Sample BOTH planes from one t0, concurrently with the create:
    //   • control sampler: the instant GET reports "exists", query the data plane ONCE (datapoint A).
    //   • data sampler:    keep querying the data plane until it actually serves (measures the gap's end).
    let controlExistsMs = null;
    let connectAtControl = null;
    let dataServesMs = null;
    const control = (async () => {
      while (controlExistsMs === null && Date.now() - t0 < 20000) {
        if ((await controlPlaneStatus(name)) === 200) {
          controlExistsMs = Date.now() - t0;
          connectAtControl = await dataPlaneQuery(name);
        } else await sleep(10);
      }
    })();
    const data = (async () => {
      while (dataServesMs === null && Date.now() - t0 < 20000) {
        if ((await dataPlaneQuery(name)) === "ok") dataServesMs = Date.now() - t0;
        else await sleep(10);
      }
    })();
    await createDb(name);
    const postAckMs = Date.now() - t0;
    // Datapoint B: a data-plane query issued AFTER the create POST has returned 200 to the caller. If THIS
    // 404s, it cannot be a read-before-write — the write call has demonstrably completed for the caller.
    const postAck = await dataPlaneQuery(name);
    await Promise.all([control, data]);

    const gap = dataServesMs !== null && controlExistsMs !== null ? dataServesMs - controlExistsMs : null;
    // Count a reproduction ONLY when the data plane 404'd (at control-exists or post-ack) AND the same db
    // LATER served — that proves a transient create→serve gap, not bad creds / permanent unavailability.
    const sawGap404 = connectAtControl === "404" || postAck === "404";
    if (sawGap404 && dataServesMs !== null) {
      reproduced++;
      if (gap !== null) gaps.push(gap);
    } else if (connectAtControl === "ok" || postAck === "ok") served++;
    else inconclusive++;
    console.log(
      `#${String(i + 1).padStart(2)} ${name}: POST-ack@${postAckMs}ms | control "exists"@${controlExistsMs}ms ` +
        `→ data@control=${connectAtControl} | data@post-ack=${postAck} | data serves@${dataServesMs}ms | gap=${gap}ms` +
        `${sawGap404 && dataServesMs !== null ? "  ← create→serve 404" : ""}`,
    );
  }
} finally {
  console.log("\ncleaning up…");
  let leaked = 0;
  for (const name of created) {
    const r = await deleteDb(name).catch(() => ({ ok: false, status: "network" }));
    if (!r.ok && r.status !== 404) {
      leaked++;
      console.error(`  delete ${name} failed: ${r.status}`);
    }
  }
  if (leaked) console.error(`⚠️  ${leaked} db(s) may have leaked — delete manually.`);
}

console.log(
  `\nRESULT: ${reproduced}/${N} reproduced the create→serve 404 (data plane 404'd at control-exists and/or ` +
    `after POST-ack, AND the db later served); served-immediately=${served}; inconclusive=${inconclusive}.`,
);
if (gaps.length) {
  gaps.sort((a, b) => a - b);
  console.log(
    `gap (control "exists" → data serves): min=${gaps[0]}ms median=${gaps[Math.floor(gaps.length / 2)]}ms max=${gaps.at(-1)}ms`,
  );
}
process.exit(reproduced > 0 ? 0 : 1);
