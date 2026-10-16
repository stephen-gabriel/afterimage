import { runCypher } from '../graph/client';
import { FIXED_WORKSPACE_ID } from '../seed/fixtures';
import { nowISO } from '../domain/ids';

export interface TaskDTO {
  id: string;
  taskKey: string;
  status: 'OPEN' | 'RESOLVED';
  description: string;
  releaseId: string;
  revisionId: string;
  requirementId: string;
  createdAt: string;
  resolvedAt?: string;
  createdByProposalId: string;
  resolvedByProposalId?: string;
  resolvedByEvidenceIds: string[];
  resolvedByDecisionId?: string;
  checkKind?: string;
  revisionNumber?: number;
}

export async function listTasks(releaseId?: string, status?: string): Promise<TaskDTO[]> {
  let query = `MATCH (tsk:ReviewTask {workspaceId: $wsId})`;
  const params: any = { wsId: FIXED_WORKSPACE_ID };
  
  if (releaseId) {
    query += ` WHERE tsk.releaseId = $releaseId`;
    params.releaseId = releaseId;
  }
  if (status) {
    query += releaseId ? ` AND tsk.status = $status` : ` WHERE tsk.status = $status`;
    params.status = status;
  }
  
  query += `
    OPTIONAL MATCH (tsk)-[:FOR_REQUIREMENT]->(req:Requirement)
    OPTIONAL MATCH (tsk)-[:FOR_REVISION]->(rev:ReleaseRevision)
    RETURN tsk.id as id, tsk.taskKey as taskKey, tsk.status as status,
           tsk.description as description, tsk.releaseId as releaseId,
           tsk.revisionId as revisionId, tsk.requirementId as requirementId,
           tsk.createdAt as createdAt, tsk.resolvedAt as resolvedAt,
           tsk.createdByProposalId as createdByProposalId,
           tsk.resolvedByProposalId as resolvedByProposalId,
           tsk.resolvedByEvidenceIds as resolvedByEvidenceIds,
           tsk.resolvedByDecisionId as resolvedByDecisionId,
           req.checkKind as checkKind, rev.revisionNumber as revisionNumber
    ORDER BY tsk.createdAt DESC`;
  
  const result = await runCypher(query, params);
  
  return result.data.map((row: any) => ({
    id: row.id,
    taskKey: row.taskKey,
    status: row.status,
    description: row.description,
    releaseId: row.releaseId,
    revisionId: row.revisionId,
    requirementId: row.requirementId,
    createdAt: row.createdAt,
    resolvedAt: row.resolvedAt,
    createdByProposalId: row.createdByProposalId,
    resolvedByProposalId: row.resolvedByProposalId,
    resolvedByEvidenceIds: row.resolvedByEvidenceIds || [],
    resolvedByDecisionId: row.resolvedByDecisionId,
    checkKind: row.checkKind,
    revisionNumber: row.revisionNumber,
  }));
}

export async function getTask(taskId: string): Promise<TaskDTO | null> {
  const result = await runCypher(
    `MATCH (tsk:ReviewTask {id: $taskId, workspaceId: $wsId})
     OPTIONAL MATCH (tsk)-[:FOR_REQUIREMENT]->(req:Requirement)
     OPTIONAL MATCH (tsk)-[:FOR_REVISION]->(rev:ReleaseRevision)
     RETURN tsk.id as id, tsk.taskKey as taskKey, tsk.status as status,
            tsk.description as description, tsk.releaseId as releaseId,
            tsk.revisionId as revisionId, tsk.requirementId as requirementId,
            tsk.createdAt as createdAt, tsk.resolvedAt as resolvedAt,
            tsk.createdByProposalId as createdByProposalId,
            tsk.resolvedByProposalId as resolvedByProposalId,
            tsk.resolvedByEvidenceIds as resolvedByEvidenceIds,
            tsk.resolvedByDecisionId as resolvedByDecisionId,
            req.checkKind as checkKind, rev.revisionNumber as revisionNumber`,
    { taskId, wsId: FIXED_WORKSPACE_ID }
  );
  
  if (result.data.length === 0) return null;
  
  const row = result.data[0];
  return {
    id: row.id,
    taskKey: row.taskKey,
    status: row.status,
    description: row.description,
    releaseId: row.releaseId,
    revisionId: row.revisionId,
    requirementId: row.requirementId,
    createdAt: row.createdAt,
    resolvedAt: row.resolvedAt,
    createdByProposalId: row.createdByProposalId,
    resolvedByProposalId: row.resolvedByProposalId,
    resolvedByEvidenceIds: row.resolvedByEvidenceIds || [],
    resolvedByDecisionId: row.resolvedByDecisionId,
    checkKind: row.checkKind,
    revisionNumber: row.revisionNumber,
  };
}

export async function checkTaskExistsForRequirementRevision(requirementId: string, revisionId: string): Promise<string | null> {
  const result = await runCypher(
    `MATCH (tsk:ReviewTask {workspaceId: $wsId, requirementId: $requirementId, revisionId: $revisionId, status: 'OPEN'})
     RETURN tsk.id as id`,
    { wsId: FIXED_WORKSPACE_ID, requirementId, revisionId }
  );
  return result.data[0]?.id || null;
}

export async function resolveTaskWithEvidence(
  taskId: string,
  proposalId: string,
  evidenceIds: string[],
  decisionId?: string
): Promise<void> {
  await runCypher(
    `MATCH (tsk:ReviewTask {id: $taskId, workspaceId: $wsId})
     SET tsk.status = 'RESOLVED', tsk.resolvedByProposalId = $proposalId,
         tsk.resolvedByEvidenceIds = $evidenceIds, tsk.resolvedByDecisionId = $decisionId,
         tsk.resolvedAt = $resolvedAt`,
    {
      taskId,
      wsId: FIXED_WORKSPACE_ID,
      proposalId,
      evidenceIds,
      decisionId: decisionId || null,
      resolvedAt: nowISO(),
    }
  );
}

export async function getTasksForRevision(revisionId: string): Promise<TaskDTO[]> {
  const result = await runCypher(
    `MATCH (tsk:ReviewTask {workspaceId: $wsId, revisionId: $revisionId})
     OPTIONAL MATCH (tsk)-[:FOR_REQUIREMENT]->(req:Requirement)
     RETURN tsk, req.checkKind as checkKind`,
    { revisionId, wsId: FIXED_WORKSPACE_ID }
  );
  
  return result.data.map((row: any) => ({
    id: row.task.id,
    taskKey: row.task.taskKey,
    status: row.task.status,
    description: row.task.description,
    releaseId: row.task.releaseId,
    revisionId: row.task.revisionId,
    requirementId: row.task.requirementId,
    createdAt: row.task.createdAt,
    resolvedAt: row.task.resolvedAt,
    createdByProposalId: row.task.createdByProposalId,
    resolvedByProposalId: row.task.resolvedByProposalId,
    resolvedByEvidenceIds: row.task.resolvedByEvidenceIds || [],
    resolvedByDecisionId: row.task.resolvedByDecisionId,
    checkKind: row.checkKind,
  }));
}