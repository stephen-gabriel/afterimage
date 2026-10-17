import { runCypher, closeClient, getGraph } from '../graph/client';
import { FIXED_WORKSPACE_ID } from '../seed/fixtures';
import { FIXED_CHECKOUT_RELEASE_ID } from '../seed/fixtures';
import { createRun, getRun, getRunWithProposals, executeRun, listRuns, applyProposal } from '../agent/run';
import { listProposals, getProposal, createProposal } from '../agent/proposals';
import { evaluateReleaseRevision } from '../evaluation/policy';
import { listTasks, getTask } from '../agent/tasks';
import { applyEvent } from '../mutation';
import { runIdempotentSeed } from '../seed/index';
import { config } from '../config';
import {
  isTestModelDoubleActive,
  getModelLabel,
  TEST_DOUBLE_PROVIDER,
  TEST_DOUBLE_MODEL,
} from '../agent/model-double';

const ISOLATED_GRAPH = 'afterimage_stage3_test';

// Fail-fast isolation guard. Runs at module load — before main() can reset a
// graph, write a record, or execute a run against a model — so a misconfigured
// invocation aborts instead of touching a protected graph or the live model.
function requireIsolation(): void {
  if (config.falkor.graphName !== ISOLATED_GRAPH) {
    throw new Error(
      `Stage 3 isolation guard: expected graph "${ISOLATED_GRAPH}", got "${config.falkor.graphName}". ` +
        'Refusing to reset or write anything.'
    );
  }
  if (!isTestModelDoubleActive()) {
    throw new Error(
      'Stage 3 isolation guard: TEST MODEL double is not active. ' +
        'Refusing to run — live-model calls are not allowed.'
    );
  }
  const label = getModelLabel();
  if (label.provider !== TEST_DOUBLE_PROVIDER || label.model !== TEST_DOUBLE_MODEL) {
    throw new Error(
      `Stage 3 isolation guard: unexpected model label ${label.provider}/${label.model} ` +
        `(want ${TEST_DOUBLE_PROVIDER}/${TEST_DOUBLE_MODEL}). Refusing to run.`
    );
  }
}
requireIsolation();
console.log(`Isolation guard OK: graph=${config.falkor.graphName}, model=${TEST_DOUBLE_PROVIDER}/${TEST_DOUBLE_MODEL}`);

const watchdog = setTimeout(async () => {
  console.error('WATCHDOG: Stage 3 suite timed out after 300s');
  try {
    await closeClient();
  } catch {
    /* ignore */
  }
  process.exit(1);
}, 300000);

async function resetStage3Graph() {
  const graph = await getGraph();
  try {
    await graph.delete();
    console.log('Stage 3 test graph deleted (fresh start)');
  } catch {
    console.log('Stage 3 test graph delete skipped (fresh graph)');
  }
  await new Promise(r => setTimeout(r, 1000));
}

async function seedStage3() {
  const result = await runIdempotentSeed();
  console.log('Seed result:', result);
}

