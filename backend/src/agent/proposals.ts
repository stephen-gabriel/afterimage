import { runCypher } from '../graph/client';
import { FIXED_WORKSPACE_ID } from '../seed/fixtures';
import { generateDecisionId, generateTaskId, generateProposalId, nowISO } from '../domain/ids';
import { evaluateReleaseRevision, recordDecision } from '../evaluation/policy';
import { recordReassessment } from '../mutation';

export interface ProposalApplicationResult {
  success: boolean;
  decisionId?: string;
  taskId?: string;
  newWorkspaceRevision?: number;
  error?: string;
}

export async function applyReassessmentProposal(
  proposal: any,
  expectedRevision: number,
  idempotencyKey: string
): Promise<ProposalApplicationResult> {
  try {
    const currentRevResult = await runCypher(
      `MATCH (r:Release {id: $releaseId, workspaceId: $wsId})-[:CURRENT_REVISION]->(rev:ReleaseRevision)
       RETURN rev.id as revisionId`,
      { releaseId: proposal.releaseId, wsId: FIXED_WORKSPACE_ID }
    );
    
    if (currentRevResult.data.length === 0) {
      return { success: false, error: 'Release has no current revision' };
    }
    
    const currentRevId = currentRevResult.data[0].revisionId;
    
    if (currentRevId !== proposal.revisionId) {
      return { success: false, error: `STALE_REVISION: Proposal targets revision ${proposal.revisionId} but current is ${currentRevId}` };
    }

    const result = await recordReassessment(proposal.releaseId, expectedRevision, idempotencyKey);
    
    return { success: true, decisionId: result.decisionId, newWorkspaceRevision: result.newWorkspaceRevision };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Reassessment application failed' };
  }
}

export async function applyCreateEvidenceRequestProposal(
  proposal: any,
  expectedRevision: number,
  idempotencyKey: string
): Promise<ProposalApplicationResult> {
  try {
    if (!proposal.requirementId) {
      return { success: false, error: 'requirementId required for CREATE_EVIDENCE_REQUEST' };
    }

    const existingTask = await runCypher(
      `MATCH (tsk:ReviewTask {workspaceId: $wsId, requirementId: $requirementId, revisionId: $revisionId, status: 'OPEN'})
       RETURN tsk.id as id`,
      { wsId: FIXED_WORKSPACE_ID, requirementId: proposal.requirementId, revisionId: proposal.revisionId }
    );

    if (existingTask.data.length > 0) {
      return { success: true, taskId: existingTask.data[0].id, error: 'Task already exists for this requirement/revision' };
    }

    const taskId = generateTaskId();
    const taskKey = `task_${proposal.requirementId}_${Date.now()}`;

    // Task creation is a domain mutation that changes evaluation context
    // (open tasks gate proposal validation), so advance workspaceRevision
    // per REVIEW_ADDENDUM. Operational run/proposal writes alone must not.
    const created = await runCypher(
      `MATCH (w:Workspace {id: $wsId})
       MATCH (r:Release {id: $releaseId, workspaceId: $wsId}), (rev:ReleaseRevision {id: $revisionId, workspaceId: $wsId}), (req:Requirement {id: $requirementId, workspaceId: $wsId})
       CREATE (tsk:ReviewTask {
         id: $taskId, workspaceId: $wsId, taskKey: $taskKey, status: 'OPEN',
         description: $description, releaseId: $releaseId, requirementId: $requirementId, revisionId: $revisionId,
         createdByProposalId: $proposalId, resolvedByEvidenceIds: [], createdAt: $createdAt
       })
       CREATE (tsk)-[:FOR_REQUIREMENT]->(req)
       CREATE (tsk)-[:FOR_REVISION]->(rev)
       SET w.revision = w.revision + 1
       RETURN w.revision as newRevision`,
      {
        taskId,
        wsId: FIXED_WORKSPACE_ID,
        taskKey,
        releaseId: proposal.releaseId,
        revisionId: proposal.revisionId,
        requirementId: proposal.requirementId,
        description: proposal.reason,
        proposalId: proposal.id,
        createdAt: nowISO(),
      }
    );

    return { success: true, taskId, newWorkspaceRevision: created.data[0]?.newRevision };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Evidence request creation failed' };
  }
}

