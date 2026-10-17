# AFTERIMAGE

**AFTERIMAGE remembers why a software release was approved.**

When a dependency changes, previous integration evidence may no longer describe the new configuration. AFTERIMAGE is a local decision-support prototype that stores release revisions, requirements, evidence, and decisions as a **directed graph in FalkorDB**, marks affected approvals as needing review, and lets a **tool-using agent** investigate graph paths and propose **internal** review actions (evidence requests and reassessment). It does **not** deploy software, run CI, or claim that a release is “safe.”

| | |
|---|---|
| **Tracks** | Agents That Act on Connected Data; Agent Memory and Coordination |
| **Stack** | TypeScript / Express / React + Vite / FalkorDB (Docker) / OpenRouter (optional for live agent runs) |
| **Authority** | FalkorDB is the source of truth; the browser never receives unrestricted Cypher or DB credentials |

---

## 1. Problem and users

### Problem

Release approvals are often snapshots: “checkout-r1 was approved against payment-api v2.” After a dependency bump to v3, teams need to know:

- Does that approval still apply?
- What evidence covered the old configuration?
- What is missing for the new revision?
- What did we decide earlier, and why?

AFTERIMAGE answers those questions from **stored graph relationships and a deterministic policy**, not from free-form model prose.

### Intended users

- Release coordinators who need a clear “why” after a dependency change 
- Reviewers who want inspectable evidence paths and immutable history 
- Teams evaluating **agent + graph** patterns for internal review workflows 

This is **not** a production release gate, multi-tenant SaaS, or safety guarantee.

### Canonical journey (product loop)

1. **Baseline** — Seed or open a workspace. `checkout-r1` is approved under a small demonstration policy; `docs-r1` is an independent control release. 
2. **Dependency change** — A structured event changes `checkout-r1` to target `payment-api` v3. A **new immutable revision** is created. The previous approval remains in history but is no longer current. 
3. **Selective impact** — `checkout-r1` becomes **Needs review** (v2-scoped evidence does not establish v3). `docs-r1` stays **Approved**. 
4. **Investigation** — An agent run uses bounded tools (`get_release_context`, `find_affected_releases`, `inspect_evidence`, `get_decision_history`, `evaluate_release`, `propose_review_action`) to traverse the graph and cite real record IDs. 
5. **Internal proposals** — The model may propose creating an **evidence request**, resolving a satisfied request, or recording a **reassessment**. A human applies proposals in the UI; the backend re-validates with the deterministic policy and workspace revision. 
6. **Matching evidence** — A synthetic PASS (or FAIL) is recorded for the **new** revision and requirement. 
7. **Explicit reassessment** — Only a recorded decision (policy evaluation) changes release status. 
8. **Session recovery** — History, tasks, and runs persist in FalkorDB across browser and process restarts.

> A resolved evidence request means the **task board** is closed after matching evidence. It does **not** by itself mean the release is approved—approval always follows a recorded decision from policy evaluation.

---

## 2. Why FalkorDB

FalkorDB stores **domain truth and relationships** in one place the backend can query with parameterized Cypher:

- **Impact** is reverse traversal (`(DependencyVersion)<-[:DEPENDS_ON]-(ReleaseRevision)`), not a hardcoded release list. 
- **Applicability** of evidence is edge-based (`FOR_REVISION`, `SATISFIES_CHECK`, `FROM_SOURCE`) plus explicit `SUPERSEDES` / `WITHDRAWS` history. 
- **Decisions** point at the revision they assessed (`ASSESSES`) and at supporting evidence (`SUPPORTED_BY`); old decisions are kept (`REPLACES` links prior decisions). 
- Agent tools and the policy evaluator **read the same graph**; there is no parallel authoritative JSON dump the model must “imagine.”

Without FalkorDB, reads and writes fail explicitly. Seed files are **fixtures**, not runtime authority.

### Graph model (as implemented)

All nodes carry application string IDs and `workspaceId`. Public IDs are never DB internal keys.

| Label | Role |
| --- | --- |
| `Workspace` | Monotonic `revision` counter for optimistic concurrency |
| `Release` | Named release; `currentRevisionId`, `currentDecisionId` pointers |
| `ReleaseRevision` | Immutable revision (`revisionNumber`, `policyVersion`) |
| `DependencyVersion` | Named dependency + version (e.g. `payment-api` / `2.0.0`) |
| `Requirement` | Check scoped to a revision (`checkKind`, description) |
| `Evidence` | Observed outcome for a revision/check (`synthetic=true` in demo) |
| `Source` | Allowlisted or untrusted authority |
| `Decision` | Policy outcome for a revision (`status`, `reasonCodes`, …) |
| `Event` | Structured mutation log (`type`, `idempotencyKey`, `applicationState`) |
| `ReviewTask` | Internal evidence request (`OPEN` / `RESOLVED`) |
| `AgentRun` / `Proposal` | Bounded investigation trace and human-applied proposals |

