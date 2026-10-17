import { runCypher } from '../graph/client';
import { FIXED_WORKSPACE_ID } from '../seed/fixtures';
import { generateRunId, generateProposalId, nowISO } from '../domain/ids';
import { callModel, buildSystemPrompt, ModelMessage, sanitizeToolTrace } from './model';
import { executeTool, ToolCall, ToolResult, getToolDefinitions, ExecuteToolContext } from './tools';
import { evaluateReleaseRevision } from '../evaluation/policy';
import { applyReassessmentProposal, applyCreateEvidenceRequestProposal, applyResolveEvidenceRequestProposal, listProposals } from './proposals';
import { listTasks } from './tasks';
import { getModelLabel } from './model-double';

export interface RunStep {
  tool: string;
  arguments: Record<string, any>;
  result: ToolResult | null;
  error: string | null;
  timestamp: string;
}

export interface RunContext {
  runId: string;
  releaseId: string;
  revisionId: string;
  expectedRevision: number;
  trigger: 'manual' | 'event';
  eventId?: string;
  startedAt: string;
  endedAt?: string;
  status: 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'STALE';
  provider: string;
  model: string;
  steps: RunStep[];
  proposals: string[];
  findings: string;
  completionReason: string;
  error?: string;
}

const MAX_TOOL_CALLS = 8;
const RUN_TIMEOUT_MS = 120000;

interface ProposalValidationResult {
  proposalRequired: boolean;
  requiredAction: 'CREATE_EVIDENCE_REQUEST' | 'RECORD_REASSESSMENT' | 'RESOLVE_EVIDENCE_REQUEST' | null;
  reason: string;
  requirementId: string | null;
  citedIds: string[];
}

async function hasRecordedDecisionForRevision(releaseId: string, revisionId: string): Promise<boolean> {
  const pointer = await runCypher(
    `MATCH (r:Release {id: $releaseId, workspaceId: $wsId}) RETURN r.currentDecisionId as currentDecisionId`,
    { releaseId, wsId: FIXED_WORKSPACE_ID }
  );
  const decisionId = pointer.data[0]?.currentDecisionId ?? null;
  if (!decisionId) return false;
  const assessed = await runCypher(
    `MATCH (d:Decision {id: $decisionId, workspaceId: $wsId})-[:ASSESSES]->(rev:ReleaseRevision {id: $revisionId, workspaceId: $wsId})
     RETURN d.id as id`,
    { decisionId, revisionId, wsId: FIXED_WORKSPACE_ID }
  );
  return assessed.data.length > 0;
}

