import { runCypher, closeClient, getGraph } from '../graph/client';
import { FIXED_WORKSPACE_ID, FIXED_CHECKOUT_RELEASE_ID, FIXED_DOCS_RELEASE_ID } from '../seed/fixtures';
import { seedDatabase } from '../seed/index';
import { getReleaseSummaries, getRevisionContext, getDecisionHistory } from '../query';
import { applyEvent, recordReassessment, getWorkspaceRevision } from '../mutation';
import {
  evaluateReleaseRevision,
  evaluateRequirement,
  EvaluatedEvidence,
} from '../evaluation/policy';

const watchdog = setTimeout(async () => {
  console.error('WATCHDOG: Stage 2 suite timed out after 240s');
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
    console.log(`  ✅ ${message}`);
    passed++;
  } else {
    console.log(`  ❌ ${message}`);
    failed++;
  }
}

async function expectError(promise: Promise<any>, pattern: RegExp, label: string) {
  try {
    await promise;
    assert(false, `${label} (expected error, but call succeeded)`);
  } catch (error: any) {
    const message = String(error?.message || error);
    assert(pattern.test(message), `${label} [${message.slice(0, 90)}]`);
  }
}

async function evidenceIdByKey(key: string): Promise<string | null> {
  const r = await runCypher(`MATCH (e:Event {idempotencyKey: $key, workspaceId: $wsId}) RETURN e.evidenceId as evidenceId`, {
    key,
    wsId: FIXED_WORKSPACE_ID,
  });
  return r.data[0]?.evidenceId || null;
}

async function decisionIdByKey(key: string): Promise<string | null> {
  const r = await runCypher(`MATCH (e:Event {idempotencyKey: $key, workspaceId: $wsId}) RETURN e.decisionId as decisionId`, {
    key,
    wsId: FIXED_WORKSPACE_ID,
  });
  return r.data[0]?.decisionId || null;
}

async function evidenceCount(): Promise<number> {
  const r = await runCypher(`MATCH (e:Evidence {workspaceId: $wsId}) RETURN count(e) as c`, { wsId: FIXED_WORKSPACE_ID });
  return r.data[0]?.c || 0;
}

function testRecorded(
  revisionId: string,
  requirementId: string,
  sourceId: string,
  outcome: 'PASS' | 'FAIL',
  observedAt: string,
  summary: string
) {
  return { type: 'TEST_RECORDED' as const, revisionId, requirementId, sourceId, outcome, observedAt, summary };
}

function mkEv(overrides: Partial<EvaluatedEvidence> & { id: string }): EvaluatedEvidence {
  const codes = overrides.applicabilityReasonCodes ?? [];
  return {
    sourceId: 'src_x',
    outcome: 'PASS',
    observedAt: '2026-01-01T00:00:00.000Z',
    receivedAt: '2026-01-01T00:00:00.000Z',
    synthetic: true,
    contentSummary: 'unit',
    withdrawnByEventId: null,
    supersededByEvidenceId: null,
    revisionId: 'rev_current',
    requirementId: 'req_a',
    sourceAuthority: 'allowlisted',
    sourceName: 'Unit Source',
    applicabilityReasonCodes: codes,
    applicable: codes.length === 0,
    explanation: 'unit',
    ...overrides,
  } as EvaluatedEvidence;
}

