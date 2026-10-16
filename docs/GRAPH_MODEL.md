# AFTERIMAGE graph model

Authoritative storage is **FalkorDB**. This document describes the domain graph as implemented in application source. Cypher strings live in the TypeScript modules linked below—those files are the source of truth if this summary and code ever diverge.

## Status vocabulary

| Release status | Meaning |
| --- | --- |
| `APPROVED` | Demonstration policy v1: every required check has valid, in-scope PASS evidence for the **current** revision |
| `NEEDS_REVIEW` | Missing, mismatched, or conflicting evidence; or evaluation pending after a relevant change |
| `BLOCKED` | Applicable authoritative FAIL that is not contradicted by unresolved applicable evidence |

History can be superseded. There is no fourth release status named `SUPERSEDED`. Agent run failure is operational state, not proof a release failed.

## Node types (application labels)

All nodes have application-generated string IDs and `workspaceId`. Database internal IDs are never used as public identifiers.

| Label | Essential fields (implementation) |
| --- | --- |
| `Workspace` | `id`, `revision` (monotonic mutation counter) |
| `Release` | `id`, `name`, `currentRevisionId`, `currentDecisionId` |
| `ReleaseRevision` | `id`, `releaseId`, `revisionNumber`, `policyVersion` |
| `DependencyVersion` | `id`, `dependencyName`, `version` |
| `Requirement` | `id`, `checkKind`, `description`, `revisionId` |
| `Evidence` | `id`, `sourceId`, `outcome`, `observedAt`, `receivedAt`, `synthetic`, `contentSummary`, optional withdraw/supersede markers |
| `Source` | `id`, `name`, `authority` (`allowlisted` \| `untrusted`), `synthetic` |
| `Decision` | `id`, `status`, `reasonCodes`, `evaluatedWorkspaceRevision`, `policyVersion`, `evaluatedAt` |
| `Event` | `id`, `type`, `idempotencyKey`, `receivedAt`, `payloadHash`, `applicationState` |
| `ReviewTask` | `id`, `status` (`OPEN` \| `RESOLVED`), description / check metadata |
| `AgentRun` | `id`, `status`, `snapshotRevision`, `provider`, `model`, timing |
| `Proposal` | `id`, `runId`, `expectedRevision`, `status`, `actionType` |

TypeScript domain types: [`backend/src/domain/types.ts`](../backend/src/domain/types.ts).

## Directed relationships

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

Requirements are scoped to a revision. Evidence and decisions are immutable. Current pointers, task state, and run status may change with auditable events. Old support links are retained.

## Where Cypher lives

| Concern | Module |
| --- | --- |
| Release summaries, revision context, decision history, impact, graph view | [`backend/src/query/index.ts`](../backend/src/query/index.ts) |
| Events, dependency change, evidence record/withdraw/supersede, decisions, tasks | [`backend/src/mutation/index.ts`](../backend/src/mutation/index.ts) |
| Deterministic policy evaluation | [`backend/src/evaluation/policy.ts`](../backend/src/evaluation/policy.ts) |
| Idempotent seed | [`backend/src/seed/index.ts`](../backend/src/seed/index.ts), fixtures in [`backend/src/seed/fixtures.ts`](../backend/src/seed/fixtures.ts) |
| Agent tools (same query layer) | [`backend/src/agent/tools.ts`](../backend/src/agent/tools.ts) |
| Proposal application | [`backend/src/agent/proposals.ts`](../backend/src/agent/proposals.ts) |

### Example: release summaries

From `getReleaseSummaries` in `backend/src/query/index.ts`:

```cypher
MATCH (r:Release {workspaceId: $wsId})
OPTIONAL MATCH (r)-[:CURRENT_REVISION]->(cur:ReleaseRevision)
OPTIONAL MATCH (ptrDec:Decision {id: r.currentDecisionId})
RETURN r.id as id, r.name as name, r.currentRevisionId as currentRevisionId,
       cur.revisionNumber as currentRevisionNumber,
       ptrDec.id as decisionId, ptrDec.status as status
```

### Example: reverse impact from a changed dependency

From `findAffectedReleases` in `backend/src/query/index.ts` (abbreviated; full query walks additional optional paths for requirements and evidence):

```cypher
OPTIONAL MATCH (entity)<-[:DEPENDS_ON]-(depRev:ReleaseRevision {workspaceId: $wsId})
OPTIONAL MATCH (depRev)<-[:CURRENT_REVISION]-(depRel:Release)
```

### Example: seed nodes and edges

From `backend/src/seed/index.ts`:

```cypher
MERGE (n:Label {id: $id}) SET n += $props RETURN n
```

```cypher
MATCH (a {id: $sourceId}), (b {id: $targetId})
MERGE (a)-[r:REL_TYPE {id: $relId}]->(b)
SET r += $props
RETURN r
```

## Demonstration policy v1 (summary)

Implemented in `backend/src/evaluation/policy.ts`:

- Evidence must match the release **revision**, check kind, and applicable dependency version.
- Sources must be allowlisted to grant approval; untrusted evidence is recorded but cannot approve.
- Withdrawn or superseded evidence is not applicable.
- Each required check needs at least one valid PASS; unresolved PASS/FAIL conflict requires review; any valid FAIL without contradiction blocks; missing evidence requires review.
- Time alone does not invalidate evidence; explicit withdraw/supersede links determine history.

The policy evaluator uses **graph-retrieved records**. Model prose cannot override evaluation. Approvals only follow a recorded Decision after successful evaluation at the current revision.

## Mutation consistency (MVP)

- Single backend process; serialized workspace mutations.
- Events and proposal applies carry `expectedRevision` (workspace revision) and idempotency keys.
- Dependency changes create a new immutable revision and mark evaluation pending without waiting for the agent.
- Task create/resolve proposals advance the workspace revision counter (see `backend/src/agent/proposals.ts`).

## Seed fixtures

`npm run seed` loads a deterministic demo workspace (`ws_demo`) with:

- **checkout-r1** — integration test against `payment-api` v2, synthetic PASS, approved decision  
- **docs-r1** — documentation completeness check, no payment-api dependency, approved  

Seed is idempotent: if the workspace already exists, it does not silently duplicate records. Use a **separate** `FALKORDB_GRAPH` name for isolated experiments.