async function validateProposalRequired(
  releaseId: string,
  revisionId: string,
  existingProposals: string[]
): Promise<ProposalValidationResult> {
  const evaluation = await evaluateReleaseRevision(revisionId);
  if (!evaluation) {
    return { proposalRequired: false, requiredAction: null, reason: 'Revision not found', requirementId: null, citedIds: [] };
  }

  // Check for existing proposals that might satisfy the requirement
  const allProposals = await listProposals();
  const pendingProposals = allProposals.filter((p: any) => 
    p.releaseId === releaseId && p.revisionId === revisionId && p.status === 'PENDING'
  );

  // Rule 1: Any requirement with result MISSING → CREATE_EVIDENCE_REQUEST
  const missingReq = evaluation.requirements.find(r => r.result === 'MISSING');
  if (missingReq) {
    const hasPending = pendingProposals.some(p => 
      p.actionType === 'CREATE_EVIDENCE_REQUEST' && p.requirementId === missingReq.requirementId
    );
    if (!hasPending) {
      return {
        proposalRequired: true,
        requiredAction: 'CREATE_EVIDENCE_REQUEST',
        reason: `Requirement "${missingReq.description}" (${missingReq.checkKind}) has no applicable evidence.`,
        requirementId: missingReq.requirementId,
        citedIds: evaluation.supportedByEvidenceIds || [],
      };
    }
  }

  // Rule 2: NEEDS_REVIEW with MISSING_EVIDENCE → CREATE_EVIDENCE_REQUEST
  if (evaluation.status === 'NEEDS_REVIEW' && evaluation.reasonCodes.includes('MISSING_EVIDENCE')) {
    const missingReq = evaluation.requirements.find(r => r.reasonCodes.includes('MISSING_EVIDENCE'));
    if (missingReq) {
      const hasPending = pendingProposals.some(p => 
        p.actionType === 'CREATE_EVIDENCE_REQUEST' && p.requirementId === missingReq.requirementId
      );
      if (!hasPending) {
        return {
          proposalRequired: true,
          requiredAction: 'CREATE_EVIDENCE_REQUEST',
          reason: `Evaluation shows MISSING_EVIDENCE for requirement "${missingReq.description}".`,
          requirementId: missingReq.requirementId,
          citedIds: evaluation.supportedByEvidenceIds || [],
        };
      }
    }
  }

  // Rule 3: NEEDS_REVIEW with only REVISION_MISMATCH (no MISSING_EVIDENCE) → RECORD_REASSESSMENT
  if (evaluation.status === 'NEEDS_REVIEW' && 
      evaluation.reasonCodes.includes('REVISION_MISMATCH') && 
      !evaluation.reasonCodes.includes('MISSING_EVIDENCE') &&
      !evaluation.reasonCodes.includes('CONFLICTING_EVIDENCE') &&
      !evaluation.reasonCodes.includes('APPLICABLE_FAILURE')) {
    const hasPending = pendingProposals.some(p => p.actionType === 'RECORD_REASSESSMENT');
    if (!hasPending) {
      return {
        proposalRequired: true,
        requiredAction: 'RECORD_REASSESSMENT',
        reason: 'Evaluation shows NEEDS_REVIEW due to revision mismatch only. Evidence exists but is for different revision.',
        requirementId: null,
        citedIds: evaluation.supportedByEvidenceIds || [],
      };
    }
  }

  // Rule 4: CONFLICTING or FAILING → RECORD_REASSESSMENT
  if (evaluation.status === 'NEEDS_REVIEW' && 
      (evaluation.reasonCodes.includes('CONFLICTING_EVIDENCE') || evaluation.reasonCodes.includes('APPLICABLE_FAILURE'))) {
    const hasPending = pendingProposals.some(p => p.actionType === 'RECORD_REASSESSMENT');
    if (!hasPending) {
      return {
        proposalRequired: true,
        requiredAction: 'RECORD_REASSESSMENT',
        reason: `Evaluation shows ${evaluation.reasonCodes.includes('CONFLICTING_EVIDENCE') ? 'conflicting' : 'failing'} evidence.`,
        requirementId: null,
        citedIds: evaluation.supportedByEvidenceIds || [],
      };
    }
  }

  // Rule 5: SATISFIED with OPEN task → RESOLVE_EVIDENCE_REQUEST
  const openTasks = await listTasks(releaseId, 'OPEN');
  const satisfiedWithTask = evaluation.requirements.find(r => 
    r.result === 'SATISFIED' && 
    openTasks.some(t => t.requirementId === r.requirementId && t.revisionId === revisionId)
  );
  if (satisfiedWithTask) {
    const hasPending = pendingProposals.some(p => 
      p.actionType === 'RESOLVE_EVIDENCE_REQUEST' && p.requirementId === satisfiedWithTask.requirementId
    );
    if (!hasPending) {
      return {
        proposalRequired: true,
        requiredAction: 'RESOLVE_EVIDENCE_REQUEST',
        reason: `Requirement "${satisfiedWithTask.description}" is satisfied with applicable evidence and has an OPEN task.`,
        requirementId: satisfiedWithTask.requirementId,
        citedIds: evaluation.supportedByEvidenceIds || [],
      };
    }
  }

  // Rule 6: No recorded decision for the investigated revision → RECORD_REASSESSMENT.
  // An evaluation result (e.g. APPROVED) is a computed assessment, not a recorded
  // decision. Without a Decision that assesses this revision, release state is
  // unrecorded and must be recorded via explicit reassessment — even when the
  // evaluation would approve. Skipped for incomplete evaluations (nothing can be
  // decided yet) and when a RECORD_REASSESSMENT proposal is already pending.
  if (!evaluation.evaluationIncomplete && evaluation.requirements.length > 0) {
    const decisionRecorded = await hasRecordedDecisionForRevision(releaseId, revisionId);
    if (!decisionRecorded) {
      const hasPending = pendingProposals.some(p => p.actionType === 'RECORD_REASSESSMENT');
      if (!hasPending) {
        return {
          proposalRequired: true,
          requiredAction: 'RECORD_REASSESSMENT',
          reason: `Release ${releaseId} has no recorded decision for revision ${revisionId}. An evaluation result is not a decision; propose RECORD_REASSESSMENT to record one.`,
          requirementId: null,
          citedIds: evaluation.supportedByEvidenceIds || [],
        };
      }
    }
  }

  // Rule 7: a decision is already recorded for this revision and no other rule applies
  return { proposalRequired: false, requiredAction: null, reason: '', requirementId: null, citedIds: [] };
}

