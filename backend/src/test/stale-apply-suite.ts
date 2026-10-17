import { runCypher, closeClient, getGraph } from '../graph/client';
import { FIXED_WORKSPACE_ID, FIXED_CHECKOUT_RELEASE_ID } from '../seed/fixtures';
import { runIdempotentSeed } from '../seed/index';
import { createRun, executeRun, applyProposal } from '../agent/run';
import { createProposal, getProposal } from '../agent/proposals';
import {
  isTestModelDoubleActive,
  getModelLabel,
  TEST_DOUBLE_PROVIDER,
  TEST_DOUBLE_MODEL,
} from '../agent/model-double';
import { evaluateReleaseRevision } from '../evaluation/policy';
import { listTasks } from '../agent/tasks';
import { getWorkspaceRevision } from '../mutation';
import { config } from '../config';
import { app } from '../api';

const ISOLATED_GRAPH = 'afterimage_stale_apply_test';

const watchdog = setTimeout(async () => {
  console.error('WATCHDOG: stale-apply suite timed out after 240s');
  try {
    await closeClient();
  } catch {
    /* ignore */
  }
  process.exit(1);
}, 240000);

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

async function createLinkedProposal(
  runId: string,
  actionType: 'RECORD_REASSESSMENT' | 'CREATE_EVIDENCE_REQUEST' | 'RESOLVE_EVIDENCE_REQUEST',
  releaseId: string,
  revisionId: string,
  requirementId: string | undefined,
  citedIds: string[],
  reason: string,
  expectedRevision: number
): Promise<string> {
  const proposalId = await createProposal(
    runId,
    actionType,
    releaseId,
    revisionId,
    requirementId,
    citedIds,
    reason,
    expectedRevision
  );
  await runCypher(
    `MATCH (run:AgentRun {id: $runId, workspaceId: $wsId}), (p:Proposal {id: $proposalId, workspaceId: $wsId})
     CREATE (run)-[:PROPOSED]->(p)`,
    { runId, proposalId, wsId: FIXED_WORKSPACE_ID }
  );
  return proposalId;
}

async function proposalStatus(proposalId: string): Promise<string | null> {
  const p = await getProposal(proposalId);
  return p?.status ?? null;
}