### Relationship directions (as implemented)

```
Release -HAS_REVISION-> ReleaseRevision
Release -CURRENT_REVISION-> ReleaseRevision

ReleaseRevision -DEPENDS_ON-> DependencyVersion
ReleaseRevision -REQUIRES-> Requirement

Evidence -FOR_REVISION-> ReleaseRevision
Evidence -SATISFIES_CHECK-> Requirement
Evidence -FROM_SOURCE-> Source
Evidence -SUPERSEDES-> Evidence
Event -WITHDRAWS-> Evidence

Decision -ASSESSES-> ReleaseRevision
Decision -SUPPORTED_BY-> Evidence
Decision -EVALUATES-> Requirement
Decision -REPLACES-> Decision

Event -CHANGES-> affected entity
ReviewTask -FOR_REQUIREMENT-> Requirement
ReviewTask -FOR_REVISION-> ReleaseRevision

AgentRun -INSPECTED-> entity
AgentRun -PROPOSED-> Proposal
```

### Essential Cypher (source of truth in the repo)

| Concern | File |
| --- | --- |
| Release summaries, revision context, history, impact, graph view | [`backend/src/query/index.ts`](backend/src/query/index.ts) |
| Events, dependency change, evidence record/withdraw/supersede, decisions, tasks | [`backend/src/mutation/index.ts`](backend/src/mutation/index.ts) |
| Deterministic policy evaluation over graph-retrieved records | [`backend/src/evaluation/policy.ts`](backend/src/evaluation/policy.ts) |
| Idempotent seed (`MERGE` by public id) | [`backend/src/seed/index.ts`](backend/src/seed/index.ts) |
| Agent tool implementations (same query layer) | [`backend/src/agent/tools.ts`](backend/src/agent/tools.ts) |

Example (release summary + current decision pointer) from `query/index.ts`:

```cypher
MATCH (r:Release {workspaceId: $wsId})
OPTIONAL MATCH (r)-[:CURRENT_REVISION]->(cur:ReleaseRevision)
OPTIONAL MATCH (ptrDec:Decision {id: r.currentDecisionId})
RETURN r.id as id, r.name as name, r.currentRevisionId as currentRevisionId,
 cur.revisionNumber as currentRevisionNumber,
 ptrDec.id as decisionId, ptrDec.status as status
```

Example (impact from a changed dependency) — reverse `DEPENDS_ON` and related paths, workspace-scoped:

```cypher
OPTIONAL MATCH (entity)<-[:DEPENDS_ON]-(depRev:ReleaseRevision {workspaceId: $wsId})
OPTIONAL MATCH (depRev)<-[:CURRENT_REVISION]-(depRel:Release)
```

Full edge and field tables: [`docs/GRAPH_MODEL.md`](docs/GRAPH_MODEL.md) and the live schema in [`backend/src/domain/types.ts`](backend/src/domain/types.ts).

---

## 3. Prerequisites

