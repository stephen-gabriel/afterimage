# AFTERIMAGE — Demo walkthrough

A screen-by-screen script for a live (or recorded) demonstration. 
**Target duration:** ~8–12 minutes. 
**Data:** synthetic only. No real CI runs, deployments, or external user data.

---

## 0. Before you start (presenter checklist)

| Item | Requirement |
| --- | --- |
| FalkorDB | Docker container `falkordb-afterimage` healthy on `localhost:6379` (**local to this machine only**) |
| Graph | **Dedicated demo graph** (e.g. `FALKORDB_GRAPH=afterimage_demo`). **Never** reset `afterimage_workspace`, `afterimage_stage4_flow_test`, or `afterimage_stage4_real_model`. |
| Seed | `cd backend && npm run seed` against the demo graph (idempotent; skips if workspace exists) |
| Mode | **Default: live provider** (OpenRouter; **judges supply their own API key**). Optional TEST MODEL is off unless you set `AFTERIMAGE_TEST_MODEL_DOUBLE=1` **and** use a non-default graph (badge must show **TEST MODEL / deterministic-v1**). |
| UI | Production build served by backend: `npm run build` (frontend) → `npm run build` (backend) → `npm start` → open `http://localhost:<PORT>/` (**local URL only**; not a public deployment) |
| Presenter | Knows: reverse `DEPENDS_ON` traversal; evidence scoped to **revision**; policy is deterministic; proposals are **internal** and human-applied; **reassessment (decision) is not task resolution** |

**Demo-only env pattern for live provider (default):**

```bash
# backend/.env or process env for this process only
FALKORDB_GRAPH=afterimage_demo
PORT=3011
# OPENROUTER_API_KEY — your own key (judges use theirs on their machine)
# Do not set AFTERIMAGE_TEST_MODEL_DOUBLE (real provider mode)
```

**Optional TEST MODEL path (separate; not default):**

```bash
# only if showing deterministic TEST MODEL on an isolated graph
FALKORDB_GRAPH=afterimage_demo
AFTERIMAGE_TEST_MODEL_DOUBLE=1
PORT=3011
# OPENROUTER_API_KEY still required by validateConfig at boot; double makes no live model HTTP calls
```

---

## 1. Opening — problem (30s)

**Screen:** Browser at release list (`/releases`).

**Narration:**

> “Release approvals are snapshots. When a dependency changes, the old approval may no longer describe the configuration you are shipping. AFTERIMAGE stores revisions, evidence, and decisions as a graph in FalkorDB so we can see *what was approved, against what, and why that still holds—or does not.*”

**Show:** Two releases — `checkout-r1` and `docs-r1` — both **Approved** under the demonstration policy.

**Do not claim:** production safety, real company data, or automated deploys.

---

## 2. Prior approval — inspect evidence (1–1.5 min)

**Screen:** `checkout-r1` → **Status** tab.

**Narration:**

> “checkout-r1 revision 1 targets payment-api v2. The integration-test requirement is satisfied by synthetic PASS evidence that explicitly covers **this revision** and **v2**. The decision node in the graph **ASSESSES** that revision and is **SUPPORTED_BY** that evidence.”

**Actions:**

1. Point at revision chip, dependency chip (`payment-api 2.0.0`), requirement row, evidence row. 
2. Open **one evidence RecordRef** in the inspector: show full ID, fields, “Applies to this revision.” 
3. Open **History** tab briefly: one approved decision; mention history is immutable.

**Optional Connections tab:** path sentences only (no diagram). Say impact is reverse Cypher on `DEPENDS_ON`, not a hardcoded list.

---

## 3. Unaffected control — docs-r1 (30s)

**Screen:** Nav rail → `docs-r1` Status.

**Narration:**

> “docs-r1 has its own documentation-check requirement and **no** dependency on payment-api. It is the control: later we will prove impact is selective.”

Leave docs open or return to checkout.