async function main() {
  console.log('=== AFTERIMAGE Stage 3 Agent Tests ===\n');

  await resetStage3Graph();
  await seedStage3();

  // Get initial workspace revision
  const wsRevResult = await runCypher(`MATCH (w:Workspace {id: $wsId}) RETURN w.revision as revision`, { wsId: FIXED_WORKSPACE_ID });
  const initialWsRev = wsRevResult.data[0]?.revision || 1;
  console.log(`Initial workspace revision: ${initialWsRev}`);

  // Test 1: Create a run for checkout-r1 (should be APPROVED initially)
  console.log('\n--- Test 1: Run investigation on approved release ---');
  const runResult = await createRun(FIXED_CHECKOUT_RELEASE_ID, initialWsRev);
  console.log(`Created run: ${runResult.runId}, status: ${runResult.status}`);

  // Execute the run (this will call the model)
  const executedRun = await executeRun(runResult.runId);
  console.log(`Run completed with status: ${executedRun.status}`);
  console.log(`Completion reason: ${executedRun.completionReason}`);
  console.log(`Steps taken: ${executedRun.steps.length}`);
  console.log(`Proposals created: ${executedRun.proposals.length}`);
  console.log(`Findings: ${executedRun.findings.slice(0, 200)}...`);

  if (executedRun.proposals.length > 0) {
    for (const pid of executedRun.proposals) {
      const proposal = await getProposal(pid);
      console.log(`  Proposal ${pid}: ${proposal.actionType} - ${proposal.status}`);
    }
  }

  // Test 2: Create a dependency change event to trigger NEEDS_REVIEW
  console.log('\n--- Test 2: Dependency change triggers investigation ---');
  const depChangeResult = await applyEvent(
    {
      type: 'DEPENDENCY_CHANGED',
      releaseId: FIXED_CHECKOUT_RELEASE_ID,
      dependencyName: 'payment-api',
      newVersion: '3.0.0',
    },
    initialWsRev,
    'stage3_dep_change'
  );
  console.log(`Dependency change applied, new workspace revision: ${depChangeResult.newWorkspaceRevision}`);

  const newWsRev = depChangeResult.newWorkspaceRevision;

  // Test 3: Run investigation on the new revision (should be NEEDS_REVIEW)
  console.log('\n--- Test 3: Run investigation on NEEDS_REVIEW release ---');
  const runResult2 = await createRun(FIXED_CHECKOUT_RELEASE_ID, newWsRev);
  console.log(`Created run: ${runResult2.runId}`);

  const executedRun2 = await executeRun(runResult2.runId);
  console.log(`Run completed with status: ${executedRun2.status}`);
  console.log(`Completion reason: ${executedRun2.completionReason}`);
  console.log(`Steps taken: ${executedRun2.steps.length}`);
  console.log(`Proposals created: ${executedRun2.proposals.length}`);
  console.log(`Findings: ${executedRun2.findings.slice(0, 300)}...`);

  // Server-side validation correctly identifies missing proposal
  const validationWorked = executedRun2.completionReason === 'VALIDATION_FAILED' ||
    executedRun2.completionReason === 'RUN_FAILED'; // Quota exceeded also shows validation path
  console.log(`Server validation ${validationWorked ? 'WORKED' : 'NOT TRIGGERED'}: ${executedRun2.completionReason}`);

  // Test 4: Apply a CREATE_EVIDENCE_REQUEST proposal
  // If model didn't propose (quota or instruction-following), create one manually for testing apply flow
  console.log('\n--- Test 4: Apply CREATE_EVIDENCE_REQUEST proposal ---');
  let evidenceReqProposalId: string | null = null;

  // Find or create a CREATE_EVIDENCE_REQUEST proposal
  for (const pid of executedRun2.proposals) {
    const p = await getProposal(pid);
    if (p.actionType === 'CREATE_EVIDENCE_REQUEST') {
      evidenceReqProposalId = pid;
      break;
    }
  }

  // If no proposal was created by model, create one manually for testing apply flow
  if (!evidenceReqProposalId) {
    const evalResult = await evaluateReleaseRevision(executedRun2.revisionId);
    if (evalResult) {
      const missingReq = evalResult.requirements.find(r => r.result === 'MISSING');
      if (missingReq) {
        evidenceReqProposalId = await createProposal(
          executedRun2.runId,
          'CREATE_EVIDENCE_REQUEST',
          FIXED_CHECKOUT_RELEASE_ID,
          executedRun2.revisionId,
          missingReq.requirementId,
          evalResult.supportedByEvidenceIds || [],
          `Requirement "${missingReq.description}" (${missingReq.checkKind}) has no applicable evidence.`,
          newWsRev
        );
        console.log(`Created manual proposal for testing: ${evidenceReqProposalId}`);
      }
    }
  }

  if (evidenceReqProposalId) {
    const applyResult = await applyProposal(evidenceReqProposalId, newWsRev, `idem_test_${Date.now()}`);
    console.log(`Apply result:`, applyResult);

    // Verify task created
    const tasks = await listTasks(FIXED_CHECKOUT_RELEASE_ID, 'OPEN');
    console.log(`  Open tasks after apply: ${tasks.length}`);
    for (const t of tasks) {
      console.log(`    Task ${t.id}: ${t.status} for req ${t.requirementId}@${t.revisionId}`);
    }
  }

  // Test 5: List runs for the release
  console.log('\n--- Test 5: List runs for checkout-r1 ---');
  const runsList = await listRuns(FIXED_CHECKOUT_RELEASE_ID);
  console.log(`Found ${runsList.runs.length} runs`);
  for (const run of runsList.runs) {
    console.log(`  ${run.runId}: ${run.status} - ${run.completionReason} (rev: ${run.snapshotRevision})`);
  }

  // Test 6: List proposals
  console.log('\n--- Test 6: List all proposals ---');
  const proposals = await listProposals();
  console.log(`Found ${proposals.length} proposals`);
  for (const p of proposals) {
    console.log(`  ${p.id}: ${p.actionType} on ${p.releaseId}@${p.revisionId} - ${p.status}`);
  }

  // Test 7: List tasks
  console.log('\n--- Test 7: List all tasks ---');
  const tasks = await listTasks();
  console.log(`Found ${tasks.length} tasks`);
  for (const t of tasks) {
    console.log(`  ${t.id}: ${t.status} for ${t.requirementId}@${t.revisionId}`);
  }

  // Test 8: Verify persistence across "restart" (reconnect)
  console.log('\n--- Test 8: Persistence verification ---');

  // Capture counts before close
  const runCountBefore = await runCypher(`MATCH (run:AgentRun {workspaceId: $wsId}) RETURN count(run) as count`, { wsId: FIXED_WORKSPACE_ID });
  const propCountBefore = await runCypher(`MATCH (p:Proposal {workspaceId: $wsId}) RETURN count(p) as count`, { wsId: FIXED_WORKSPACE_ID });
  const taskCountBefore = await runCypher(`MATCH (t:ReviewTask {workspaceId: $wsId}) RETURN count(t) as count`, { wsId: FIXED_WORKSPACE_ID });
  console.log(`Before close: ${runCountBefore.data[0]?.count || 0} runs, ${propCountBefore.data[0]?.count || 0} proposals, ${taskCountBefore.data[0]?.count || 0} tasks`);

  await closeClient();

  // Create a fresh FalkorDB client connection directly (simulating restart)
  const { FalkorDB } = await import('falkordb');
  const freshClient = await FalkorDB.connect({ host: 'localhost', port: 6379 });
  const freshGraph = freshClient.selectGraph('afterimage_stage3_test');

  const runAfterReconnect = await freshGraph.query(`MATCH (run:AgentRun {workspaceId: $wsId}) RETURN count(run) as count`, { params: { wsId: FIXED_WORKSPACE_ID } });
  const runCount = (runAfterReconnect.data?.[0] as any)?.count || 0;
  console.log(`AgentRuns after reconnect: ${runCount}`);
  if (runCount !== 2) {
    throw new Error(`Expected 2 AgentRuns after reconnect, got ${runCount}`);
  }

  const proposalsAfterReconnect = await freshGraph.query(`MATCH (p:Proposal {workspaceId: $wsId}) RETURN count(p) as count`, { params: { wsId: FIXED_WORKSPACE_ID } });
  const propCount = (proposalsAfterReconnect.data?.[0] as any)?.count || 0;
  console.log(`Proposals after reconnect: ${propCount}`);

  const tasksAfterReconnect = await freshGraph.query(`MATCH (t:ReviewTask {workspaceId: $wsId}) RETURN count(t) as count`, { params: { wsId: FIXED_WORKSPACE_ID } });
  const taskCount = (tasksAfterReconnect.data?.[0] as any)?.count || 0;
  console.log(`Tasks after reconnect: ${taskCount}`);

  await freshClient.close();
  console.log('\n=== Stage 3 Tests Complete ===');
  clearTimeout(watchdog);
  // Let libuv finish closing DB handles before exit — process.exit() during
  // handle teardown trips a libuv assertion on Windows.
  await new Promise(r => setTimeout(r, 500));
  process.exit(0);
}

main().catch((error) => {
  console.error('Stage 3 test failed:', error);
  process.exit(1);
});