| Requirement | Notes |
| --- | --- |
| **Node.js 20+** (LTS recommended) | Backend and frontend scripts |
| **npm** | Lockfiles are committed for backend and frontend |
| **Docker** | Run FalkorDB (`docker-compose.yml`) |
| **~1–2 GB RAM free** | FalkorDB + Node backend + browser |
| **OpenRouter API key** | **Judges supply their own key** (free tier: https://openrouter.ai/keys). Required at process start (`validateConfig`) and for **live** agent investigation. Free-tier models can be rate-limited. |

Default startup is **real-provider mode** (`OPENROUTER_*` only). The deterministic **TEST MODEL** double is **optional** and off unless you set it (see §5). No paid services are required for that optional path.

---

## 4. Setup (from a clean checkout)

Commands below match the committed `package.json` scripts (backend + frontend). There is **no root `package.json`**—install and run from the two package directories.

### 4.1 Start FalkorDB

```bash
# from repository root
docker compose up -d
```

This starts container `falkordb-afterimage` on `localhost:6379` with a named volume `falkordb-afterimage-data` (persistence across container restarts).

### 4.2 Environment

```bash
# from repository root
copy .env.example .env # Windows
# cp .env.example .env # macOS / Linux
```

Edit `.env` and set at least:

| Variable | Purpose | Example |
| --- | --- | --- |
| `OPENROUTER_API_KEY` | Server-side only. **Judges supply their own key.** Never expose to the browser (`VITE_*`). | your key |
| `OPENROUTER_MODEL` | Live agent model id | `nvidia/nemotron-3-super-120b-a12b:free` |
| `FALKORDB_HOST` / `FALKORDB_PORT` | Graph endpoint | `localhost` / `6379` |
| `FALKORDB_GRAPH` | **Named graph** for this process | `afterimage_workspace` |
| `WORKSPACE_ID` | Single MVP workspace label | `default` |
| `PORT` | HTTP port for API + built frontend | `3001` |

`.env` is listed in `.gitignore`. Do not commit keys.

**Do not set `AFTERIMAGE_TEST_MODEL_DOUBLE`** unless you intentionally want the optional TEST MODEL path (§5). Default and `.env.example` leave it **absent** (real provider).

### 4.3 Install dependencies

```bash
cd backend
npm install

cd frontend
npm install
```

### 4.4 Seed the graph (idempotent)

Seed creates the demo workspace and two releases in the **configured** `FALKORDB_GRAPH`. It **skips** if the workspace already exists (no silent duplicate records).

```bash
cd backend
npm run seed
```

Script: `ts-node src/seed.ts` → [`backend/src/seed/index.ts`](backend/src/seed/index.ts).

### 4.5 Build and start (production-style single process)

```bash
# Terminal A — frontend bundle
cd backend/frontend
npm run build # tsc && vite build → backend/frontend/dist

# Terminal B — backend API + static UI
cd backend
npm run build # tsc → backend/dist
npm start # node dist/index.js
```

Open **http://localhost:3011/** if you set `PORT=3011`, otherwise **http://localhost:3001/** (default `PORT`).

Those `localhost` URLs are **only valid on the machine that runs the server** (the builder’s PC for demos). They are not public deployment addresses; judges run the same commands on their own machine.

Verified boot log shape:

```text
Loading .env from: <repo>/.env
OPENROUTER_API_KEY loaded: yes
AFTERIMAGE API server listening on port <PORT>
```

### 4.6 Development mode (optional)

```bash
# Terminal A
cd backend
npm run dev # ts-node src/index.ts on PORT

# Terminal B
cd backend/frontend
npm run dev -- --port 5174 --strictPort
# Open http://localhost:5174/ — /api is proxied to the backend
```

`localhost:5174` is also **local to that machine only** (builder/developer PC).

On some machines port `5173` is taken by another project; `5174` is the documented free port from the Stage 4 verification.

### 4.7 Tests (integration / stage harnesses)

```bash
cd backend
npm run test:integration
npm run test:stage2
npm run test:stage3
```

These target the configured FalkorDB graph. Use an **isolated graph name** (e.g. `FALKORDB_GRAPH=afterimage_test`) if you do not want to touch demo data.

---

## 5. Real provider vs TEST MODEL

**Default: real provider only.** `.env.example`, `docker-compose.yml`, and normal `npm start` do **not** set `AFTERIMAGE_TEST_MODEL_DOUBLE`. Live investigation uses OpenRouter with the API key **judges supply themselves**. TEST MODEL is a separate, optional verification path—never on by default.

| Mode | When it runs | How to enable | What the UI shows |
| --- | --- | --- | --- |
| **Live provider (default)** | Agent investigation calls OpenRouter | Valid `OPENROUTER_API_KEY` (yours); `AFTERIMAGE_TEST_MODEL_DOUBLE` **unset** | Real provider + model ids on the run header |
| **TEST MODEL (optional double)** | Same tool loop, no external model HTTP | `AFTERIMAGE_TEST_MODEL_DOUBLE=1` **and** `FALKORDB_GRAPH` is **not** `afterimage_workspace` | Badge **TEST MODEL** / `deterministic-v1` |

Critical safeguards:

- The double is **never** active on the default graph name `afterimage_workspace`, even if the env flag is set (`backend/src/agent/model-double.ts`). 
- Default config path never sets the flag; only an explicit process env `=1` enables it. 
- Policy evaluation (`evaluate_release`) is always deterministic in code—model prose cannot grant approval. 
- Free-tier models on OpenRouter are **quota- and availability-limited**; failures surface as explicit run errors, not fabricated success. 
- Synthetic evidence is labelled in the UI (synthetic sources; no real CI execution).

Recommended verification graphs used in development (do not reset casually):

| Graph name | Purpose |
| --- | --- |
| `afterimage_workspace` | Default demo / live provider data |
| `afterimage_stage4_flow_test` | Preview + optional TEST MODEL UI journeys |
| `afterimage_stage4_real_model` | Recorded real-provider investigation evidence |

---

## 6. Domain semantics (short form)

| Status | Meaning |
| --- | --- |
| **Approved** | Demonstration policy v1: every required check has valid, in-scope PASS evidence |
| **Needs review** | Missing, mismatched, or conflicting evidence; or evaluation pending after a change |
| **Blocked** | Applicable authoritative FAIL not contradicted by unresolved applicable evidence |

Rules that matter in the demo:

- A new revision needs **its own** evidence; old evidence does not auto-carry. 
- Timestamps alone do not supersede; **explicit** withdraw/supersede links do. 
- Untrusted sources cannot grant approval. 
- Dependency changes mark review pending **immediately**; they do not wait for the agent. 
- Agent proposals are **internal** (request create/resolve, reassessment record). Humans apply them; the server re-checks revision and policy.

---

## 7. Architecture (one process in production)

```text
Browser → Express :PORT
 ├─ /api/* (routes in backend/src/api/index.ts)
 ├─ static backend/frontend/dist
 └─ SPA fallback → index.html

Express → FalkorDB :6379 (graph from FALKORDB_GRAPH)
 → OpenRouter (only when live agent runs; key stays server-side)
```

- Single Node process serializes workspace mutations with `expectedRevision` + event `idempotencyKey`. 
- Frontend never holds the OpenRouter key. 
- Restarting backend or Docker does not erase the named volume’s graphs.

---

## 8. Demo

See **[`docs/DEMO_WALKTHROUGH.md`](docs/DEMO_WALKTHROUGH.md)** for a screen-by-screen script (prior approval → dependency change → investigation → request → evidence → reassessment) and presenter notes on graph traversal and explicit decisions.

Always use a **dedicated demo graph** for rehearsals so preview/real verification data is not reset.

---

## 9. Submission and project materials

| Item | Location / status |
| --- | --- |
| Application source | `backend/` (API, graph, agent, policy), `backend/frontend/` (UI) |
| Graph model | [`docs/GRAPH_MODEL.md`](docs/GRAPH_MODEL.md) + Cypher modules in §2 |
| Essential Cypher | Linked in §2 and `docs/GRAPH_MODEL.md` |
| Env template | [`.env.example`](.env.example) |
| Docker | [`docker-compose.yml`](docker-compose.yml) |
| Demo script | [`docs/DEMO_WALKTHROUGH.md`](docs/DEMO_WALKTHROUGH.md) |
| Public repository | https://github.com/stephen-gabriel/afterimage |
| Demo video | **Not recorded in this tree** (walkthrough prepared for recording) |
| Deployment URL | **None** — local setup is the supported path |
| License | [MIT](LICENSE) — © 2026 Stephen Gabriel |

---

## 10. AI assistance disclosure

This project was developed with substantial assistance from AI coding agents (including OpenCode / Claude and related tooling) under the direction of the human participant.

**What the AI helped with**

- Drafting and refining backend modules (Express API, FalkorDB Cypher access, deterministic policy evaluation, agent tool loop, mutation/idempotency paths) 
- Implementing and iterating the React UI against the design and API contract 
- Debugging integration issues (revision keying, proposal application, static serving, mobile overflow, etc.) 
- Running automated verification (typecheck, builds, HTTP checks, headless browser journeys) and documenting results during development 
- Preparing this README and the demo walkthrough from the **actual** implementation

**What the human participant did**

- Owns the AFTERIMAGE idea and product framing for the FalkorDB hackathon (team **Onyx-Labs**; builder: **Stephen Gabriel**, per the project build plan) 
- Set scope, reviewed behaviour, and directed fixes and verification batches 
- Provided environment access (Docker, OpenRouter account usage as permitted) and decided when work was acceptable to stop 

AI-generated code and prose were treated as drafts that the participant reviewed in context of the running system. This disclosure does **not** claim independent manual authorship of every line of code, nor does it diminish the participant’s product and review role. No claim is made here of multi-person engineering contributions beyond the named builder.

---

## 11. Limitations

- Single workspace / single process MVP; not multi-replica. 
- No real CI, deployment, ticketing, or document ingestion. 
- Synthetic evidence only; “pass” means the **demo policy** is satisfied, not that production software is correct. 
- Free-model quotas can block live investigation; the UI surfaces failure instead of inventing traces. 
- Connections UI is a bounded path list (not a full interactive graph editor). 
- Not a substitute for security review, SRE runbooks, or formal verification.

---

## 12. License and contact

This project is licensed under the [MIT License](LICENSE). Copyright © 2026 Stephen Gabriel.

For questions related to this prototype, use the team’s event/hackathon contact channels associated with **Onyx-Labs**.