---

## 4. Dependency change (1 min)

**Screen:** `checkout-r1` Status (or any release page). 
**UI path:** “Record a change” → dependency version change event.

**Payload shape (conceptual):**

| Field | Example |
| --- | --- |
| Type | `DEPENDENCY_CHANGED` |
| Release | `checkout-r1` |
| Dependency | `payment-api` |
| New version | `3.0.0` |
| Expected revision | current workspace revision from UI |
| Idempotency key | unique string (UI/API generates or you supply) |

**Narration:**

> “This is a structured event, not a chat message. The backend creates a **new immutable revision**, moves `CURRENT_REVISION`, and immediately marks evaluation pending. No model call is required for this step.”

**Expected UI after success:**

| Release | Status |
| --- | --- |
| **checkout-r1** | **Needs review** (or “Re-evaluation pending” → Needs review); revision number increased |
| **docs-r1** | Still **Approved** |

**Emphasize:** “v2 evidence does not prove v3 works. That is **not** the same as proof that v3 is broken.”

---

## 5. Historical approval retained (45s)

**Screen:** `checkout-r1` → **History** (and/or Status ghost stack).

**Narration:**

> “The old approval remains in the graph. It is **historical**—dashed violet in the UI—not the current decision. Decision history is append-only: new assessments replace the *current pointer*, not the records.”

Show: previous decision listed; current revision does not reuse the old decision as “current.”

---

## 6. Agent investigation (1.5–3 min)

**Screen:** `checkout-r1` → **Investigation** tab → **Investigate** (or Status → Investigate).

**What happens (presenter understanding):**

1. Server captures `snapshotRevision`. 
2. Model (live or TEST MODEL) chooses tools from a **fixed list** (max 8 tool calls). 
3. Tools hit the **same FalkorDB query layer** as the UI (`get_release_context`, `find_affected_releases`, etc.). 
4. Policy evaluation in the tool loop is **deterministic**; the model cannot approve by prose. 
5. Run stores steps, cited IDs, explanation, and proposals.

**Narration while it runs:**

> “The agent is not reading a JSON dump and inventing relationships. Each tool call is a bounded Cypher-backed read. Findings must cite IDs that exist in this workspace.”

**When complete — Show:**

| Section | What to say |
| --- | --- |
| **Findings** | Explanation of revision mismatch / missing v3-scoped evidence |
| **Proposals** | One or more cards (see §7 for valid orders) |
| **Tool activity** (expand) | Ordered steps, args, summaries, returned IDs — “observable actions, not private chain-of-thought” |
| Run meta | Provider/model, or **TEST MODEL / deterministic-v1** badge |

**If live quota fails:** run shows explicit failure / no fabricated success. Offer TEST MODEL mode on an isolated graph, or continue with recorded real-provider evidence from the verification session (do not invent a run).

---

## 7. Proposals — both valid orders (1–1.5 min)

The agent may propose **CREATE_EVIDENCE_REQUEST** and/or **RESOLVE_EVIDENCE_REQUEST** / **RECORD_REASSESSMENT** depending on retrieved state. **Both orderings below are valid** when the server accepts them; do not script a single “correct” sequence.

### Order A — request first, then evidence, then reassess

1. Apply **Create evidence request** (exact-scope v3 integration test). 
2. **Requests** page: one **OPEN** task for checkout-r1; linked requirement + creating proposal. 
3. Record matching **synthetic PASS** for the **new** revision + requirement (Record a change → test recorded). 
4. Status may still be Needs review until an explicit decision is recorded. 
5. Investigate / apply **Record reassessment** (or model proposes RESOLVE then RECORD). 
6. Task becomes **RESOLVED**; decision appears; release **Approved** if policy is satisfied.

### Order B — evidence already present, resolve + reassess

