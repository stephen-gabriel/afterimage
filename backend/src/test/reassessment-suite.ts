import { runCypher, closeClient, getGraph } from '../graph/client';
import { FIXED_WORKSPACE_ID, FIXED_CHECKOUT_RELEASE_ID } from '../seed/fixtures';
import { runIdempotentSeed } from '../seed/index';
import { createRun, executeRun, getRun } from '../agent/run';
import { getProposal } from '../agent/proposals';
import { getRevisionContext } from '../query';
import { applyEvent, getWorkspaceRevision } from '../mutation';
import { nowISO } from '../domain/ids';
import {
  isTestModelDoubleActive,
  getModelLabel,
  TEST_DOUBLE_PROVIDER,
  TEST_DOUBLE_MODEL,
} from '../agent/model-double';
import { config } from '../config';

const ISOLATED_GRAPH = 'afterimage_reassessment_test';

// Fail-fast isolation guard. Runs at module load — before main() can reset a
// graph, write a record, or execute a run against a model — so a misconfigured
// invocation aborts instead of touching a protected graph or the live model.
function requireIsolation(): void {
  if (config.falkor.graphName !== ISOLATED_GRAPH) {
    throw new Error(
      `Reassessment isolation guard: expected graph "${ISOLATED_GRAPH}", got "${config.falkor.graphName}". ` +
        'Refusing to reset or write anything.'
    );
  }
  if (!isTestModelDoubleActive()) {
    throw new Error(
      'Reassessment isolation guard: TEST MODEL double is not active. ' +
        'Refusing to run — live-model calls are not allowed.'
    );
  }
  const label = getModelLabel();
  if (label.provider !== TEST_DOUBLE_PROVIDER || label.model !== TEST_DOUBLE_MODEL) {
    throw new Error(
      `Reassessment isolation guard: unexpected model label ${label.provider}/${label.model} ` +
        `(want ${TEST_DOUBLE_PROVIDER}/${TEST_DOUBLE_MODEL}). Refusing to run.`
    );
  }
}
requireIsolation();
console.log(`Isolation guard OK: graph=${config.falkor.graphName}, model=${TEST_DOUBLE_PROVIDER}/${TEST_DOUBLE_MODEL}`);

const watchdog = setTimeout(async () => {
  console.error('WATCHDOG: reassessment suite timed out after 300s');
  try {
    await closeClient();
  } catch {
    /* ignore */
  }
  process.exit(1);
}, 300000);

let passed = 0;
let failed = 0;

function assert(condition: boolean | undefined | null, message: string) {
  if (condition) {
    console.log(`  PASS ${message}`);
    passed++;
  } else {
    console.log(`  FAIL ${message}`);
    failed++;
  }
}

async function decisionsAssessingRevision(revisionId: string): Promise<number> {
  const result = await runCypher(
    `MATCH (d:Decision)-[:ASSESSES]->(rev:ReleaseRevision {id: $revisionId, workspaceId: $wsId}) RETURN count(d) as c`,
    { revisionId, wsId: FIXED_WORKSPACE_ID }
  );
  return result.data[0]?.c ?? 0;
}

async function currentDecisionPointer(): Promise<string | null> {
  const result = await runCypher(
    `MATCH (r:Release {id: $releaseId, workspaceId: $wsId}) RETURN r.currentDecisionId as currentDecisionId`,
    { releaseId: FIXED_CHECKOUT_RELEASE_ID, wsId: FIXED_WORKSPACE_ID }
  );
  return result.data[0]?.currentDecisionId ?? null;
}