export async function createRun(
  releaseId: string,
  expectedRevision: number,
  trigger: 'manual' | 'event' = 'manual',
  eventId?: string
): Promise<{ runId: string; status: string }> {
  const revisionResult = await runCypher(
    `MATCH (r:Release {id: $releaseId, workspaceId: $wsId})-[:CURRENT_REVISION]->(rev:ReleaseRevision)
     RETURN rev.id as revisionId`,
    { releaseId, wsId: FIXED_WORKSPACE_ID }
  );
  
  if (revisionResult.data.length === 0) {
    throw new Error('Release not found or has no current revision');
  }
  
  const revisionId = revisionResult.data[0].revisionId;
  
  const runId = generateRunId();
  const now = nowISO();
  const { provider, model } = getModelLabel();

  await runCypher(
    `CREATE (run:AgentRun {
      id: $runId, workspaceId: $wsId, status: 'QUEUED',
      snapshotRevision: $expectedRevision, provider: $provider, model: $model,
      startedAt: $startedAt, releaseId: $releaseId, revisionId: $revisionId,
      trigger: $trigger, eventId: $eventId
    })`,
    {
      runId,
      wsId: FIXED_WORKSPACE_ID,
      expectedRevision,
      provider,
      model,
      startedAt: now,
      releaseId,
      revisionId,
      trigger,
      eventId: eventId || null,
    }
  );
  
  return { runId, status: 'QUEUED' };
}

export async function getRun(runId: string): Promise<RunContext | null> {
  const result = await runCypher(
    `MATCH (run:AgentRun {id: $runId, workspaceId: $wsId})
     OPTIONAL MATCH (run)-[:PROPOSED]->(p:Proposal)
     RETURN run.id as runId, run.releaseId as releaseId, run.revisionId as revisionId,
            run.snapshotRevision as expectedRevision, run.trigger as trigger,
            run.eventId as eventId, run.startedAt as startedAt, run.endedAt as endedAt,
            run.status as status, run.provider as provider, run.model as model,
            run.steps as steps, run.findings as findings,
            run.completionReason as completionReason, run.error as error,
            collect(DISTINCT p.id) as proposalIds`,
    { runId, wsId: FIXED_WORKSPACE_ID }
  );
  
  if (result.data.length === 0) return null;
  
  const row = result.data[0];
  
  // Parse steps from JSON strings (FalkorDB stores arrays of primitives only)
  const parsedSteps = (row.steps || []).map((s: any) => 
    typeof s === 'string' ? JSON.parse(s) : s
  );
  
  return {
    runId: row.runId,
    releaseId: row.releaseId,
    revisionId: row.revisionId,
    expectedRevision: row.expectedRevision,
    trigger: row.trigger,
    eventId: row.eventId,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
    status: row.status,
    provider: row.provider,
    model: row.model,
    steps: parsedSteps,
    proposals: row.proposalIds || [],
    findings: row.findings || '',
    completionReason: row.completionReason || '',
    error: row.error,
  };
}