async function main() {
  console.log('=== AFTERIMAGE Stage 2 Correctness Engine Tests (isolated graph) ===\n');

  const graph = await getGraph();
  try {
    await graph.delete();
    console.log('Test graph deleted (fresh start)\n');
  } catch {
    console.log('Test graph delete skipped (fresh graph)\n');
  }

  // ---------------------------------------------------------------- setup
  console.log('--- Setup: seed fixtures + extra requirements/evidence ---');
  await seedDatabase();

  await runCypher(
    `CREATE (src:Source {
      id: 'src_untrusted_external', workspaceId: $wsId, name: 'Untrusted External Bot',
      authority: 'untrusted', synthetic: true, createdAt: $now
    })`,
    { wsId: FIXED_WORKSPACE_ID, now: '2026-01-15T10:00:00.000Z' }
  );

  await runCypher(
    `MATCH (rev:ReleaseRevision {id: 'rev_checkout_r1_v1', workspaceId: $wsId}), (dep:DependencyVersion {id: 'dep_payment_api_v2', workspaceId: $wsId})
     CREATE (req:Requirement {
       id: 'req_checkout_security', workspaceId: $wsId, checkKind: 'security_scan',
       description: 'Security scan for checkout-r1', revisionId: 'rev_checkout_r1_v1', createdAt: $now
     })
     CREATE (rev)-[:REQUIRES {id: 'rel_req_sec_v1'}]->(req)
     CREATE (req)-[:FOR_VERSION {id: 'rel_fv_sec_v1'}]->(dep)
     RETURN req.id as id`,
    { wsId: FIXED_WORKSPACE_ID, now: '2026-01-15T10:00:00.000Z' }
  );

  await runCypher(
    `MATCH (req:Requirement {id: 'req_checkout_security', workspaceId: $wsId}),
          (src:Source {id: 'src_ci_synthetic', workspaceId: $wsId}),
          (rev:ReleaseRevision {id: 'rev_checkout_r1_v1', workspaceId: $wsId})
     CREATE (ev:Evidence {
       id: 'ev_security_pass', workspaceId: $wsId, sourceId: 'src_ci_synthetic', outcome: 'PASS',
       observedAt: '2026-01-15T10:06:00.000Z', receivedAt: '2026-01-15T10:06:00.000Z', synthetic: true,
       contentSummary: 'Synthetic test evidence; no CI test was executed by AFTERIMAGE. Security scan passed.',
       revisionId: 'rev_checkout_r1_v1', createdAt: $now
     })
     CREATE (ev)-[:SATISFIES_CHECK {id: 'rel_sat_sec'}]->(req)
     CREATE (ev)-[:FROM_SOURCE {id: 'rel_src_sec'}]->(src)
     CREATE (ev)-[:FOR_REVISION {id: 'rel_rev_sec'}]->(rev)
     RETURN ev.id as id`,
    { wsId: FIXED_WORKSPACE_ID, now: '2026-01-15T10:00:00.000Z' }
  );

  await runCypher(
    `MATCH (req:Requirement {id: 'req_checkout_integration_v2', workspaceId: $wsId}),
          (src:Source {id: 'src_docs_synthetic', workspaceId: $wsId}),
          (rev:ReleaseRevision {id: 'rev_checkout_r1_v1', workspaceId: $wsId})
     CREATE (ev:Evidence {
       id: 'ev_integration_pass2', workspaceId: $wsId, sourceId: 'src_docs_synthetic', outcome: 'PASS',
       observedAt: '2026-01-15T10:07:00.000Z', receivedAt: '2026-01-15T10:07:00.000Z', synthetic: true,
       contentSummary: 'Synthetic test evidence; no CI test was executed by AFTERIMAGE. Second integration PASS.',
       revisionId: 'rev_checkout_r1_v1', createdAt: $now
     })
     CREATE (ev)-[:SATISFIES_CHECK {id: 'rel_sat_pass2'}]->(req)
     CREATE (ev)-[:FROM_SOURCE {id: 'rel_src_pass2'}]->(src)
     CREATE (ev)-[:FOR_REVISION {id: 'rel_rev_pass2'}]->(rev)
     RETURN ev.id as id`,
    { wsId: FIXED_WORKSPACE_ID, now: '2026-01-15T10:00:00.000Z' }
  );

  // ---------------------------------------------------------------- S1 baseline
  console.log('\n--- S1: baseline approvals + recordReassessment ---');
  {
    const summaries = await getReleaseSummaries();
    const checkout = summaries.find((s) => s.id === FIXED_CHECKOUT_RELEASE_ID);
    const docs = summaries.find((s) => s.id === FIXED_DOCS_RELEASE_ID);
    assert(checkout?.status === 'APPROVED', 'checkout-r1 baseline status is APPROVED');
    assert(checkout?.evaluationPending === false, 'checkout-r1 baseline not pending');
    assert(docs?.status === 'APPROVED', 'docs-r1 baseline status is APPROVED');

    const evalRev1 = await evaluateReleaseRevision('rev_checkout_r1_v1');
    assert(evalRev1?.requirements.length === 2, 'rev1 has 2 requirements');
    assert(
      evalRev1?.requirements.every((r) => r.result === 'SATISFIED'),
      'all rev1 requirements SATISFIED'
    );
    assert(evalRev1?.supportedByEvidenceIds.length === 3, 'rev1 support = 3 PASS evidence ids');

    const wsBefore = await getWorkspaceRevision();
    const reassess = await recordReassessment(FIXED_CHECKOUT_RELEASE_ID, wsBefore, 's1_reassess');
    assert(/^dec_/.test(reassess.decisionId), `recordReassessment returns real decision id (${reassess.decisionId})`);
    assert(reassess.newWorkspaceRevision === wsBefore + 1, 'recordReassessment advances workspace revision by 1');

    const summaries2 = await getReleaseSummaries();
    const checkout2 = summaries2.find((s) => s.id === FIXED_CHECKOUT_RELEASE_ID);
    assert(checkout2?.status === 'APPROVED', 'checkout still APPROVED after reassessment');
    assert(checkout2?.latestDecisionId === reassess.decisionId, 'summary points at reassessment decision');

    const history = await getDecisionHistory(FIXED_CHECKOUT_RELEASE_ID);
    assert(history.length >= 2, 'decision history has baseline + reassessment decisions');
    assert(
      history.some((h) => h.status === 'APPROVED' && h.replacesDecisionId === 'dec_checkout_r1_v1_approved'),
      'reassessment decision REPLACES the seeded approval'
    );
    assert(
      history.some((h) => h.status === 'APPROVED' && h.reasonCodes.includes('ALL_REQUIREMENTS_SATISFIED')),
      'seeded APPROVED decision retained in history'
    );
  }

  // ---------------------------------------------------------------- S2 dependency change
  console.log('\n--- S2: v2 -> v3 dependency change ---');
  const S = {
    wsRev: 0,
    oldRevId: 'rev_checkout_r1_v1',
    newRevId: '' as string,
    integrationReqId: '' as string,
    securityReqId: '' as string,
    licenseReqId: 'req_checkout_license',
    failEvId: '' as string,
    passEvId: '' as string,
    pass2EvId: '' as string,
    superEvId: '' as string,
    widgetFailEvId: '' as string,
    widgetPassEvId: '' as string,
    docsBefore: undefined as any,
  };

  {
    const summaries = await getReleaseSummaries();
    S.docsBefore = summaries.find((s) => s.id === FIXED_DOCS_RELEASE_ID);
    S.wsRev = await getWorkspaceRevision();

    const result = await applyEvent(
      {
        type: 'DEPENDENCY_CHANGED',
        releaseId: FIXED_CHECKOUT_RELEASE_ID,
        dependencyName: 'payment-api',
        newVersion: '3.0.0',
      },
      S.wsRev,
      's2_dep_change'
    );
    assert(result.newWorkspaceRevision === S.wsRev + 1, 'dep change advances workspace revision by 1');
    assert(
      JSON.stringify(result.affectedReleases) === JSON.stringify([FIXED_CHECKOUT_RELEASE_ID]),
      'affectedReleases = [checkout-r1]'
    );

    const stateCheck = await runCypher(
      `MATCH (e:Event {idempotencyKey: 's2_dep_change', workspaceId: $wsId})
       RETURN e.applicationState as state, e.appliedWorkspaceRevision as wsRev`,
      { wsId: FIXED_WORKSPACE_ID }
    );
    assert(stateCheck.data[0]?.state === 'APPLIED', 'event committed directly as APPLIED (no PENDING window)');

    const summaries2 = await getReleaseSummaries();
    const checkout = summaries2.find((s) => s.id === FIXED_CHECKOUT_RELEASE_ID);
    const docs = summaries2.find((s) => s.id === FIXED_DOCS_RELEASE_ID);
    assert(checkout?.status === 'NEEDS_REVIEW', 'checkout immediately NEEDS_REVIEW after dep change');
    assert(checkout?.evaluationPending === true, 'checkout evaluation pending (no silent decision after event)');
    assert(checkout?.currentRevisionId !== S.oldRevId, 'checkout current revision changed');
    S.newRevId = checkout!.currentRevisionId;
    assert(docs?.currentRevisionId === S.docsBefore.currentRevisionId, 'docs revision unchanged');
    assert(docs?.status === 'APPROVED' && docs?.latestDecisionId === S.docsBefore.latestDecisionId, 'docs approval untouched');

    const context = await getRevisionContext(S.newRevId);
    assert(context !== null, 'new revision context retrievable');
    assert(context!.revisionNumber === 2, 'new revision number is 2');
    assert(context!.dependencies.length === 1, 'new revision has 1 dependency');
    assert(context!.dependencies[0].id === 'dep_payment_api_3_0_0', 'new dependency id is dep_payment_api_3_0_0');
    assert(context!.dependencies[0].version === '3.0.0', 'new dependency version is 3.0.0');
    assert(context!.requirements.length === 2, '2 requirements copied to new revision');
    assert(
      context!.requirements.every((r) => !['req_checkout_integration_v2', 'req_checkout_security'].includes(r.id)),
      'copied requirements have NEW ids (historical requirements untouched)'
    );
    assert(context!.evidence.length === 0, 'no direct evidence on new revision (no carryover)');

    const intReq = context!.requirements.find((r) => r.checkKind === 'integration_test');
    const secReq = context!.requirements.find((r) => r.checkKind === 'security_scan');
    S.integrationReqId = intReq!.id;
    S.securityReqId = secReq!.id;
    assert(Boolean(intReq) && Boolean(secReq), 'copied requirement checkKinds preserved');

    const evaluation = await evaluateReleaseRevision(S.newRevId);
    assert(evaluation?.status === 'NEEDS_REVIEW', 'evaluation of new revision is NEEDS_REVIEW');
    assert(evaluation?.supportedByEvidenceIds.length === 0, 'no evidence support carried over');
    const intEval = evaluation!.requirements.find((r) => r.checkKind === 'integration_test');
    assert(intEval?.result === 'MISSING', 'integration requirement MISSING (missing evidence is not failure)');
    assert(intEval?.reasonCodes.includes('REVISION_MISMATCH'), 'integration requirement cites REVISION_MISMATCH');
    assert(
      intEval?.evidence.some(
        (e) => !e.applicable && e.applicabilityReasonCodes.includes('REVISION_MISMATCH') && e.revisionId === S.oldRevId
      ),
      'old-revision PASS returned as context candidate tagged REVISION_MISMATCH'
    );
    assert(
      intEval?.evidence.every((e) => e.applicable === false || e.revisionId === S.newRevId),
      'no old-scope evidence claimed as applicable'
    );

    const history = await getDecisionHistory(FIXED_CHECKOUT_RELEASE_ID);
    assert(
      history.some((h) => h.status === 'APPROVED' && h.reasonCodes.includes('ALL_REQUIREMENTS_SATISFIED')),
      'old approval retained historically'
    );
    assert(
      history.every((h) => h.status !== 'NEEDS_REVIEW' || h.evaluatedWorkspaceRevision <= 1),
      'no silent NEEDS_REVIEW decision recorded for new revision after dep change'
    );

    const reassessAfterDep = await recordReassessment(
      FIXED_CHECKOUT_RELEASE_ID,
      await getWorkspaceRevision(),
      's2_reassess_after_dep'
    );
    assert(/^dec_/.test(reassessAfterDep.decisionId), 'explicit reassessment records decision after dep change');
    const summaryAfterReassess = (await getReleaseSummaries()).find((s) => s.id === FIXED_CHECKOUT_RELEASE_ID);
    assert(summaryAfterReassess?.evaluationPending === false, 'evaluation no longer pending after explicit reassessment');
    assert(summaryAfterReassess?.status === 'NEEDS_REVIEW', 'reassessment records NEEDS_REVIEW for new revision');
    const historyAfterReassess = await getDecisionHistory(FIXED_CHECKOUT_RELEASE_ID);
    assert(
      historyAfterReassess.some((h) => h.status === 'NEEDS_REVIEW' && h.reasonCodes.includes('MISSING_EVIDENCE')),
      'new NEEDS_REVIEW decision recorded only via explicit reassessment'
    );

    const oldContext = await getRevisionContext(S.oldRevId);
    assert(
      oldContext?.currentDecision?.status === 'APPROVED',
      'old revision context still reports its historical APPROVED decision'
    );
  }

  // ---------------------------------------------------------------- S3 conflicts
  console.log('\n--- S3: stale revision, lost-success retry, duplicate key ---');
  {
    const countBefore = await evidenceCount();
    const revBefore = await getWorkspaceRevision();

    await expectError(
      applyEvent(
        testRecorded(S.newRevId, S.integrationReqId, 'src_ci_synthetic', 'FAIL', '2026-01-15T12:00:00.000Z', 'integration failed'),
        S.wsRev,
        's3_stale'
      ),
      /STALE_REVISION/,
      'stale expectedRevision rejected'
    );
    assert((await evidenceCount()) === countBefore, 'stale event wrote no evidence');
    assert((await getWorkspaceRevision()) === revBefore, 'stale event did not advance workspace revision');

    const failApply = await applyEvent(
      testRecorded(S.newRevId, S.integrationReqId, 'src_ci_synthetic', 'FAIL', '2026-01-15T12:00:00.000Z', 'integration failed'),
      revBefore,
      's3_fail'
    );
    S.failEvId = (await evidenceIdByKey('s3_fail'))!;
    assert(Boolean(S.failEvId), 'FAIL evidence id stored on event');
    assert(failApply.newWorkspaceRevision === revBefore + 1, 'FAIL apply advances revision by 1');

    const summaryAfterFail = (await getReleaseSummaries()).find((s) => s.id === FIXED_CHECKOUT_RELEASE_ID);
    assert(summaryAfterFail?.status === 'NEEDS_REVIEW', 'event does not silently record BLOCKED; pending NEEDS_REVIEW');
    assert(summaryAfterFail?.evaluationPending === true, 'evaluation still pending after FAIL event');

    const evalBlocked = await evaluateReleaseRevision(S.newRevId);
    const intBlocked = evalBlocked!.requirements.find((r) => r.checkKind === 'integration_test');
    assert(intBlocked?.result === 'FAILING', 'integration requirement FAILING');
    assert(
      intBlocked?.conflictingEvidenceIds.includes(S.failEvId),
      'failing evidence id cited on the requirement'
    );

    const retry = await applyEvent(
      testRecorded(S.newRevId, S.integrationReqId, 'src_ci_synthetic', 'FAIL', '2026-01-15T12:00:00.000Z', 'integration failed'),
      revBefore,
      's3_fail'
    );
    assert(retry.eventId === failApply.eventId, 'lost-success retry with same key returns original event id');
    assert(retry.newWorkspaceRevision === failApply.newWorkspaceRevision, 'retry returns original workspace revision');
    assert((await evidenceCount()) === countBefore + 1, 'retry did not create a second evidence node');

    await expectError(
      applyEvent(
        testRecorded(S.newRevId, S.integrationReqId, 'src_ci_synthetic', 'PASS', '2026-01-15T12:05:00.000Z', 'different payload'),
        await getWorkspaceRevision(),
        's3_fail'
      ),
      /DUPLICATE_KEY_CONFLICT/,
      'duplicate key with different payload => conflict'
    );
    assert((await evidenceCount()) === countBefore + 1, 'conflicting duplicate created no second mutation');
  }

  // ---------------------------------------------------------------- S4 conflict + S5 withdraw fail
  console.log('\n--- S4: matching PASS => conflict, not latest-wins ---');
  {
    const wsRev = await getWorkspaceRevision();
    await applyEvent(
      testRecorded(S.newRevId, S.integrationReqId, 'src_ci_synthetic', 'PASS', '2026-01-15T12:10:00.000Z', 'integration passed (newer than FAIL)'),
      wsRev,
      's4_pass'
    );
    S.passEvId = (await evidenceIdByKey('s4_pass'))!;

    const evalConflict = await evaluateReleaseRevision(S.newRevId);
    const intConflict = evalConflict!.requirements.find((r) => r.checkKind === 'integration_test');
    assert(intConflict?.result === 'CONFLICTING', 'PASS + FAIL => CONFLICTING (newer PASS does not auto-win)');
    assert(intConflict?.reasonCodes.includes('CONFLICTING_EVIDENCE'), 'conflict reason code present');
    assert(
      intConflict?.supportingEvidenceIds.includes(S.passEvId) && intConflict?.conflictingEvidenceIds.includes(S.failEvId),
      'both conflicting evidence ids cited'
    );
    const summaryConflict = (await getReleaseSummaries()).find((s) => s.id === FIXED_CHECKOUT_RELEASE_ID);
    assert(summaryConflict?.status === 'NEEDS_REVIEW', 'unresolved conflict => NEEDS_REVIEW, not APPROVED');

    const wsRev2 = await getWorkspaceRevision();
    await applyEvent(
      testRecorded(S.newRevId, S.securityReqId, 'src_ci_synthetic', 'PASS', '2026-01-15T12:11:00.000Z', 'security scan passed'),
      wsRev2,
      's4_sec_pass'
    );
    const evalSec = await evaluateReleaseRevision(S.newRevId);
    const secEval = evalSec!.requirements.find((r) => r.checkKind === 'security_scan');
    assert(secEval?.result === 'SATISFIED', 'security requirement SATISFIED by matching PASS');
    assert(evalSec?.status === 'NEEDS_REVIEW', 'overall still NEEDS_REVIEW while integration conflicts');
  }

  console.log('\n--- S5: withdraw the FAIL => APPROVED ---');
  {
    const wsRev = await getWorkspaceRevision();
    await applyEvent(
      { type: 'EVIDENCE_WITHDRAWN', evidenceId: S.failEvId, sourceId: 'src_ci_synthetic', reason: 'known flaky test' },
      wsRev,
      's5_withdraw_fail'
    );
    const summary = (await getReleaseSummaries()).find((s) => s.id === FIXED_CHECKOUT_RELEASE_ID);
    assert(summary?.status === 'NEEDS_REVIEW' && summary?.evaluationPending === true, 'withdrawal leaves evaluation pending');
    const evalApproved = await evaluateReleaseRevision(S.newRevId);
    assert(evalApproved?.status === 'APPROVED', 'evaluation confirms APPROVED');
    const intApproved = evalApproved!.requirements.find((r) => r.checkKind === 'integration_test');
    assert(
      intApproved?.evidence.some((e) => e.id === S.failEvId && !e.applicable && e.applicabilityReasonCodes.includes('EVIDENCE_WITHDRAWN')),
      'withdrawn FAIL still visible but non-applicable with EVIDENCE_WITHDRAWN'
    );
    const reassessS5 = await recordReassessment(FIXED_CHECKOUT_RELEASE_ID, await getWorkspaceRevision(), 's5_reassess');
    assert(/^dec_/.test(reassessS5.decisionId), 'explicit reassessment records APPROVED after withdraw');
    const summaryS5 = (await getReleaseSummaries()).find((s) => s.id === FIXED_CHECKOUT_RELEASE_ID);
    assert(summaryS5?.status === 'APPROVED' && summaryS5?.evaluationPending === false, 'withdrawal restores APPROVED via explicit reassessment');
  }

  // ---------------------------------------------------------------- S6 two PASS, withdraw one
  console.log('\n--- S6: withdraw one of two valid PASS records ---');
  {
    const wsRev = await getWorkspaceRevision();
    await applyEvent(
      testRecorded(S.newRevId, S.integrationReqId, 'src_docs_synthetic', 'PASS', '2026-01-15T12:20:00.000Z', 'second independent integration PASS'),
      wsRev,
      's6_pass2'
    );
    S.pass2EvId = (await evidenceIdByKey('s6_pass2'))!;
    const evalTwo = await evaluateReleaseRevision(S.newRevId);
    assert(evalTwo?.supportedByEvidenceIds.length === 3, 'support = 3 (2 integration PASS + 1 security PASS)');

    const wsRev2 = await getWorkspaceRevision();
    await applyEvent(
      { type: 'EVIDENCE_WITHDRAWN', evidenceId: S.passEvId, sourceId: 'src_ci_synthetic', reason: 'replaced by independent run' },
      wsRev2,
      's6_withdraw_pass'
    );
    const summary = (await getReleaseSummaries()).find((s) => s.id === FIXED_CHECKOUT_RELEASE_ID);
    assert(summary?.status === 'NEEDS_REVIEW' && summary?.evaluationPending === true, 'withdraw one PASS leaves evaluation pending');
    const evalRemaining = await evaluateReleaseRevision(S.newRevId);
    assert(evalRemaining?.supportedByEvidenceIds.includes(S.pass2EvId), 'remaining PASS still supports');
    assert(!evalRemaining?.supportedByEvidenceIds.includes(S.passEvId), 'withdrawn PASS removed from support');
    assert(evalRemaining?.supportedByEvidenceIds.length === 2, 'support reduced to remaining valid evidence');
    const reassessS6 = await recordReassessment(FIXED_CHECKOUT_RELEASE_ID, await getWorkspaceRevision(), 's6_reassess');
    assert(/^dec_/.test(reassessS6.decisionId), 'explicit reassessment records decision after withdraw-one');
    const summaryS6 = (await getReleaseSummaries()).find((s) => s.id === FIXED_CHECKOUT_RELEASE_ID);
    assert(summaryS6?.status === 'APPROVED' && summaryS6?.evaluationPending === false, 'remaining independent PASS preserves APPROVED via reassessment');
  }

  // ---------------------------------------------------------------- S7 supersession
  console.log('\n--- S7: supersession (cross-scope rejected, untrusted rejected, valid + old timestamp) ---');
  {
    const wsRev = await getWorkspaceRevision();
    await expectError(
      applyEvent(
        {
          type: 'EVIDENCE_SUPERSEDED',
          oldEvidenceId: S.pass2EvId,
          replacement: {
            revisionId: S.newRevId,
            requirementId: S.securityReqId,
            sourceId: 'src_docs_synthetic',
            outcome: 'PASS',
            observedAt: '2026-01-15T12:30:00.000Z',
            summary: 'wrong scope',
          },
        },
        wsRev,
        's7_cross_scope'
      ),
      /CROSS_SCOPE_REPLACEMENT/,
      'cross-scope supersession rejected'
    );

    await expectError(
      applyEvent(
        {
          type: 'EVIDENCE_SUPERSEDED',
          oldEvidenceId: S.pass2EvId,
          replacement: {
            revisionId: S.newRevId,
            requirementId: S.integrationReqId,
            sourceId: 'src_untrusted_external',
            outcome: 'PASS',
            observedAt: '2026-01-15T12:31:00.000Z',
            summary: 'untrusted replacement',
          },
        },
        await getWorkspaceRevision(),
        's7_untrusted_sup'
      ),
      /not authorized|untrusted/i,
      'untrusted source cannot supersede authoritative evidence'
    );

    const wsRev2 = await getWorkspaceRevision();
    await applyEvent(
      {
        type: 'EVIDENCE_SUPERSEDED',
        oldEvidenceId: S.pass2EvId,
        replacement: {
          revisionId: S.newRevId,
          requirementId: S.integrationReqId,
          sourceId: 'src_ci_synthetic',
          outcome: 'PASS',
          observedAt: '2020-01-01T00:00:00.000Z',
          summary: 'replacement observed years earlier; time alone does not invalidate',
        },
      },
      wsRev2,
      's7_supersede'
    );
    S.superEvId = (await evidenceIdByKey('s7_supersede'))!;

    const evalSup = await evaluateReleaseRevision(S.newRevId);
    assert(evalSup?.status === 'APPROVED', 'still APPROVED after valid supersession');
    assert(evalSup?.supportedByEvidenceIds.includes(S.superEvId), 'replacement evidence now supports');
    assert(!evalSup?.supportedByEvidenceIds.includes(S.pass2EvId), 'superseded evidence removed from support');
    const intSup = evalSup!.requirements.find((r) => r.checkKind === 'integration_test');
    assert(
      intSup?.evidence.some((e) => e.id === S.pass2EvId && e.applicabilityReasonCodes.includes('EVIDENCE_SUPERSEDED')),
      'superseded evidence visible with EVIDENCE_SUPERSEDED'
    );
    assert(
      intSup?.evidence.some((e) => e.id === S.superEvId && e.applicable && e.observedAt === '2020-01-01T00:00:00.000Z'),
      'older-but-applicable replacement remains valid (time is not authority)'
    );
  }

  // ---------------------------------------------------------------- S8 untrusted cannot approve
  console.log('\n--- S8: untrusted PASS cannot approve ---');
  {
    await runCypher(
      `MATCH (rev:ReleaseRevision {id: $revId, workspaceId: $wsId})
       CREATE (req:Requirement {
         id: $reqId, workspaceId: $wsId, checkKind: 'license_check',
         description: 'License check for checkout-r1', revisionId: $revId, createdAt: $now
       })
       CREATE (rev)-[:REQUIRES {id: 'rel_req_license'}]->(req)
       RETURN req.id as id`,
      { revId: S.newRevId, reqId: S.licenseReqId, wsId: FIXED_WORKSPACE_ID, now: new Date().toISOString() }
    );

    const wsRev = await getWorkspaceRevision();
    await applyEvent(
      testRecorded(S.newRevId, S.licenseReqId, 'src_untrusted_external', 'PASS', '2026-01-15T13:00:00.000Z', 'license ok (untrusted)'),
      wsRev,
      's8_untrusted'
    );
    const untrustedEvId = (await evidenceIdByKey('s8_untrusted'))!;

    const evalUntrusted = await evaluateReleaseRevision(S.newRevId);
    const licenseEval = evalUntrusted!.requirements.find((r) => r.checkKind === 'license_check');
    assert(evalUntrusted?.status === 'NEEDS_REVIEW', 'untrusted PASS cannot approve');
    assert(licenseEval?.result === 'MISSING', 'license requirement MISSING despite untrusted PASS');
    assert(licenseEval?.reasonCodes.includes('UNTRUSTED_SOURCE'), 'UNTRUSTED_SOURCE reason code present');
    assert(!evalUntrusted?.supportedByEvidenceIds.includes(untrustedEvId), 'untrusted evidence not counted as support');
    assert(
      licenseEval?.evidence.some((e) => e.id === untrustedEvId && e.applicable && e.sourceAuthority === 'untrusted'),
      'untrusted evidence returned as applicable but untrusted'
    );
    const summary = (await getReleaseSummaries()).find((s) => s.id === FIXED_CHECKOUT_RELEASE_ID);
    assert(summary?.status === 'NEEDS_REVIEW', 'summary reflects NEEDS_REVIEW (not old approval)');
    assert(summary?.evaluationPending === true, 'event leaves evaluation pending until explicit reassessment');
  }

  // ---------------------------------------------------------------- S9 truncation
  console.log('\n--- S9: truncated evidence retrieval never approves ---');
  {
    process.env.EVIDENCE_LIMIT = '1';
    const evalTrunc = await evaluateReleaseRevision(S.newRevId);
    assert(evalTrunc?.status === 'NEEDS_REVIEW', 'truncated retrieval => NEEDS_REVIEW');
    assert(evalTrunc?.reasonCodes.includes('INCOMPLETE_CONTEXT'), 'INCOMPLETE_CONTEXT reason code');
    assert(evalTrunc?.evaluationIncomplete === true, 'evaluation marked incomplete');
    assert(evalTrunc?.supportedByEvidenceIds.length === 0, 'no support from incomplete context');
    assert(
      evalTrunc?.requirements.every((r) => r.result === 'NOT_EVALUATED'),
      'all requirements NOT_EVALUATED under truncation'
    );
    delete process.env.EVIDENCE_LIMIT;

    const evalOk = await evaluateReleaseRevision(S.newRevId);
    assert(evalOk?.evaluationIncomplete === false, 'evaluation complete again after restoring limit');
  }

  // ---------------------------------------------------------------- S10 pending events suppress approval
  console.log('\n--- S10: incomplete (PENDING) events suppress approval ---');
  {
    const now = new Date().toISOString();
    await runCypher(
      `CREATE (e:Event {
        id: 'evt_injected_pending', workspaceId: $wsId, type: 'TEST_RECORDED', eventType: 'TEST_RECORDED',
        idempotencyKey: 'injected_pending_key', receivedAt: $now, payloadHash: 'injected',
        applicationState: 'PENDING', createdAt: $now
      })
      RETURN e.id as id`,
      { wsId: FIXED_WORKSPACE_ID, now }
    );

    const summaries = await getReleaseSummaries();
    const docs = summaries.find((s) => s.id === FIXED_DOCS_RELEASE_ID);
    const checkout = summaries.find((s) => s.id === FIXED_CHECKOUT_RELEASE_ID);
    assert(docs?.status === 'NEEDS_REVIEW', 'docs old approval suppressed while events incomplete');
    assert(docs?.evaluationPending === true, 'docs evaluationPending forced true');
    assert(checkout?.status === 'NEEDS_REVIEW' && checkout?.evaluationPending === true, 'checkout pending while events incomplete');

    const evalDocs = await evaluateReleaseRevision('rev_docs_r1_v1');
    assert(
      evalDocs?.requirements.every((r) => r.result === 'NOT_EVALUATED') &&
        evalDocs.reasonCodes.includes('INCOMPLETE_CONTEXT'),
      'docs evaluation returns INCOMPLETE_CONTEXT / NOT_EVALUATED'
    );

    await runCypher(`MATCH (e:Event {id: 'evt_injected_pending', workspaceId: $wsId}) DELETE e`, { wsId: FIXED_WORKSPACE_ID });

    const summaries2 = await getReleaseSummaries();
    const docs2 = summaries2.find((s) => s.id === FIXED_DOCS_RELEASE_ID);
    const checkout2 = summaries2.find((s) => s.id === FIXED_CHECKOUT_RELEASE_ID);
    assert(docs2?.status === 'APPROVED' && docs2?.evaluationPending === false, 'docs recovers to APPROVED after cleanup');
    assert(checkout2?.status === 'NEEDS_REVIEW' && checkout2?.evaluationPending === true, 'checkout remains pending (no silent decision)');
  }

  // ---------------------------------------------------------------- S11 restart persistence
  console.log('\n--- S11: backend restart (client reconnect) persistence ---');
  {
    const before = await getReleaseSummaries();
    const historyBefore = await getDecisionHistory(FIXED_CHECKOUT_RELEASE_ID);
    await closeClient();
    const after = await getReleaseSummaries();
    const historyAfter = await getDecisionHistory(FIXED_CHECKOUT_RELEASE_ID);
    assert(after.length === before.length, 'release summaries survive reconnect');
    assert(
      after.every((s) => {
        const b = before.find((x) => x.id === s.id);
        return b && b.status === s.status && b.currentRevisionId === s.currentRevisionId && b.latestDecisionId === s.latestDecisionId;
      }),
      'statuses, revisions and decision pointers survive reconnect'
    );
    assert(historyAfter.length === historyBefore.length, 'decision history survives reconnect');
  }

  // ---------------------------------------------------------------- S12 renamed IDs
  console.log('\n--- S12: same policy with renamed IDs (no hardcoded demo logic) ---');
  {
    const now = new Date().toISOString();
    await runCypher(
      `MATCH (ws:Workspace {id: $wsId})
       CREATE (rel:Release {id: 'rel_widget_alpha', workspaceId: $wsId, name: 'widget-alpha', currentRevisionId: 'rev_widget_alpha_1', createdAt: $now})
       CREATE (rev:ReleaseRevision {id: 'rev_widget_alpha_1', workspaceId: $wsId, releaseId: 'rel_widget_alpha', revisionNumber: 1, policyVersion: 'v1', createdAt: $now})
       CREATE (dep:DependencyVersion {id: 'dep_gizmo_5', workspaceId: $wsId, dependencyName: 'gizmo', version: '5.0.0', createdAt: $now})
       CREATE (req:Requirement {id: 'req_widget_build', workspaceId: $wsId, checkKind: 'build_check', description: 'Build check', revisionId: 'rev_widget_alpha_1', createdAt: $now})
       CREATE (ws)-[:HAS_REVISION {id: 'rel_ws_widget'}]->(rev)
       CREATE (rel)-[:HAS_REVISION {id: 'rel_rel_widget'}]->(rev)
       CREATE (rel)-[:CURRENT_REVISION {id: 'rel_cur_widget'}]->(rev)
       CREATE (rev)-[:DEPENDS_ON {id: 'rel_dep_widget'}]->(dep)
       CREATE (rev)-[:REQUIRES {id: 'rel_req_widget'}]->(req)
       CREATE (req)-[:FOR_VERSION {id: 'rel_fv_widget'}]->(dep)
       RETURN rel.id as id`,
      { wsId: FIXED_WORKSPACE_ID, now }
    );

    const widgetRev = 'rev_widget_alpha_1';
    const widgetReq = 'req_widget_build';
    const wsRev = await getWorkspaceRevision();
    await applyEvent(
      testRecorded(widgetRev, widgetReq, 'src_ci_synthetic', 'FAIL', '2026-01-15T14:00:00.000Z', 'widget build failed'),
      wsRev,
      's12_fail'
    );
    S.widgetFailEvId = (await evidenceIdByKey('s12_fail'))!;
    let summary = (await getReleaseSummaries()).find((s) => s.id === 'rel_widget_alpha');
    assert(summary?.status === 'NEEDS_REVIEW' && summary?.evaluationPending === true, 'renamed release: FAIL event leaves pending');
    let evalWidget = await evaluateReleaseRevision(widgetRev);
    assert(evalWidget?.status === 'BLOCKED', 'renamed release: FAIL alone evaluates BLOCKED');

    await applyEvent(
      testRecorded(widgetRev, widgetReq, 'src_docs_synthetic', 'PASS', '2026-01-15T14:05:00.000Z', 'widget build passed'),
      await getWorkspaceRevision(),
      's12_pass'
    );
    S.widgetPassEvId = (await evidenceIdByKey('s12_pass'))!;
    evalWidget = await evaluateReleaseRevision(widgetRev);
    assert(evalWidget?.status === 'NEEDS_REVIEW', 'renamed release: PASS+FAIL evaluates NEEDS_REVIEW conflict');

    await applyEvent(
      { type: 'EVIDENCE_WITHDRAWN', evidenceId: S.widgetFailEvId, sourceId: 'src_ci_synthetic', reason: 'flaky' },
      await getWorkspaceRevision(),
      's12_withdraw'
    );
    summary = (await getReleaseSummaries()).find((s) => s.id === 'rel_widget_alpha');
    assert(summary?.status === 'NEEDS_REVIEW' && summary?.evaluationPending === true, 'renamed release: withdraw leaves pending');
    evalWidget = await evaluateReleaseRevision(widgetRev);
    assert(evalWidget?.status === 'APPROVED', 'renamed release: withdraw FAIL evaluates APPROVED');
    assert(evalWidget?.supportedByEvidenceIds.includes(S.widgetPassEvId), 'renamed release support cites its own evidence');
    assert(!evalWidget?.supportedByEvidenceIds.includes(S.widgetFailEvId), 'withdrawn widget FAIL not in support');
  }

  // ---------------------------------------------------------------- S13 pure policy units
  console.log('\n--- S13: pure evaluateRequirement unit combinations ---');
  {
    const empty = evaluateRequirement('req_a', 'k', 'Check A', []);
    assert(empty.result === 'MISSING' && empty.reasonCodes.includes('MISSING_EVIDENCE'), 'no evidence => MISSING');

    const trustedPass = evaluateRequirement('req_a', 'k', 'Check A', [mkEv({ id: 'ev1' })]);
    assert(trustedPass.result === 'SATISFIED', 'trusted PASS => SATISFIED');

    const trustedFail = evaluateRequirement('req_a', 'k', 'Check A', [mkEv({ id: 'ev1', outcome: 'FAIL' })]);
    assert(trustedFail.result === 'FAILING' && trustedFail.reasonCodes.includes('APPLICABLE_FAILURE'), 'trusted FAIL => FAILING');

    const conflict = evaluateRequirement('req_a', 'k', 'Check A', [
      mkEv({ id: 'ev1' }),
      mkEv({ id: 'ev2', outcome: 'FAIL', observedAt: '2026-06-01T00:00:00.000Z' }),
    ]);
    assert(conflict.result === 'CONFLICTING' && conflict.reasonCodes.includes('CONFLICTING_EVIDENCE'), 'PASS+FAIL => CONFLICTING');

    const untrustedOnly = evaluateRequirement('req_a', 'k', 'Check A', [
      mkEv({ id: 'ev1', sourceAuthority: 'untrusted', sourceName: 'Bot' }),
    ]);
    assert(
      untrustedOnly.result === 'MISSING' && untrustedOnly.reasonCodes.includes('UNTRUSTED_SOURCE'),
      'untrusted-only PASS => MISSING (cannot approve)'
    );

    const untrustedFailDoesNotBlock = evaluateRequirement('req_a', 'k', 'Check A', [
      mkEv({ id: 'ev1' }),
      mkEv({ id: 'ev2', outcome: 'FAIL', sourceAuthority: 'untrusted', sourceName: 'Bot' }),
    ]);
    assert(untrustedFailDoesNotBlock.result === 'SATISFIED', 'untrusted FAIL does not block a trusted PASS');

    const withdrawn = evaluateRequirement('req_a', 'k', 'Check A', [
      mkEv({ id: 'ev1', applicabilityReasonCodes: ['EVIDENCE_WITHDRAWN'], applicable: false, withdrawnByEventId: 'evt_w' }),
    ]);
    assert(
      withdrawn.result === 'MISSING' && withdrawn.reasonCodes.includes('EVIDENCE_WITHDRAWN'),
      'withdrawn PASS => MISSING with EVIDENCE_WITHDRAWN'
    );

    const superseded = evaluateRequirement('req_a', 'k', 'Check A', [
      mkEv({ id: 'ev1', applicabilityReasonCodes: ['EVIDENCE_SUPERSEDED'], applicable: false, supersededByEvidenceId: 'ev_new' }),
    ]);
    assert(
      superseded.result === 'MISSING' && superseded.reasonCodes.includes('EVIDENCE_SUPERSEDED'),
      'superseded PASS => MISSING with EVIDENCE_SUPERSEDED'
    );

    const revMismatch = evaluateRequirement('req_a', 'k', 'Check A', [
      mkEv({ id: 'ev1', revisionId: 'rev_old', applicabilityReasonCodes: ['REVISION_MISMATCH'], applicable: false }),
    ]);
    assert(
      revMismatch.result === 'MISSING' && revMismatch.reasonCodes.includes('REVISION_MISMATCH'),
      'old-revision PASS => MISSING with REVISION_MISMATCH (no carryover)'
    );

    const depMismatch = evaluateRequirement('req_a', 'k', 'Check A', [
      mkEv({ id: 'ev1', applicabilityReasonCodes: ['DEPENDENCY_MISMATCH'], applicable: false }),
    ]);
    assert(
      depMismatch.result === 'MISSING' && depMismatch.reasonCodes.includes('DEPENDENCY_MISMATCH'),
      'dependency-mismatch evidence surfaced with DEPENDENCY_MISMATCH'
    );

    const oldTimestamp = evaluateRequirement('req_a', 'k', 'Check A', [
      mkEv({ id: 'ev1', observedAt: '2020-01-01T00:00:00.000Z' }),
    ]);
    assert(oldTimestamp.result === 'SATISFIED', 'older timestamp alone does not invalidate evidence');

    const failThenWithdrawnFail = evaluateRequirement('req_a', 'k', 'Check A', [
      mkEv({ id: 'ev1', outcome: 'FAIL' }),
      mkEv({ id: 'ev2', outcome: 'FAIL', applicabilityReasonCodes: ['EVIDENCE_WITHDRAWN'], applicable: false, withdrawnByEventId: 'evt_w' }),
    ]);
    assert(failThenWithdrawnFail.result === 'FAILING', 'withdrawn FAIL does not count; remaining FAIL blocks');
  }

  // ---------------------------------------------------------------- summary
  console.log(`\n=== Summary ===`);
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${failed}`);
  console.log(`Total: ${passed + failed}`);

  clearTimeout(watchdog);
  await closeClient();
  if (failed > 0) {
    process.exit(1);
  }
}

main().catch(async (error) => {
  console.error('Stage 2 suite error:', error);
  clearTimeout(watchdog);
  try {
    await closeClient();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