1. If matching evidence already exists when the agent runs, it may propose **RESOLVE_EVIDENCE_REQUEST** and/or **RECORD_REASSESSMENT**. 
2. Apply resolve → task **RESOLVED** (resolution links evidence; `resolvedByDecisionId` may be null if no decision assessed that revision yet). 
3. Apply reassessment → policy runs → decision recorded → release status updates. 
4. **Critical line:** *“The request being resolved means the internal task is closed because matching evidence exists. It does **not** mean the release is approved until a decision is recorded.”*

**On every apply:** confirmation dialog states this updates **internal records only**. Stale proposals (workspace changed mid-run) must be discarded and the investigation re-run—not force-applied.

---

## 8. Matching synthetic evidence detail (1 min)

**Screen:** Status tab evidence list / Record inspector.

**Narration:**

> “This PASS is synthetic. It is labelled. It matches **revision**, **check kind**, and **dependency version v3**. Evidence for the old revision does not auto-apply. Untrusted sources would be recorded but could not grant approval.”

Optional: show a second event path only if time allows (withdraw / supersede / conflicting FAIL → Needs review or Blocked)—keep short.

---

## 9. Explicit reassessment and resolution (1 min)

**Screen:** Status (approved or still pending) + Requests + History.

**Checklist before closing the story:**

- [ ] Current decision **ASSESSES** the **new** revision 
- [ ] Decision **SUPPORTED_BY** the v3 PASS evidence ID 
- [ ] History still shows the **prior** approval 
- [ ] Requests: matching task **RESOLVED** with evidence (and decision link only if the server set one) 
- [ ] docs-r1 still **Approved** (selective impact)

**Narration:**

> “Status changed because the deterministic policy ran and a decision was **explicitly** recorded—not because the agent’s chat sounded confident, and not merely because a request was closed.”

---

## 10. Close (30s)

**Summarize in one breath:**

1. Graph in FalkorDB is the memory of *why* approval held. 
2. Dependency change → new revision → selective **Needs review**. 
3. Agent **investigates with tools** and proposes **internal** actions. 
4. Human applies; server re-validates. 
5. Policy + explicit decision change status; history stays.

**Limitations (say aloud):** single-process MVP; synthetic evidence; free-model quotas; not a production gate.

---

## Presenter knowledge test (answer before going live)

| Question | Correct answer |
| --- | --- |
| How is impact found? | Reverse Cypher on `DEPENDS_ON` / related edges from the changed entity—not a hardcoded release list |
| Why is old evidence invalid after the change? | Applicability is **per revision**; no automatic carryover |
| Who can approve? | Deterministic policy evaluation + recorded Decision—not model free text |
| What do proposals do? | Create/resolve **internal** ReviewTasks or record reassessment; human applies; server checks revision |
| Does resolved task = approved release? | **No.** Resolution closes the request; approval needs a current decision |
| What is TEST MODEL? | Deterministic tool-loop double; only when double env is on **and** graph is not default `afterimage_workspace` |

---

## Troubleshooting

| Symptom | Action |
| --- | --- |
| Investigate fails with model/quota error | Use isolated TEST MODEL graph or rely on prior real-provider evidence; do not invent a trace |
| Proposal apply returns conflict | Workspace revision changed—refresh, re-investigate, discard stale proposal |
| Seed says already seeded | Expected on demo graph; use a **new** graph name for a clean demo without deleting verification graphs |
| UI still old after rebuild | Restart backend after `frontend/dist` rebuild if assets are cached; confirm `GET /` asset hash matches `dist` |
| Port conflict | Set `PORT` free (e.g. `3011`); document the URL you actually used |

---

## Related materials

- Root [`README.md`](../README.md) — setup, modes, graph model pointers, AI disclosure 
- [`docs/GRAPH_MODEL.md`](GRAPH_MODEL.md) — nodes, relationship directions, Cypher module map, policy summary 
- Application source under [`backend/`](../backend/) — API, evaluation, agent tools, seed fixtures 