async function main() {
  console.log('=== AFTERIMAGE stale-apply regression tests ===');
  console.log(`graph: ${config.falkor.graphName}`);

  // Hard safety gates before anything touches a graph or a model.
  if (config.falkor.graphName !== ISOLATED_GRAPH) {
    throw new Error(
      `Refusing to run: expected isolated graph ${ISOLATED_GRAPH}, got ${config.falkor.graphName}`
    );
  }
  if (!isTestModelDoubleActive()) {
    throw new Error('Refusing to run: TEST MODEL double is not active (no live-model calls allowed)');
  }
  const label = getModelLabel();
  assert(
    label.provider === TEST_DOUBLE_PROVIDER && label.model === TEST_DOUBLE_MODEL,
    `model label is ${TEST_DOUBLE_PROVIDER} / ${TEST_DOUBLE_MODEL} (no live model)`
  );

  // Fresh isolated graph.
  try {
    await (await getGraph()).delete();
    console.log('test graph deleted (fresh start)');
    await new Promise((r) => setTimeout(r, 1000));
  } catch {
    console.log('test graph delete skipped (fresh graph)');
  }
  const seed = await runIdempotentSeed();
  console.log(`seed: ${seed.nodesCreated} nodes / ${seed.relationshipsCreated} rels / alreadySeeded=${seed.alreadySeeded}`);

  const wsRev0 = await getWorkspaceRevision();
  assert(wsRev0 >= 1, `workspace revision initialised (${wsRev0})`);

  // 1. Run an investigation through the TEST MODEL double.
  console.log('\n--- 1. run investigation (TEST MODEL double) ---');
  const run1 = await createRun(FIXED_CHECKOUT_RELEASE_ID, wsRev0);
  const executed = await executeRun(run1.runId);
  assert(executed.provider === TEST_DOUBLE_PROVIDER, `run provider is ${TEST_DOUBLE_PROVIDER}`);
  console.log(
    `run ${executed.runId}: status=${executed.status}, completion=${executed.completionReason}, ` +
      `model-created proposals=${executed.proposals.length}, steps=${executed.steps.length}`
  );

  // 2. Manual sibling proposals pinned to the pre-apply revision.
  console.log('\n--- 2. create sibling proposals ---');
  const evaluation = await evaluateReleaseRevision(executed.revisionId);
  assert(Boolean(evaluation), 'release evaluation available');
  if (!evaluation) throw new Error('evaluation unavailable');

  const openTasks = await listTasks(FIXED_CHECKOUT_RELEASE_ID, 'OPEN');
  const openReqIds = new Set(openTasks.map((t) => t.requirementId));
  const targetReq =
    evaluation.requirements.find((r) => r.result === 'MISSING' && !openReqIds.has(r.requirementId)) ??
    evaluation.requirements.find((r) => !openReqIds.has(r.requirementId));
  assert(
    Boolean(targetReq),
    `requirement without an open task found (${evaluation.requirements.length} requirements, ${openTasks.length} open tasks)`
  );
  if (!targetReq) throw new Error('no usable requirement for CREATE_EVIDENCE_REQUEST');

  const cited = evaluation.supportedByEvidenceIds.slice(0, 3);

  const propA = await createLinkedProposal(
    run1.runId, 'CREATE_EVIDENCE_REQUEST', FIXED_CHECKOUT_RELEASE_ID, executed.revisionId,
    targetReq.requirementId, cited, 'regression: evidence request applied first', wsRev0
  );
  const propB = await createLinkedProposal(
    run1.runId, 'RECORD_REASSESSMENT', FIXED_CHECKOUT_RELEASE_ID, executed.revisionId,
    undefined, cited, 'regression: same-run sibling', wsRev0
  );

  const run2 = await createRun(FIXED_CHECKOUT_RELEASE_ID, wsRev0);
  const propC = await createLinkedProposal(
    run2.runId, 'RECORD_REASSESSMENT', FIXED_CHECKOUT_RELEASE_ID, executed.revisionId,
    undefined, cited, 'regression: cross-run sibling', wsRev0
  );

  // 3. Apply A; the workspace advances and every sibling pinned to wsRev0 must go STALE.
  console.log('\n--- 3. apply proposal A ---');
  const idemKeyA = `stale_apply_A_${Date.now()}`;
  const applyA = await applyProposal(propA, wsRev0, idemKeyA);
  assert(applyA.success === true, `proposal A applied (${applyA.success ? 'ok' : applyA.error})`);
  const wsRev1 = await getWorkspaceRevision();
  assert(wsRev1 === wsRev0 + 1, `workspace advanced ${wsRev0} -> ${wsRev1}`);

  assert((await proposalStatus(propA)) === 'APPLIED', 'A persisted as APPLIED (Applied card preserved)');
  assert((await proposalStatus(propB)) === 'STALE', 'same-run sibling B marked STALE at apply time');
  assert((await proposalStatus(propC)) === 'STALE', 'cross-run sibling C marked STALE at apply time');
  for (const pid of executed.proposals) {
    assert((await proposalStatus(pid)) === 'STALE', `model-created sibling ${pid} marked STALE`);
  }

  // 4. Recording scenario: a proposal created AFTER the apply, still carrying the
  // old snapshot revision, is rejected even when the client sends the current one.
  console.log('\n--- 4. late-created stale proposal via HTTP ---');
  const propD = await createLinkedProposal(
    run1.runId, 'RECORD_REASSESSMENT', FIXED_CHECKOUT_RELEASE_ID, executed.revisionId,
    undefined, cited, 'regression: created after a concurrent apply', wsRev0
  );

  const server = app.listen(0);
  const addr = server.address();
  const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
  if (!port) throw new Error('could not determine ephemeral test port');
  try {
    const applyRes = await fetch(`http://127.0.0.1:${port}/api/proposals/${propD}/apply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expectedRevision: wsRev1, idempotencyKey: `stale_apply_D_${Date.now()}` }),
    });
    assert(applyRes.status === 409, `HTTP apply of stale proposal answered 409 (got ${applyRes.status})`);
    const applyBody: any = await applyRes.json();
    assert(applyBody?.error?.code === 'STALE_REVISION', `error code STALE_REVISION (got ${applyBody?.error?.code})`);
    assert(
      String(applyBody?.error?.message ?? '').includes('STALE_REVISION'),
      'error message carries the STALE_REVISION marker'
    );
    assert((await proposalStatus(propD)) === 'STALE', 'failed apply persisted D as STALE (action stays disabled)');
    assert((await getWorkspaceRevision()) === wsRev1, 'failed apply did not change the workspace revision');

    // 5. Idempotent re-apply of A: still succeeds, revision untouched.
    console.log('\n--- 5. idempotent re-apply ---');
    const reApply = await applyProposal(propA, wsRev1, idemKeyA);
    assert(reApply.success === true && reApply.alreadyApplied === true, 're-apply A answered alreadyApplied');
    assert((await getWorkspaceRevision()) === wsRev1, 'idempotent re-apply did not change the revision');

    // 6. Client out of sync, proposal current: rejected without persisting STALE.
    console.log('\n--- 6. stale client revision, current proposal ---');
    const propE = await createLinkedProposal(
      run1.runId, 'RECORD_REASSESSMENT', FIXED_CHECKOUT_RELEASE_ID, executed.revisionId,
      undefined, cited, 'regression: current proposal, stale client', wsRev1
    );
    const applyE = await applyProposal(propE, wsRev1 - 1, `stale_apply_E_${Date.now()}`);
    assert(
      applyE.success === false && String(applyE.error ?? '').includes('STALE_REVISION'),
      `stale client revision rejected with STALE_REVISION (${applyE.error ?? 'no error'})`
    );
    assert((await proposalStatus(propE)) === 'PENDING', 'E stays PENDING (proposal itself is current)');

    // 7. Read-path derivation: a behind proposal that was never applied is
    // REPORTED stale without mutating the graph.
    console.log('\n--- 7. derived stale status on read ---');
    const propF = await createLinkedProposal(
      run1.runId, 'RECORD_REASSESSMENT', FIXED_CHECKOUT_RELEASE_ID, executed.revisionId,
      undefined, cited, 'regression: never applied, revision behind', wsRev0
    );
    assert((await proposalStatus(propF)) === 'PENDING', 'F node still PENDING (derivation is non-mutating)');

    const detailRes = await fetch(`http://127.0.0.1:${port}/api/agent/runs/${run1.runId}`);
    assert(detailRes.status === 200, `GET run detail answered 200 (got ${detailRes.status})`);
    const detailBody: any = await detailRes.json();
    const byId = new Map<string, any>((detailBody?.data?.proposals ?? []).map((p: any) => [p.id, p]));
    assert(detailBody?.meta?.workspaceRevision === wsRev1, 'run detail meta carries current workspace revision');
    assert(byId.get(propA)?.status === 'APPLIED', 'run detail reports A as APPLIED');
    assert(byId.get(propB)?.status === 'STALE', 'run detail reports B as STALE');
    assert(byId.get(propE)?.status === 'PENDING', 'run detail reports E as PENDING (current revision)');
    assert(byId.get(propF)?.status === 'STALE', 'run detail reports F as STALE (derived on read)');
    const ids: string[] = detailBody?.data?.proposalIds ?? [];
    assert(new Set(ids).size === ids.length, `proposalIds deduplicated (${ids.length} ids)`);

    const propFRes = await fetch(`http://127.0.0.1:${port}/api/proposals/${propF}`);
    const propFBody: any = await propFRes.json();
    assert(propFBody?.data?.status === 'STALE', 'GET proposal F reports derived STALE');
    assert((await proposalStatus(propF)) === 'PENDING', 'F node still PENDING after read (no graph mutation)');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }

  console.log(`\n=== stale-apply complete: ${passed} passed, ${failed} failed ===`);
  await closeClient();
  clearTimeout(watchdog);
  // Let libuv finish closing the test server / DB handles before exiting —
  // process.exit() during handle teardown trips a libuv assertion on Windows.
  await new Promise((resolve) => setTimeout(resolve, 500));
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error('stale-apply test failed:', error);
  process.exit(1);
});