export async function listRuns(releaseId?: string, cursor?: string, limit: number = 20): Promise<{ runs: any[]; nextCursor: string | null }> {
  let query = `
    MATCH (run:AgentRun {workspaceId: $wsId})
  `;
  const params: any = { wsId: FIXED_WORKSPACE_ID, limit: limit + 1 };
  
  if (releaseId) {
    query += ` WHERE run.releaseId = $releaseId `;
    params.releaseId = releaseId;
  }
  
  if (cursor) {
    query += ` AND run.startedAt < $cursor `;
    params.cursor = cursor;
  }
  
  query += `
    OPTIONAL MATCH (run)-[:PROPOSED]->(p:Proposal)
    RETURN run.id as runId, run.releaseId as releaseId, run.revisionId as revisionId,
           run.status as status, run.startedAt as startedAt, run.endedAt as endedAt,
           run.completionReason as completionReason, run.snapshotRevision as snapshotRevision,
           run.eventId as eventId,
           collect(DISTINCT p.id) as proposalIds
    ORDER BY run.startedAt DESC
    LIMIT $limit
  `;
  
  const result = await runCypher(query, params);
  
  const runs = result.data.slice(0, limit).map((row: any) => ({
    runId: row.runId,
    releaseId: row.releaseId,
    revisionId: row.revisionId,
    status: row.status,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
    completionReason: row.completionReason,
    proposalIds: row.proposalIds || [],
    snapshotRevision: row.snapshotRevision,
    eventId: row.eventId ?? null,
  }));
  
  const nextCursor = result.data.length > limit ? runs[runs.length - 1].startedAt : null;
  
  return { runs, nextCursor };
}

async function persistRunStep(runId: string, step: RunStep): Promise<void> {
  const sanitizedStep = {
    tool: step.tool,
    arguments: JSON.stringify(step.arguments),
    result: step.result ? {
      tool_call_id: step.result.tool_call_id,
      name: step.result.name,
      content: typeof step.result.content === 'string' ? step.result.content.slice(0, 5000) : JSON.stringify(step.result.content).slice(0, 5000),
      error: step.result.error || null,
    } : null,
    error: step.error,
    timestamp: step.timestamp,
  };
  
  // FalkorDB only supports arrays of primitives, so serialize step to JSON string
  const stepJson = JSON.stringify(sanitizedStep);
  
  await runCypher(
    `MATCH (run:AgentRun {id: $runId, workspaceId: $wsId})
     SET run.steps = COALESCE(run.steps, []) + $step`,
    { runId, wsId: FIXED_WORKSPACE_ID, step: stepJson }
  );
}

async function updateRunStatus(runId: string, status: RunContext['status'], updates: Partial<RunContext> = {}): Promise<void> {
  const setClause = [
    `run.status = $status`,
    updates.endedAt ? `run.endedAt = $endedAt` : null,
    updates.findings ? `run.findings = $findings` : null,
    updates.completionReason ? `run.completionReason = $completionReason` : null,
    updates.error ? `run.error = $error` : null,
    updates.proposals ? `run.proposalIds = $proposals` : null,
  ].filter(Boolean).join(', ');
  
  // Filter out undefined values from params
  const params: Record<string, any> = { runId, wsId: FIXED_WORKSPACE_ID, status };
  if (updates.endedAt !== undefined) params.endedAt = updates.endedAt;
  if (updates.findings !== undefined) params.findings = updates.findings;
  if (updates.completionReason !== undefined) params.completionReason = updates.completionReason;
  if (updates.error !== undefined) params.error = updates.error;
  if (updates.proposals !== undefined) params.proposals = updates.proposals;
  
  await runCypher(
    `MATCH (run:AgentRun {id: $runId, workspaceId: $wsId}) SET ${setClause}`,
    params
  );
}