export async function applyResolveEvidenceRequestProposal(
  proposal: any,
  expectedRevision: number,
  idempotencyKey: string
): Promise<ProposalApplicationResult> {
  try {
    if (!proposal.requirementId) {
      return { success: false, error: 'requirementId required for RESOLVE_EVIDENCE_REQUEST' };
    }

    const taskResult = await runCypher(
      `MATCH (tsk:ReviewTask {workspaceId: $wsId, requirementId: $requirementId, revisionId: $revisionId, status: 'OPEN'})
       RETURN tsk.id as id`,
      { wsId: FIXED_WORKSPACE_ID, requirementId: proposal.requirementId, revisionId: proposal.revisionId }
    );

    if (taskResult.data.length === 0) {
      return { success: false, error: 'No open task found for this requirement/revision' };
    }

    const taskId = taskResult.data[0].id;

    const evaluation = await evaluateReleaseRevision(proposal.revisionId);
    if (!evaluation) {
      return { success: false, error: 'Revision not found for evaluation' };
    }

    const reqEval = evaluation.requirements.find(r => r.requirementId === proposal.requirementId);
    if (!reqEval) {
      return { success: false, error: 'Requirement not found in evaluation' };
    }

    if (reqEval.result !== 'SATISFIED') {
      return { success: false, error: `Requirement not satisfied: ${reqEval.result} - ${reqEval.explanation}` };
    }

    if (reqEval.conflictingEvidenceIds.length > 0) {
      return { success: false, error: 'Unresolved applicable conflict exists for this requirement' };
    }

    if (reqEval.supportingEvidenceIds.length === 0) {
      return { success: false, error: 'No applicable passing evidence to resolve with' };
    }

    // resolvedByDecisionId must reference a Decision node. Prefer the release
    // pointer when it assesses this revision; otherwise the latest Decision
    // that assessed it. Never fall back to an Evidence ID.
    const decisionLookup = await runCypher(
      `MATCH (r:Release {id: $releaseId, workspaceId: $wsId})
       OPTIONAL MATCH (ptr:Decision {id: r.currentDecisionId})-[:ASSESSES]->(ptrRev:ReleaseRevision)
       WHERE ptrRev.id = $revisionId
       WITH r, ptr
       OPTIONAL MATCH (latest:Decision)-[:ASSESSES]->(rev:ReleaseRevision {id: $revisionId, workspaceId: $wsId})
       WHERE ptr IS NULL OR latest.id = ptr.id OR latest.evaluatedAt > ptr.evaluatedAt
       RETURN COALESCE(ptr.id, latest.id) as decisionId
       ORDER BY latest.evaluatedAt DESC
       LIMIT 1`,
      { releaseId: proposal.releaseId, revisionId: proposal.revisionId, wsId: FIXED_WORKSPACE_ID }
    );
    const resolvedDecisionId: string | null = decisionLookup.data[0]?.decisionId || null;

    // Task resolution is a domain mutation that changes evaluation context
    // (open-task gate clears), so advance workspaceRevision per REVIEW_ADDENDUM.
    const resolved = await runCypher(
      `MATCH (w:Workspace {id: $wsId})
       MATCH (tsk:ReviewTask {id: $taskId, workspaceId: $wsId})
       SET tsk.status = 'RESOLVED', tsk.resolvedByProposalId = $proposalId,
           tsk.resolvedByEvidenceIds = $evidenceIds, tsk.resolvedByDecisionId = $decisionId,
           tsk.resolvedAt = $resolvedAt
       SET w.revision = w.revision + 1
       RETURN w.revision as newRevision`,
      {
        taskId,
        wsId: FIXED_WORKSPACE_ID,
        proposalId: proposal.id,
        evidenceIds: reqEval.supportingEvidenceIds,
        decisionId: resolvedDecisionId,
        resolvedAt: nowISO(),
      }
    );

    return { success: true, taskId, newWorkspaceRevision: resolved.data[0]?.newRevision };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Evidence request resolution failed' };
  }
}

export async function createProposal(
  runId: string,
  actionType: 'RECORD_REASSESSMENT' | 'CREATE_EVIDENCE_REQUEST' | 'RESOLVE_EVIDENCE_REQUEST',
  releaseId: string,
  revisionId: string,
  requirementId: string | undefined,
  citedIds: string[],
  reason: string,
  expectedRevision: number
): Promise<string> {
  const proposalId = generateProposalId();
  const now = nowISO();

  await runCypher(
    `CREATE (p:Proposal {
      id: $proposalId, workspaceId: $wsId, runId: $runId,
      expectedRevision: $expectedRevision, status: 'PENDING',
      actionType: $actionType, citedIds: $citedIds,
      releaseId: $releaseId, revisionId: $revisionId,
      requirementId: $requirementId, reason: $reason,
      createdAt: $createdAt
    })`,
    {
      proposalId,
      wsId: FIXED_WORKSPACE_ID,
      runId,
      expectedRevision,
      actionType,
      citedIds,
      releaseId,
      revisionId,
      requirementId: requirementId || null,
      reason,
      createdAt: now,
    }
  );

  return proposalId;
}

export async function getProposal(proposalId: string): Promise<any> {
  const result = await runCypher(
    `MATCH (p:Proposal {id: $proposalId, workspaceId: $wsId})
     RETURN p.id as id, p.runId as runId, p.expectedRevision as expectedRevision,
            p.status as status, p.actionType as actionType, p.citedIds as citedIds,
            p.releaseId as releaseId, p.revisionId as revisionId,
            p.requirementId as requirementId, p.reason as reason,
            p.createdAt as createdAt, p.appliedAt as appliedAt,
            p.decisionId as decisionId, p.taskId as taskId`,
    { proposalId, wsId: FIXED_WORKSPACE_ID }
  );
  return result.data[0] || null;
}

export async function listProposals(runId?: string, status?: string): Promise<any[]> {
  let query = `MATCH (p:Proposal {workspaceId: $wsId})`;
  const params: any = { wsId: FIXED_WORKSPACE_ID };
  
  if (runId) {
    query += ` WHERE p.runId = $runId`;
    params.runId = runId;
  }
  if (status) {
    query += runId ? ` AND p.status = $status` : ` WHERE p.status = $status`;
    params.status = status;
  }
  
  query += ` RETURN p.id as id, p.runId as runId, p.expectedRevision as expectedRevision,
                 p.status as status, p.actionType as actionType, p.citedIds as citedIds,
                 p.releaseId as releaseId, p.revisionId as revisionId,
                 p.requirementId as requirementId, p.reason as reason,
                 p.createdAt as createdAt, p.appliedAt as appliedAt,
                 p.decisionId as decisionId, p.taskId as taskId
             ORDER BY p.createdAt DESC`;
  
  const result = await runCypher(query, params);
  return result.data;
}