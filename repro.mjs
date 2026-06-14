// Minimal, self-contained reproduction of the Turso Cloud "create → serve" 404 race.
//
// What it shows: after the Platform API `POST /v1/organizations/{org}/databases` succeeds and the control
// plane (`GET /databases/{name}`) reports the database as existing, the database's libSQL DATA-PLANE
// endpoint does NOT serve for hundreds of ms (seconds, from outside the group's region) afterwards. A query
// in that window throws `LibsqlError: SERVER_ERROR: Server returned HTTP status 404`.
//
// Crucially, this 404 is IDENTICAL to the one a never-created database returns, so it is indistinguishable
// from "database does not exist", and there is no readiness signal to wait on.
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
// Every database it creates is named `reprotest-*` and DELETED at the end.
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

function is404(e) {
  const status = e?.cause?.status ?? e?.status;
  const msg = e instanceof Error ? e.message : String(e);
  return status === 404 || /Server returned HTTP status 404/.test(msg);
}

const createDb = (name) =>
  fetch(`${API}/v1/organizations/${ORG}/databases`, {
    method: "POST",
    headers: { authorization: `Bearer ${API_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ name, group: GROUP }),
  }).then((r) => r.text());
const deleteDb = (name) =>
  fetch(`${API}/v1/organizations/${ORG}/databases/${name}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${API_TOKEN}` },
  }).catch(() => {});
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

// Baseline: a never-created database returns the SAME 404 → the error alone is ambiguous.
const baseline = await dataPlaneQuery(`reprotest-never-${rnd()}`);
console.log(
  `baseline: data-plane query to a NEVER-created db → ${baseline}  (identical to the create→serve 404)\n`,
);

let reproduced = 0;
let served = 0;
const gaps = [];
const created = [];
for (let i = 0; i < N; i++) {
  const name = `reprotest-${rnd()}`;
  created.push(name);
  const t0 = Date.now();
  // Sample BOTH planes from one t0, concurrently with the create:
  //   • control sampler: the instant GET reports "exists", query the data plane ONCE (the key datapoint).
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
  await Promise.all([control, data]);

  const gap = dataServesMs !== null && controlExistsMs !== null ? dataServesMs - controlExistsMs : null;
  if (connectAtControl === "404") {
    reproduced++;
    if (gap !== null) gaps.push(gap);
  } else if (connectAtControl === "ok") served++;
  console.log(
    `#${String(i + 1).padStart(2)} ${name}: POST-ack@${postAckMs}ms | control "exists"@${controlExistsMs}ms ` +
      `→ data query NOW=${connectAtControl} | data serves@${dataServesMs}ms | gap=${gap}ms` +
      `${connectAtControl === "404" ? "  ← create→serve 404" : ""}`,
  );
}

console.log("\ncleaning up…");
for (const name of created) await deleteDb(name);

console.log(
  `\nRESULT: ${reproduced}/${N} reproduced the create→serve 404 (control plane said "exists" AND the data plane returned 404); ${served} served immediately.`,
);
process.exit(reproduced > 0 ? 0 : 1);