async function linkProposalToRun(runId: string, proposalId: string): Promise<void> {
  await runCypher(
    `MATCH (run:AgentRun {id: $runId, workspaceId: $wsId}), (p:Proposal {id: $proposalId, workspaceId: $wsId})
     CREATE (run)-[:PROPOSED]->(p)`,
    { runId, proposalId, wsId: FIXED_WORKSPACE_ID }
  );
}

export async function executeRun(runId: string): Promise<RunContext> {
  const run = await getRun(runId);
  if (!run) throw new Error('Run not found');
  if (run.status !== 'QUEUED' && run.status !== 'RUNNING') {
    throw new Error(`Run is not executable: ${run.status}`);
  }

  await updateRunStatus(runId, 'RUNNING', { startedAt: run.startedAt });

  const messages: ModelMessage[] = [
    { role: 'system', content: buildSystemPrompt() },
    { role: 'user', content: `Investigate release ${run.releaseId} (revision ${run.revisionId}). Current workspace revision at start: ${run.expectedRevision}. Use tools to gather evidence and run evaluation. If action is warranted, propose it. Maximum 8 tool calls.` },
  ];

  const tools = getToolDefinitions().map(t => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));

  let toolCallCount = 0;
  let correctionAttempts = 0;
  let finalProposal: any = null;
  let findings = '';
  let completionReason = 'NO_ACTION_NEEDED';
  let runError: string | null = null;

  try {
    while (toolCallCount < MAX_TOOL_CALLS) {
      const response = await callModel(messages, tools);
      const choice = response.choices[0];
      const message = choice.message;
      const finishReason = choice.finish_reason;

      messages.push(message);

      if (message.tool_calls && message.tool_calls.length > 0) {
        for (const toolCall of message.tool_calls) {
          if (toolCallCount >= MAX_TOOL_CALLS) break;
          
          const call: ToolCall = {
            id: toolCall.id,
            name: toolCall.function.name,
            arguments: JSON.parse(toolCall.function.arguments || '{}'),
          };

          const toolCtx: ExecuteToolContext = {
            runId,
            expectedRevision: run.expectedRevision,
          };
          const result = await executeTool(call, toolCtx);

          const step: RunStep = {
            tool: call.name,
            arguments: call.arguments,
            result,
            error: result.error || null,
            timestamp: nowISO(),
          };

          await persistRunStep(runId, step);
          run.steps.push(step);
          toolCallCount++;

          if (call.name === 'propose_review_action' && !result.error) {
            try {
              const parsed = JSON.parse(result.content);
              if (parsed?.proposalId) {
                run.proposals.push(parsed.proposalId);
              }
            } catch {
              // content not JSON; ignore
            }
          }
          
          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            name: call.name,
            content: result.error ? `ERROR: ${result.error}` : result.content,
          });
        }
        continue;
      }

      if (finishReason === 'stop' || finishReason === 'length') {
        findings = message.content || '';
        
        // Server-side validation: check if evaluation requires a proposal
        const validationResult = await validateProposalRequired(run.releaseId, run.revisionId, run.proposals);
        if (!validationResult.proposalRequired) {
          // Classify from what this run actually submitted — not from findings
          // prose, which frequently omits the tool name and misclassified runs
          // that DID propose actions as NO_ACTION_NEEDED.
          if (run.proposals.length > 0) {
            completionReason = 'PROPOSED_ACTIONS';
          } else if (message.content && message.content.includes('INSUFFICIENT_EVIDENCE')) {
            completionReason = 'INSUFFICIENT_EVIDENCE';
          } else {
            completionReason = 'NO_ACTION_NEEDED';
          }
        } else {
          // Model didn't propose but one is required - provide corrective feedback
          // Cap corrective attempts; never reset toolCallCount (that loops forever
          // when the model has no citable IDs).
          if (correctionAttempts < 1 && toolCallCount < MAX_TOOL_CALLS - 1) {
            correctionAttempts++;
            const correctionPrompt = `CORRECTIVE FEEDBACK: The deterministic evaluation requires a ${validationResult.requiredAction} proposal.
Required action: ${validationResult.requiredAction}
Reason: ${validationResult.reason}
Affected requirement: ${validationResult.requirementId || 'N/A'}
Cited IDs from evaluation: ${validationResult.citedIds?.join(', ') || 'none'}

You must call propose_review_action with:
- actionType: ${validationResult.requiredAction}
- releaseId: ${run.releaseId}
- revisionId: ${run.revisionId}
- requirementId: ${validationResult.requirementId || 'null'}
- citedIds: [${validationResult.citedIds?.join(', ') || ''}]
- reason: ${validationResult.reason}

Do not respond with text. Call the tool now.`;
            
            messages.push({
              role: 'user',
              content: correctionPrompt,
            });
            
            // Continue the loop for one correction attempt
            continue;
          } else {
            // No more tool calls available or correction failed
            completionReason = 'VALIDATION_FAILED';
            runError = `Model did not propose required action: ${validationResult.requiredAction}. ${validationResult.reason}`;
            findings = `Validation failed: ${runError}`;
          }
        }
        break;
      }

      if (finishReason === 'tool_calls' && !message.tool_calls) {
        runError = 'Model requested tool calls but provided none';
        completionReason = 'RUN_FAILED';
        break;
      }
    }

    if (toolCallCount >= MAX_TOOL_CALLS) {
      completionReason = 'MAX_TOOL_CALLS_EXCEEDED';
      findings = (findings || '') + '\n\n[Run stopped: maximum 8 tool calls reached]';
    }

  } catch (error) {
    runError = error instanceof Error ? error.message : 'Unknown error';
    completionReason = 'RUN_FAILED';
    findings = `Run failed: ${runError}`;
  }

  await updateRunStatus(runId, runError ? 'FAILED' : 'COMPLETED', {
    endedAt: nowISO(),
    findings,
    completionReason,
    error: runError || undefined,
  });

  const finalRun = await getRun(runId);
  return finalRun!;
}