async function main() {
  console.log('=== AFTERIMAGE missing-reassessment regression tests ===');
  console.log(`graph: ${config.falkor.graphName}`);

  try {
    await (await getGraph()).delete();
    console.log('test graph deleted (fresh start)');
    await new Promise((r) => setTimeout(r, 1000));
  } catch {
    console.log('test graph delete skipped (fresh graph)');
  }
  const seed = await runIdempotentSeed();
  console.log(`seed: ${seed.nodesCreated} nodes / ${seed.relationshipsCreated} rels / alreadySeeded=${seed.alreadySeeded}`);

  // ------------------------------------------------------------------
  // 1. Already-current approved decision → NO_ACTION_NEEDED is legitimate.
  //    Seeded checkout-r1 rev1 has a recorded APPROVED decision and a fresh
  //    pointer; evaluation is APPROVED. No proposal may be fabricated or
  //    required here.
  // ------------------------------------------------------------------
  console.log('\n--- 1. already-current approved decision (legit NO_ACTION_NEEDED) ---');
  const wsRev0 = await getWorkspaceRevision();
  const ctx1 = await getRevisionContext('rev_checkout_r1_v1');
  assert(ctx1?.currentDecision?.status === 'APPROVED', 'seeded rev1 has recorded APPROVED decision');

  const run1 = await createRun(FIXED_CHECKOUT_RELEASE_ID, wsRev0);
  const executed1 = await executeRun(run1.runId);
  console.log(
    `run1: status=${executed1.status}, completion=${executed1.completionReason}, proposals=${executed1.proposals.length}`
  );
  assert(executed1.status === 'COMPLETED', 'run1 status is COMPLETED');
  assert(
    executed1.completionReason === 'NO_ACTION_NEEDED',
    `run1 completionReason is NO_ACTION_NEEDED (got ${executed1.completionReason})`
  );
  assert(executed1.proposals.length === 0, 'run1 created no proposals (nothing fabricated)');
  assert((await getWorkspaceRevision()) === wsRev0, 'workspace revision unchanged by run1');

  // ------------------------------------------------------------------
  // 2. Build the resolve-first state: dependency event creates rev2 and
  //    nulls the decision pointer; applicable PASS evidence satisfies the
  //    new requirement; the evidence request is already RESOLVED. The
  //    evaluation will be APPROVED while currentDecision stays null — the
  //    exact recording-session bug state.
  // ------------------------------------------------------------------
  console.log('\n--- 2. build resolve-first state (APPROVED eval, null decision) ---');
  const depChange = await applyEvent(
    {
      type: 'DEPENDENCY_CHANGED',
      releaseId: FIXED_CHECKOUT_RELEASE_ID,
      dependencyName: 'payment-api',
      newVersion: '3.0.0',
    },
    wsRev0,
    'reassess_dep_change'
  );
  const wsRev1 = depChange.newWorkspaceRevision;
  assert(wsRev1 === wsRev0 + 1, `dependency event advanced workspace ${wsRev0} -> ${wsRev1}`);

  const rev2Result = await runCypher(
    `MATCH (r:Release {id: $releaseId, workspaceId: $wsId})-[:CURRENT_REVISION]->(rev:ReleaseRevision)
     RETURN rev.id as revisionId`,
    { releaseId: FIXED_CHECKOUT_RELEASE_ID, wsId: FIXED_WORKSPACE_ID }
  );
  const rev2Id = rev2Result.data[0]?.revisionId as string;
  assert(Boolean(rev2Id), `rev2 exists after dependency event (${rev2Id})`);
  assert((await currentDecisionPointer()) === null, 'decision pointer nulled by dependency event');

  const req2Result = await runCypher(
    `MATCH (rev:ReleaseRevision {id: $revId, workspaceId: $wsId})-[:REQUIRES]->(req:Requirement)
     RETURN req.id as id, req.description as description`,
    { revId: rev2Id, wsId: FIXED_WORKSPACE_ID }
  );
  const req2Id = req2Result.data[0]?.id as string;
  assert(Boolean(req2Id), `rev2 carries a requirement (${req2Id})`);

  const now = nowISO();
  await runCypher(
    `CREATE (ev:Evidence {
       id: $evId, workspaceId: $wsId, type: 'Evidence', createdAt: $now,
       sourceId: 'src_ci_synthetic', outcome: 'PASS',
       observedAt: $now, receivedAt: $now, synthetic: true,
       contentSummary: 'Regression fixture: applicable PASS evidence for the post-dependency-change revision.',
       revisionId: $revId
     })
     WITH ev
     MATCH (rev:ReleaseRevision {id: $revId, workspaceId: $wsId})-[:REQUIRES]->(req:Requirement {id: $reqId})
     MATCH (src:Source {id: 'src_ci_synthetic', workspaceId: $wsId})
     CREATE (ev)-[:FOR_REVISION {id: 'rel_for_rev_' + $evId + '_' + $revId}]->(rev)
     CREATE (ev)-[:SATISFIES_CHECK {id: 'rel_sat_' + $evId + '_' + $reqId}]->(req)
     CREATE (ev)-[:FROM_SOURCE {id: 'rel_from_' + $evId + '_src_ci_synthetic'}]->(src)`,
    { evId: 'ev_reassessment_rev2_pass', wsId: FIXED_WORKSPACE_ID, revId: rev2Id, reqId: req2Id, now }
  );

  // Resolve-first: the evidence request for this requirement/revision is
  // already RESOLVED (mirrors an applied RESOLVE_EVIDENCE_REQUEST).
  await runCypher(
    `CREATE (tsk:ReviewTask {
       id: 'tsk_reassessment_resolved', workspaceId: $wsId, type: 'ReviewTask',
       taskKey: 'task_reassessment_resolved', status: 'RESOLVED',
       description: 'Regression fixture: evidence request already resolved before reassessment.',
       releaseId: $releaseId, requirementId: $reqId, revisionId: $revId,
       createdByProposalId: 'prop_reassessment_setup',
       resolvedByProposalId: 'prop_reassessment_setup',
       resolvedByEvidenceIds: $evidenceIds,
       createdAt: $now, resolvedAt: $now
     })
     WITH tsk
     MATCH (req:Requirement {id: $reqId, workspaceId: $wsId})
     MATCH (rev:ReleaseRevision {id: $revId, workspaceId: $wsId})
     CREATE (tsk)-[:FOR_REQUIREMENT]->(req)
     CREATE (tsk)-[:FOR_REVISION]->(rev)`,
    {
      wsId: FIXED_WORKSPACE_ID,
      releaseId: FIXED_CHECKOUT_RELEASE_ID,
      reqId: req2Id,
      revId: rev2Id,
      evidenceIds: ['ev_reassessment_rev2_pass'],
      now,
    }
  );

  const ctx2 = await getRevisionContext(rev2Id);
  assert(ctx2?.currentDecision === null, 'rev2 context currentDecision is null (unrecorded)');
  const satReq = ctx2?.requirements.some((r: any) => r.id === req2Id);
  assert(Boolean(satReq), 'rev2 requirement present in context');

  const eval2 = await runCypher(
    `MATCH (rev:ReleaseRevision {id: $revId, workspaceId: $wsId}) RETURN rev.id as id`,
    { revId: rev2Id, wsId: FIXED_WORKSPACE_ID }
  );
  assert(eval2.data.length > 0, 'rev2 readable for evaluation');

  // ------------------------------------------------------------------
  // 3. Resolve-first + stubborn model (ignores corrective feedback):
  //    the server must NOT accept NO_ACTION_NEEDED — bounded corrective
  //    feedback, then VALIDATION_FAILED. No proposal or decision may be
  //    fabricated, and the workspace must not move.
  // ------------------------------------------------------------------
  console.log('\n--- 3. resolve-first, model omits RECORD_REASSESSMENT (stubborn) ---');
  process.env.AFTERIMAGE_TEST_DOUBLE_STUBBORN = '1';
  const wsRevBeforeRuns = await getWorkspaceRevision();

  const run2 = await createRun(FIXED_CHECKOUT_RELEASE_ID, wsRevBeforeRuns);
  const executed2 = await executeRun(run2.runId);
  delete process.env.AFTERIMAGE_TEST_DOUBLE_STUBBORN;
  console.log(
    `run2: status=${executed2.status}, completion=${executed2.completionReason}, ` +
      `proposals=${executed2.proposals.length}, error=${executed2.error ?? 'none'}`
  );
  assert(executed2.status === 'FAILED', `run2 status is FAILED (got ${executed2.status})`);
  assert(
    executed2.completionReason === 'VALIDATION_FAILED',
    `run2 completionReason is VALIDATION_FAILED, not NO_ACTION_NEEDED (got ${executed2.completionReason})`
  );
  assert(
    String(executed2.error ?? '').includes('RECORD_REASSESSMENT'),
    'run2 error names the missing RECORD_REASSESSMENT proposal'
  );
  assert(executed2.proposals.length === 0, 'run2 fabricated no proposals');
  assert((await decisionsAssessingRevision(rev2Id)) === 0, 'no Decision auto-recorded for rev2');
  assert((await currentDecisionPointer()) === null, 'decision pointer still null after failed run');
  assert((await getWorkspaceRevision()) === wsRevBeforeRuns, 'workspace revision unchanged by failed run');

  // ------------------------------------------------------------------
  // 4. Resolve-first + compliant model: corrective feedback drives a
  //    RECORD_REASSESSMENT proposal. Still no auto-recorded decision and
  //    no fabricated approval — only the PENDING proposal exists.
  // ------------------------------------------------------------------
  console.log('\n--- 4. resolve-first, corrective feedback yields RECORD_REASSESSMENT ---');
  const run3 = await createRun(FIXED_CHECKOUT_RELEASE_ID, wsRevBeforeRuns);
  const executed3 = await executeRun(run3.runId);
  console.log(
    `run3: status=${executed3.status}, completion=${executed3.completionReason}, proposals=${executed3.proposals.length}`
  );
  assert(executed3.status === 'COMPLETED', `run3 status is COMPLETED (got ${executed3.status})`);
  assert(
    executed3.completionReason === 'PROPOSED_ACTIONS',
    `run3 completionReason is PROPOSED_ACTIONS (got ${executed3.completionReason})`
  );
  assert(executed3.proposals.length === 1, `run3 submitted exactly one proposal (got ${executed3.proposals.length})`);

  const proposal3 = executed3.proposals.length > 0 ? await getProposal(executed3.proposals[0]) : null;
  assert(proposal3?.actionType === 'RECORD_REASSESSMENT', `proposal actionType is RECORD_REASSESSMENT (got ${proposal3?.actionType})`);
  assert(proposal3?.status === 'PENDING', `proposal status is PENDING (got ${proposal3?.status})`);
  assert(
    proposal3?.requirementId === null || proposal3?.requirementId === undefined,
    `proposal requirementId is null, not the string "null" (got ${JSON.stringify(proposal3?.requirementId)})`
  );
  assert((await decisionsAssessingRevision(rev2Id)) === 0, 'no Decision auto-recorded for rev2 after run3');
  assert((await currentDecisionPointer()) === null, 'decision pointer still null (proposal not auto-applied)');
  assert((await getWorkspaceRevision()) === wsRevBeforeRuns, 'workspace revision unchanged by run3');

  // Sanity: run detail round-trips through getRun.
  const roundTrip = await getRun(run3.runId);
  assert(roundTrip?.completionReason === 'PROPOSED_ACTIONS', 'run3 completionReason persisted');

  console.log(`\n=== reassessment regression complete: ${passed} passed, ${failed} failed ===`);
  await closeClient();
  clearTimeout(watchdog);
  // Let libuv finish closing DB handles before exit — process.exit() during
  // handle teardown trips a libuv assertion on Windows.
  await new Promise((r) => setTimeout(r, 500));
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error('reassessment regression test failed:', error);
  process.exit(1);
});