export async function getRunWithProposals(runId: string): Promise<any> {
  const run = await getRun(runId);
  if (!run) return null;
  
  const proposals = await Promise.all(run.proposals.map(pid => getProposal(pid)));
  
  return {
    ...run,
    proposals: proposals.filter(Boolean),
  };
}

async function getProposal(proposalId: string): Promise<any> {
  const result = await runCypher(
    `MATCH (p:Proposal {id: $proposalId, workspaceId: $wsId})
     RETURN p`,
    { proposalId, wsId: FIXED_WORKSPACE_ID }
  );
  return result.data[0]?.p || null;
}

async function getCurrentWorkspaceRevision(): Promise<number> {
  const result = await runCypher(
    `MATCH (w:Workspace {id: $wsId}) RETURN w.revision as revision`,
    { wsId: FIXED_WORKSPACE_ID }
  );
  return result.data[0]?.revision ?? 0;
}

export async function applyProposal(
  proposalId: string,
  expectedRevision: number,
  idempotencyKey: string
): Promise<{
  success: boolean;
  result?: any;
  error?: string;
  alreadyApplied?: boolean;
  decisionId?: string;
  taskId?: string;
  newWorkspaceRevision?: number;
}> {
  return runCypher(
    `MATCH (p:Proposal {id: $proposalId, workspaceId: $wsId})
     RETURN p.id as id, p.runId as runId, p.expectedRevision as expectedRevision,
            p.status as status, p.actionType as actionType, p.citedIds as citedIds,
            p.releaseId as releaseId, p.revisionId as revisionId,
            p.requirementId as requirementId, p.reason as reason,
            p.createdAt as createdAt, p.appliedAt as appliedAt,
            p.decisionId as decisionId, p.taskId as taskId`,
    { proposalId, wsId: FIXED_WORKSPACE_ID }
  ).then(async result => {
    if (result.data.length === 0) {
      return { success: false, error: 'Proposal not found' };
    }
    const proposal = result.data[0];
    
    if (proposal.status === 'APPLIED') {
      return { success: true, alreadyApplied: true, result: { proposalId, decisionId: proposal.decisionId, taskId: proposal.taskId } };
    }
    if (proposal.status === 'REJECTED') {
      return { success: false, error: 'Proposal was rejected' };
    }
    if (proposal.status === 'STALE') {
      return { success: false, error: 'Proposal is stale (workspace changed since creation)' };
    }

    // Authoritative guard: compare the proposal's snapshot revision against the
    // current workspace revision, not just the client's copy. A proposal created
    // before a concurrent apply carries an outdated revision even when the client
    // sends the current one, so this is what makes late-created siblings safe.
    const currentWsRev = await getCurrentWorkspaceRevision();
    if (proposal.expectedRevision !== currentWsRev) {
      if (proposal.status === 'PENDING') {
        await runCypher(
          `MATCH (p:Proposal {id: $proposalId, workspaceId: $wsId})
           SET p.status = 'STALE'`,
          { proposalId, wsId: FIXED_WORKSPACE_ID }
        );
      }
      return {
        success: false,
        error: `STALE_REVISION: proposal targets workspace revision ${proposal.expectedRevision}, current is ${currentWsRev}`,
      };
    }
    if (proposal.expectedRevision !== expectedRevision) {
      // The proposal is current but the client's view is not — reject without
      // marking the proposal stale; the client only needs to refetch.
      return { success: false, error: `STALE_REVISION: Expected ${proposal.expectedRevision}, current is ${expectedRevision}` };
    }

    let applyResult: any;
    switch (proposal.actionType) {
      case 'RECORD_REASSESSMENT':
        applyResult = await applyReassessmentProposal(proposal, expectedRevision, idempotencyKey);
        break;
      case 'CREATE_EVIDENCE_REQUEST':
        applyResult = await applyCreateEvidenceRequestProposal(proposal, expectedRevision, idempotencyKey);
        break;
      case 'RESOLVE_EVIDENCE_REQUEST':
        applyResult = await applyResolveEvidenceRequestProposal(proposal, expectedRevision, idempotencyKey);
        break;
      default:
        return { success: false, error: `Unknown proposal action: ${proposal.actionType}` };
    }

    if (applyResult.success) {
      await runCypher(
        `MATCH (p:Proposal {id: $proposalId, workspaceId: $wsId})
         SET p.status = 'APPLIED', p.appliedAt = $appliedAt,
             p.decisionId = $decisionId, p.taskId = $taskId`,
        { proposalId, wsId: FIXED_WORKSPACE_ID, appliedAt: nowISO(), decisionId: applyResult.decisionId || null, taskId: applyResult.taskId || null }
      );
      
      // Invalidate every pending sibling that could now be out of date: same-run
      // proposals (previous behaviour) plus anything — in any run — still pinned
      // to an older workspace revision.
      const wsAfter = applyResult.newWorkspaceRevision ?? (await getCurrentWorkspaceRevision());
      await runCypher(
        `MATCH (p:Proposal {workspaceId: $wsId})
         WHERE p.id <> $proposalId AND p.status = 'PENDING'
           AND (p.runId = $runId OR p.expectedRevision < $wsAfter)
         SET p.status = 'STALE'`,
        { proposalId, wsId: FIXED_WORKSPACE_ID, runId: proposal.runId, wsAfter }
      );
    }

    return applyResult;
  });
}