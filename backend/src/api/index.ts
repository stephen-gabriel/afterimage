import express, { Request, Response, NextFunction } from 'express';
import { runCypher, healthCheck } from '../graph/client';
import { FIXED_WORKSPACE_ID } from '../seed/fixtures';
import { getReleaseSummaries, getGraphView } from '../query';
import { applyEvent as applyDomainEvent } from '../mutation';
import { createRun, getRun, listRuns, executeRun, applyProposal } from '../agent/run';
import { getProposal } from '../agent/proposals';
import { listTasks, getTask } from '../agent/tasks';
import { isTestModelDoubleActive, getModelLabel } from '../agent/model-double';
import { evaluateReleaseRevision, computeApplicabilityCodes, countIncompleteEvents } from '../evaluation/policy';
import { config, validateConfig } from '../config';
import { generateIdempotencyKey, nowISO } from '../domain/ids';

const app = express();
app.use(express.json({ limit: '1mb' }));

// Mount all API routes under /api prefix
const apiRouter = express.Router();
app.use('/api', apiRouter);

const HISTORICAL_EDGE_TYPES = new Set(['SUPERSEDES', 'REPLACES', 'WITHDRAWS']);
const RECORD_EDGE_LIMIT = 20;
const RECORD_ID_RE = /^(rel|rev|dep|req|ev|src|dec|evt|tsk|run|prop)_[A-Za-z0-9_]+$/;
const ENTITY_ID_RE = /(?:rel|rev|dep|req|ev|src|dec|evt|tsk|run|prop)_[A-Za-z0-9_]+/g;

const EVENT_REQUIRED_FIELDS: Record<string, Array<{ path: string; when?: string }>> = {
  DEPENDENCY_CHANGED: [
    { path: 'releaseId' },
    { path: 'dependencyName' },
    { path: 'newVersion' },
  ],
  TEST_RECORDED: [
    { path: 'revisionId' },
    { path: 'requirementId' },
    { path: 'sourceId' },
    { path: 'outcome' },
    { path: 'observedAt' },
    { path: 'summary' },
  ],
  EVIDENCE_WITHDRAWN: [
    { path: 'evidenceId' },
    { path: 'sourceId' },
    { path: 'reason' },
  ],
  EVIDENCE_SUPERSEDED: [
    { path: 'oldEvidenceId' },
    { path: 'replacement.revisionId' },
    { path: 'replacement.requirementId' },
    { path: 'replacement.sourceId' },
    { path: 'replacement.outcome' },
    { path: 'replacement.observedAt' },
    { path: 'replacement.summary' },
  ],
};

// Validation field errors ride on the error object itself: { error: { code,
// message, retryable, fields: [{ path, message }] } } — one envelope, per the
// reviewed contract (API_CONTRACT error shape + REVIEW_ADDENDUM P8).
function errorEnvelope(
  code: string,
  message: string,
  retryable: boolean,
  fields?: Array<{ path: string; message: string }>
) {
  return {
    error: {
      code,
      message,
      retryable,
      ...(fields && fields.length > 0 ? { fields } : {}),
    },
  };
}

function successEnvelope(data: any, meta?: any) {
  return { data, meta: { workspaceRevision: meta?.workspaceRevision, synthetic: true, truncated: meta?.truncated, ...meta } };
}

async function getWorkspaceRevision(): Promise<number> {
  const result = await runCypher(`MATCH (w:Workspace {id: $wsId}) RETURN w.revision as revision`, { wsId: FIXED_WORKSPACE_ID });
  return result.data[0]?.revision || 0;
}

function getByPath(obj: any, path: string): any {
  return path.split('.').reduce((acc, key) => (acc == null ? undefined : acc[key]), obj);
}

function validateEventPayload(type: string, payload: any): Array<{ path: string; message: string }> {
  const required = EVENT_REQUIRED_FIELDS[type] || [];
  const fields: Array<{ path: string; message: string }> = [];
  for (const { path } of required) {
    const value = getByPath(payload, path);
    if (value === undefined || value === null || value === '') {
      fields.push({ path, message: `${path} is required for ${type}` });
    }
  }
  if (type === 'TEST_RECORDED' || type === 'EVIDENCE_SUPERSEDED') {
    const outcome = getByPath(payload, type === 'EVIDENCE_SUPERSEDED' ? 'replacement.outcome' : 'outcome');
    if (outcome !== undefined && outcome !== null && outcome !== '' && outcome !== 'PASS' && outcome !== 'FAIL') {
      fields.push({ path: type === 'EVIDENCE_SUPERSEDED' ? 'replacement.outcome' : 'outcome', message: 'outcome must be PASS or FAIL' });
    }
  }
  return fields;
}

// ---------------------------------------------------------------------------
// Decision / release detail composition (contract DTOs)
// ---------------------------------------------------------------------------

async function buildDecisionDto(decisionId: string): Promise<any | null> {
  if (!decisionId) return null;
  const result = await runCypher(
    `MATCH (dec:Decision {id: $decisionId, workspaceId: $wsId})
     OPTIONAL MATCH (dec)-[:SUPPORTED_BY]->(ev:Evidence)
     OPTIONAL MATCH (dec)-[:REPLACES]->(prevDec:Decision)
     OPTIONAL MATCH (dec)-[:ASSESSES]->(decRev:ReleaseRevision)
     RETURN dec.id as id, dec.status as status, dec.reasonCodes as reasonCodes,
            dec.evaluatedAt as evaluatedAt,
            dec.evaluatedWorkspaceRevision as evaluatedWorkspaceRevision,
            dec.policyVersion as policyVersion, dec.revisionId as revisionId,
            decRev.revisionNumber as revisionNumber,
            collect(DISTINCT ev.id) as supportedByEvidenceIds,
            prevDec.id as replacesDecisionId`,
    { decisionId, wsId: FIXED_WORKSPACE_ID }
  );
  if (result.data.length === 0 || !result.data[0].id) return null;
  const row = result.data[0];
  return {
    id: row.id,
    status: row.status,
    reasonCodes: row.reasonCodes || [],
    evaluatedAt: row.evaluatedAt,
    evaluatedWorkspaceRevision: row.evaluatedWorkspaceRevision,
    policyVersion: row.policyVersion || 'v1',
    revisionId: row.revisionId,
    revisionNumber: row.revisionNumber ?? null,
    supportedByEvidenceIds: (row.supportedByEvidenceIds || []).filter(Boolean),
    replacesDecisionId: row.replacesDecisionId || null,
  };
}

async function latestDecisionForRevision(revisionId: string): Promise<any | null> {
  const result = await runCypher(
    `MATCH (dec:Decision)-[:ASSESSES]->(rev:ReleaseRevision {id: $revisionId, workspaceId: $wsId})
     RETURN dec.id as id ORDER BY dec.evaluatedAt DESC LIMIT 1`,
    { revisionId, wsId: FIXED_WORKSPACE_ID }
  );
  if (result.data.length === 0) return null;
  return buildDecisionDto(result.data[0].id);
}

async function fetchRevisionDependencies(revisionId: string): Promise<any[]> {
  const result = await runCypher(
    `MATCH (rev:ReleaseRevision {id: $revisionId, workspaceId: $wsId})-[:DEPENDS_ON]->(dep:DependencyVersion)
     RETURN dep.id as id, dep.dependencyName as dependencyName, dep.version as version`,
    { revisionId, wsId: FIXED_WORKSPACE_ID }
  );
  return result.data;
}

async function buildReleaseDetail(releaseId: string, requestedRevisionId?: string): Promise<any | null> {
  const relResult = await runCypher(
    `MATCH (r:Release {id: $releaseId, workspaceId: $wsId})
     OPTIONAL MATCH (r)-[:CURRENT_REVISION]->(cur:ReleaseRevision)
     OPTIONAL MATCH (ptrDec:Decision {id: r.currentDecisionId})
      RETURN r.id as id, r.name as name,
             r.currentRevisionId as currentRevisionId,
             r.currentDecisionId as currentDecisionId,
             cur.revisionNumber as currentRevisionNumber,
             ptrDec.revisionId as decisionRevisionId,
             ptrDec.status as decisionStatus`,
    { releaseId, wsId: FIXED_WORKSPACE_ID }
  );
  if (relResult.data.length === 0) return null;
  const rel = relResult.data[0];
  const revisionId = requestedRevisionId || rel.currentRevisionId;
  if (!revisionId) return null;

  const revResult = await runCypher(
    `MATCH (rev:ReleaseRevision {id: $revisionId, workspaceId: $wsId})
     RETURN rev.id as id, rev.revisionNumber as revisionNumber, rev.policyVersion as policyVersion`,
    { revisionId, wsId: FIXED_WORKSPACE_ID }
  );
  if (revResult.data.length === 0) return null;
  const revision = revResult.data[0];

  const evaluation = await evaluateReleaseRevision(revisionId);
  if (!evaluation) return null;

  const incompleteEvents = await countIncompleteEvents();
  const viewingCurrent = revisionId === rel.currentRevisionId;
  const pointerFresh = Boolean(rel.currentDecisionId) && rel.decisionRevisionId === rel.currentRevisionId;
  const evaluationPending = !pointerFresh || incompleteEvents > 0;

  // currentDecision: the fresh pointer decision when viewing the current revision;
  // the latest decision for the requested revision otherwise. Null while pending
  // (the pointer still references the previous revision's decision).
  let currentDecision: any = null;
  if (viewingCurrent) {
    currentDecision = pointerFresh ? await buildDecisionDto(rel.currentDecisionId) : null;
  } else {
    currentDecision = await latestDecisionForRevision(revisionId);
  }

  // Historical decision: any Decision for this release that is NOT the
  // current decision pointer (selected by decision ID + currentness). Same-
  // revision historical decisions (older ones REPLACEd by the current) are
  // allowed. Never infer currentness from revision numbers alone.
  const currentDecisionId = rel.currentDecisionId || currentDecision?.id || '';
  const historyResult = await runCypher(
    `MATCH (r:Release {id: $releaseId, workspaceId: $wsId})-[:HAS_REVISION]->(rev:ReleaseRevision)
     MATCH (dec:Decision)-[:ASSESSES]->(rev)
     WHERE dec.id <> $excludeId
     RETURN dec.id as id ORDER BY dec.evaluatedAt DESC LIMIT 1`,
    { releaseId, wsId: FIXED_WORKSPACE_ID, excludeId: currentDecisionId }
  );
  const latestHistoricalDecision = historyResult.data.length > 0
    ? await buildDecisionDto(historyResult.data[0].id)
    : null;

  // previousRevision summary (P6): nearest older revision of this release
  let previousRevision: any = null;
  const prevResult = await runCypher(
    `MATCH (r:Release {id: $releaseId, workspaceId: $wsId})-[:HAS_REVISION]->(prev:ReleaseRevision)
     WHERE prev.revisionNumber < $revisionNumber
     RETURN prev.id as id, prev.revisionNumber as revisionNumber
     ORDER BY prev.revisionNumber DESC LIMIT 1`,
    { releaseId, wsId: FIXED_WORKSPACE_ID, revisionNumber: revision.revisionNumber }
  );
  if (prevResult.data.length > 0) {
    const prev = prevResult.data[0];
    previousRevision = {
      id: prev.id,
      revisionNumber: prev.revisionNumber,
      dependencies: await fetchRevisionDependencies(prev.id),
      latestHistoricalDecision: await latestDecisionForRevision(prev.id),
    };
  }

  const dependencies = await fetchRevisionDependencies(revisionId);

  const requirements = evaluation.requirements.map((req) => ({
    id: req.requirementId,
    checkKind: req.checkKind,
    description: req.description,
    result: req.result,
    explanation: req.explanation,
    reasonCodes: req.reasonCodes,
    evidence: req.evidence.map((ev) => ({
      id: ev.id,
      sourceId: ev.sourceId,
      sourceName: ev.sourceName,
      sourceAuthority: ev.sourceAuthority,
      outcome: ev.outcome,
      observedAt: ev.observedAt,
      receivedAt: ev.receivedAt,
      synthetic: ev.synthetic,
      contentSummary: ev.contentSummary,
      withdrawnByEventId: ev.withdrawnByEventId,
      supersededByEvidenceId: ev.supersededByEvidenceId,
      applicabilityReasonCodes: ev.applicabilityReasonCodes,
      applicable: ev.applicable,
      applicabilityExplanation: ev.explanation,
      requirementId: ev.requirementId,
      revisionId: ev.revisionId,
    })),
  }));

  // Correction 7: status is server-supplied (never derived client-side from
  // the nullable currentDecision). Mirrors getReleaseSummaries: pointer
  // decision status with NEEDS_REVIEW fallback/overrides; for a historical
  // revision view, the latest decision that assessed that revision.
  let status: string;
  if (viewingCurrent) {
    status = rel.decisionStatus || 'NEEDS_REVIEW';
    if (incompleteEvents > 0) status = 'NEEDS_REVIEW';
  } else {
    status = currentDecision?.status || 'NEEDS_REVIEW';
  }

  return {
    id: rel.id,
    name: rel.name,
    status,
    revision: {
      id: revision.id,
      revisionNumber: revision.revisionNumber,
      policyVersion: revision.policyVersion || 'v1',
    },
    currentDecision,
    previousRevision,
    latestHistoricalDecision,
    requirements,
    dependencies,
    evaluationPending,
  };
}

// ---------------------------------------------------------------------------
// Run / proposal DTOs
// ---------------------------------------------------------------------------

function extractReturnedEntityIds(args: Record<string, any> | null, content: string): string[] {
  const ids = new Set<string>();
  const consider = (value: unknown) => {
    if (typeof value === 'string' && RECORD_ID_RE.test(value)) ids.add(value);
  };
  if (args && typeof args === 'object') {
    Object.values(args).forEach(consider);
  }
  if (content && content.trim().startsWith('{') || content?.trim().startsWith('[')) {
    try {
      const walk = (node: unknown, depth: number): void => {
        if (depth > 6 || node == null) return;
        if (Array.isArray(node)) {
          node.forEach((v) => walk(v, depth + 1));
          return;
        }
        if (typeof node === 'object') {
          for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
            if (typeof v === 'string' && ENTITY_ID_RE.test(v) && RECORD_ID_RE.test(v)) {
              ids.add(v);
            } else {
              walk(v, depth + 1);
            }
          }
        }
      };
      walk(JSON.parse(content), 0);
    } catch {
      // content is not JSON; fall back to regex over the raw string
      const matches = content.match(ENTITY_ID_RE) || [];
      matches.forEach((m) => consider(m));
    }
  } else if (content) {
    const matches = content.match(ENTITY_ID_RE) || [];
    matches.forEach((m) => consider(m));
  }
  return [...ids].slice(0, 20);
}

function mapRunStepDto(step: any): any {
  let args: Record<string, unknown> = {};
  if (typeof step.arguments === 'string') {
    try {
      args = JSON.parse(step.arguments);
    } catch {
      args = { raw: step.arguments };
    }
  } else if (step.arguments && typeof step.arguments === 'object') {
    args = step.arguments;
  }

  const content = typeof step.result?.content === 'string'
    ? step.result.content
    : step.result?.content
      ? JSON.stringify(step.result.content)
      : '';

  return {
    tool: step.tool,
    arguments: args,
    resultSummary: content.length > 500 ? `${content.slice(0, 500)}…` : content,
    returnedEntityIds: extractReturnedEntityIds(args, content),
    error: step.error ?? null,
    timestamp: step.timestamp,
  };
}

function mapProposalDto(p: any, wsRev?: number): any {
  // Read-path staleness: a PENDING proposal pinned to an older workspace
  // revision is presented as STALE even when no apply attempt has persisted it
  // yet, so refetched state is authoritative for clients.
  const derivedStale =
    p.status === 'PENDING' &&
    typeof p.expectedRevision === 'number' &&
    typeof wsRev === 'number' &&
    p.expectedRevision < wsRev;
  return {
    id: p.id,
    runId: p.runId,
    actionType: p.actionType,
    status: derivedStale ? 'STALE' : p.status,
    reason: p.reason || '',
    citedIds: p.citedIds || [],
    expectedRevision: p.expectedRevision,
    releaseId: p.releaseId,
    revisionId: p.revisionId,
    requirementId: p.requirementId ?? null,
    createdAt: p.createdAt,
    appliedAt: p.appliedAt ?? null,
    decisionId: p.decisionId ?? null,
    taskId: p.taskId ?? null,
  };
}

function mapRunSummaryDto(run: any): any {
  return {
    runId: run.runId,
    releaseId: run.releaseId,
    status: run.status,
    completionReason: run.completionReason || '',
    snapshotRevision: run.snapshotRevision,
    proposalIds: run.proposalIds || [],
    startedAt: run.startedAt,
    completedAt: run.endedAt ?? null,
    eventId: run.eventId ?? null,
  };
}

async function buildRunDetailDto(runId: string, wsRev?: number): Promise<any | null> {
  const run = await getRun(runId);
  if (!run) return null;

  const proposalIds = [...new Set(run.proposals)];
  const proposalRows = await Promise.all(proposalIds.map((pid) => getProposal(pid)));
  const proposals = proposalRows.filter(Boolean).map((p) => mapProposalDto(p, wsRev));

  return {
    runId: run.runId,
    releaseId: run.releaseId,
    status: run.status,
    completionReason: run.completionReason || '',
    explanation: run.findings || '',
    snapshotRevision: run.expectedRevision,
    steps: (run.steps || []).map(mapRunStepDto),
    proposalIds: proposals.map((p: any) => p.id),
    startedAt: run.startedAt,
    completedAt: run.endedAt ?? null,
    eventId: run.eventId ?? null,
    provider: run.provider ?? null,
    model: run.model ?? null,
    proposals,
  };
}

// ---------------------------------------------------------------------------
// Records (P3: allowlisted typed summaries)
// ---------------------------------------------------------------------------

function pickFields(props: Record<string, any>, keys: string[], nullKeys: string[] = []): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  for (const key of keys) {
    if (props[key] !== undefined) fields[key] = props[key];
  }
  for (const key of nullKeys) {
    if (fields[key] === undefined) fields[key] = null;
  }
  return fields;
}

async function buildRecordDetail(recordId: string): Promise<any | null> {
  if (!RECORD_ID_RE.test(recordId)) return null;
  const nodeResult = await runCypher(
    `MATCH (n {id: $recordId, workspaceId: $wsId})
     RETURN labels(n) as labels, properties(n) as props
     LIMIT 1`,
    { recordId, wsId: FIXED_WORKSPACE_ID }
  );
  if (nodeResult.data.length === 0) return null;
  const labels: string[] = nodeResult.data[0].labels || [];
  const props: Record<string, any> = nodeResult.data[0].props || {};
  const type: string = props.type || labels[0];
  if (!type || type === 'Workspace') return null;

  let label = String(recordId);
  let domainStatus: string | undefined;
  let fields: Record<string, unknown> = {};

  switch (type) {
    case 'Release':
      label = props.name || recordId;
      fields = pickFields(props, ['name', 'currentRevisionId', 'currentDecisionId']);
      break;
    case 'ReleaseRevision':
      label = props.revisionNumber != null ? `Revision ${props.revisionNumber}` : recordId;
      fields = pickFields(props, ['revisionNumber', 'policyVersion', 'releaseId']);
      break;
    case 'DependencyVersion':
      label = props.dependencyName
        ? `${props.dependencyName}@${props.version}`
        : recordId;
      fields = pickFields(props, ['dependencyName', 'version']);
      break;
    case 'Requirement':
      label = props.description || recordId;
      fields = pickFields(props, ['checkKind', 'description', 'revisionId', 'requiredVersion']);
      break;
    case 'Evidence':
      label = props.contentSummary || recordId;
      domainStatus = props.outcome;
      fields = pickFields(
        props,
        ['outcome', 'sourceId', 'revisionId', 'observedAt', 'receivedAt', 'synthetic', 'contentSummary'],
        ['withdrawnByEventId', 'supersededByEvidenceId']
      );
      break;
    case 'Source':
      label = props.name || recordId;
      fields = pickFields(props, ['name', 'authority', 'synthetic']);
      break;
    case 'Decision':
      label = props.status || recordId;
      domainStatus = props.status;
      fields = pickFields(props, ['status', 'reasonCodes', 'evaluatedAt', 'evaluatedWorkspaceRevision', 'policyVersion', 'revisionId']);
      break;
    case 'Event':
      label = props.type || props.eventType || recordId;
      fields = pickFields(
        props,
        ['type', 'applicationState', 'receivedAt', 'affectedReleases', 'revisionId'],
        ['evidenceId', 'decisionId']
      );
      break;
    case 'ReviewTask':
      label = props.description || props.taskKey || recordId;
      domainStatus = props.status;
      fields = pickFields(
        props,
        ['taskKey', 'status', 'description', 'releaseId', 'revisionId', 'requirementId', 'createdAt', 'resolvedByEvidenceIds'],
        ['resolvedAt', 'createdByProposalId', 'resolvedByProposalId', 'resolvedByDecisionId']
      );
      break;
    case 'AgentRun':
      label = props.releaseId ? `Run ${recordId}` : recordId;
      domainStatus = props.status;
      fields = pickFields(
        props,
        ['status', 'completionReason', 'releaseId', 'revisionId', 'trigger', 'startedAt', 'provider', 'model'],
        ['eventId', 'endedAt', 'error']
      );
      break;
    case 'Proposal':
      label = props.actionType || recordId;
      domainStatus = props.status;
      fields = pickFields(
        props,
        ['actionType', 'status', 'reason', 'citedIds', 'expectedRevision', 'releaseId', 'revisionId', 'createdAt'],
        ['requirementId', 'appliedAt', 'decisionId', 'taskId']
      );
      break;
    default:
      fields = {};
  }

  const edgeResult = await runCypher(
    `MATCH (n {id: $recordId, workspaceId: $wsId})-[r]-(m)
     WHERE m.workspaceId = $wsId
     RETURN type(r) as edgeType, m.id as targetId, properties(m) as targetProps
     LIMIT $edgeLimit`,
    { recordId, wsId: FIXED_WORKSPACE_ID, edgeLimit: RECORD_EDGE_LIMIT }
  );

  const incidentEdges = edgeResult.data.map((row: any) => {
    const tp = row.targetProps || {};
    const targetLabel =
      tp.name ||
      tp.description ||
      tp.contentSummary ||
      (tp.revisionNumber != null ? `Revision ${tp.revisionNumber}` : undefined) ||
      tp.taskKey ||
      row.targetId;
    return {
      type: row.edgeType,
      targetId: row.targetId,
      targetLabel,
      historical: HISTORICAL_EDGE_TYPES.has(row.edgeType),
    };
  });

  return {
    type,
    id: recordId,
    label,
    domainStatus,
    sourceRecordId: recordId,
    fields,
    incidentEdges,
  };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

apiRouter.get('/health', async (_req: Request, res: Response) => {
  try {
    const dbHealth = await healthCheck();
    const modelHealth = config.model.apiKey && config.model.apiKey !== 'your_openrouter_key_here';
    const testDoubleActive = isTestModelDoubleActive();
    const modelLabel = getModelLabel();
    res.json(successEnvelope({
      database: dbHealth.database,
      agent: modelHealth,
      details: dbHealth.details,
      testModelDoubleActive: testDoubleActive,
      provider: modelLabel.provider,
      model: modelLabel.model,
    }));
  } catch (error) {
    res.status(503).json(errorEnvelope('DB_UNAVAILABLE', 'Health check failed', true));
  }
});

apiRouter.get('/sources', async (_req: Request, res: Response) => {
  try {
    const result = await runCypher(
      `MATCH (s:Source {workspaceId: $wsId})
       RETURN s.id as id, s.name as name, s.authority as authority, s.synthetic as synthetic
       ORDER BY s.name ASC`,
      { wsId: FIXED_WORKSPACE_ID }
    );
    const wsRev = await getWorkspaceRevision();
    const sources = result.data.map((row: any) => ({
      id: row.id,
      name: row.name,
      authority: row.authority === 'allowlisted' ? 'allowlisted' : 'untrusted',
      synthetic: Boolean(row.synthetic),
    }));
    res.json(successEnvelope(sources, { workspaceRevision: wsRev }));
  } catch (error) {
    res.status(500).json(errorEnvelope('DB_UNAVAILABLE', 'Failed to retrieve sources', true));
  }
});

apiRouter.get('/records/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const revisionParam = req.query.revisionId;

    const detail = await buildRecordDetail(id);
    if (!detail) {
      return res.status(404).json(errorEnvelope('NOT_FOUND', 'Record not found in this workspace', false));
    }

    if (detail.type === 'Evidence' && typeof revisionParam === 'string' && revisionParam) {
      const revCheck = await runCypher(
        `MATCH (rev:ReleaseRevision {id: $revisionId, workspaceId: $wsId}) RETURN rev.id as id`,
        { revisionId: revisionParam, wsId: FIXED_WORKSPACE_ID }
      );
      if (revCheck.data.length === 0) {
        return res.status(404).json(errorEnvelope('NOT_FOUND', 'Revision not found in this workspace', false));
      }
      const codes = computeApplicabilityCodes(
        {
          withdrawnByEventId: (detail.fields.withdrawnByEventId as string | null) ?? null,
          supersededByEvidenceId: (detail.fields.supersededByEvidenceId as string | null) ?? null,
          revisionId: (detail.fields.revisionId as string) || '',
        },
        revisionParam
      );
      detail.fields.applicabilityReasonCodes = codes;
      detail.applicable = codes.length === 0;
      detail.evaluatedRevisionId = revisionParam;
    }

    const wsRev = await getWorkspaceRevision();
    res.json(successEnvelope(detail, { workspaceRevision: wsRev }));
  } catch (error) {
    res.status(500).json(errorEnvelope('DB_UNAVAILABLE', 'Failed to retrieve record', true));
  }
});

apiRouter.get('/releases', async (_req: Request, res: Response) => {
  try {
    const summaries = await getReleaseSummaries();
    const wsRev = await getWorkspaceRevision();
    res.json(successEnvelope(summaries, { workspaceRevision: wsRev }));
  } catch (error) {
    res.status(500).json(errorEnvelope('DB_UNAVAILABLE', 'Failed to retrieve releases', true));
  }
});

apiRouter.get('/releases/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { revisionId } = req.query;

    if (revisionId !== undefined && typeof revisionId !== 'string') {
      return res.status(400).json(errorEnvelope('VALIDATION_ERROR', 'revisionId must be a string', false));
    }

    const detail = await buildReleaseDetail(id, revisionId as string | undefined);
    if (!detail) {
      const code = revisionId ? 'NOT_FOUND' : 'NOT_FOUND';
      const message = revisionId ? 'Release or revision not found in this workspace' : 'Release not found in this workspace';
      return res.status(404).json(errorEnvelope(code, message, false));
    }

    const wsRev = await getWorkspaceRevision();
    res.json(successEnvelope(detail, { workspaceRevision: wsRev }));
  } catch (error) {
    res.status(500).json(errorEnvelope('DB_UNAVAILABLE', 'Failed to retrieve release', true));
  }
});

apiRouter.get('/releases/:id/history', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { cursor } = req.query;
    const limit = 20;

    const releaseCheck = await runCypher(
      `MATCH (r:Release {id: $id, workspaceId: $wsId}) RETURN r.id as id`,
      { id, wsId: FIXED_WORKSPACE_ID }
    );
    if (releaseCheck.data.length === 0) {
      return res.status(404).json(errorEnvelope('NOT_FOUND', 'Release not found', false));
    }

    let query = `
      MATCH (r:Release {id: $id, workspaceId: $wsId})-[:HAS_REVISION]->(rev:ReleaseRevision)
      OPTIONAL MATCH (dec:Decision)-[:ASSESSES]->(rev)
      OPTIONAL MATCH (dec)-[:SUPPORTED_BY]->(ev:Evidence)
      OPTIONAL MATCH (dec)-[:REPLACES]->(prevDec:Decision)
      WITH dec, rev, collect(DISTINCT ev.id) as supportedByEvidenceIds, prevDec
      WHERE dec IS NOT NULL
    `;
    const params: any = { id, wsId: FIXED_WORKSPACE_ID, limit: limit + 1 };

    if (cursor) {
      query += ` AND dec.evaluatedAt < $cursor `;
      params.cursor = cursor;
    }

    query += `
      RETURN dec.id as decisionId, dec.status as status, dec.reasonCodes as reasonCodes,
             dec.evaluatedAt as evaluatedAt, dec.evaluatedWorkspaceRevision as evaluatedWorkspaceRevision,
             dec.policyVersion as policyVersion,
             rev.id as revisionId, rev.revisionNumber as revisionNumber,
             supportedByEvidenceIds,
             prevDec.id as replacesDecisionId
      ORDER BY dec.evaluatedAt DESC
      LIMIT $limit
    `;

    const result = await runCypher(query, params);

    const decisions = result.data.slice(0, limit).map((row: any) => ({
      decisionId: row.decisionId,
      status: row.status,
      reasonCodes: row.reasonCodes,
      evaluatedAt: row.evaluatedAt,
      evaluatedWorkspaceRevision: row.evaluatedWorkspaceRevision,
      policyVersion: row.policyVersion ?? 'v1',
      revisionId: row.revisionId ?? null,
      revisionNumber: row.revisionNumber ?? null,
      supportedByEvidenceIds: row.supportedByEvidenceIds.filter((id: any) => id),
      replacesDecisionId: row.replacesDecisionId,
    }));

    const nextCursor = result.data.length > limit ? decisions[decisions.length - 1].evaluatedAt : null;

    const wsRev = await getWorkspaceRevision();
    res.json(successEnvelope({ decisions, nextCursor }, { workspaceRevision: wsRev }));
  } catch (error) {
    res.status(500).json(errorEnvelope('DB_UNAVAILABLE', 'Failed to retrieve history', true));
  }
});

apiRouter.get('/releases/:id/graph', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { scope = 'CURRENT' } = req.query;

    if (scope !== 'CURRENT' && scope !== 'HISTORY') {
      return res.status(400).json(errorEnvelope('VALIDATION_ERROR', 'scope must be CURRENT or HISTORY', false));
    }

    const revisionResult = await runCypher(
      `MATCH (r:Release {id: $id, workspaceId: $wsId})-[:CURRENT_REVISION]->(rev:ReleaseRevision)
       RETURN rev.id as revisionId`,
      { id, wsId: FIXED_WORKSPACE_ID }
    );

    if (revisionResult.data.length === 0) {
      return res.status(404).json(errorEnvelope('NOT_FOUND', 'Release not found', false));
    }

    const revisionId = revisionResult.data[0].revisionId;
    const graphView = await getGraphView(revisionId, scope as 'CURRENT' | 'HISTORY');

    // Keep only edges whose endpoints are both in the returned node set, and
    // label server-known historical relationships (P5 / correction 1).
    const nodeIds = new Set(graphView.nodes.map((n: any) => n.id));
    const edges = graphView.edges
      .filter((e: any) => nodeIds.has(e.source) && nodeIds.has(e.target))
      .map((e: any) => ({
        ...e,
        historical: HISTORICAL_EDGE_TYPES.has(e.type),
      }));

    const wsRev = await getWorkspaceRevision();
    res.json(
      successEnvelope(
        { nodes: graphView.nodes, edges, paths: [], truncated: graphView.truncated, scope },
        { workspaceRevision: wsRev, scope }
      )
    );
  } catch (error) {
    res.status(500).json(errorEnvelope('DB_UNAVAILABLE', 'Failed to retrieve graph', true));
  }
});

apiRouter.post('/events', async (req: Request, res: Response) => {
  try {
    const { type, payload, expectedRevision, idempotencyKey } = req.body;

    if (!type || !payload || expectedRevision === undefined) {
      return res.status(400).json(errorEnvelope('VALIDATION_ERROR', 'type, payload, and expectedRevision are required', false));
    }

    if (!EVENT_REQUIRED_FIELDS[type]) {
      return res.status(400).json(errorEnvelope('VALIDATION_ERROR', `Unknown event type: ${type}`, false));
    }

    const fieldErrors = validateEventPayload(type, payload);
    if (fieldErrors.length > 0) {
      return res.status(400).json(
        errorEnvelope('VALIDATION_ERROR', `Invalid payload for ${type}`, false, fieldErrors)
      );
    }

    const key = idempotencyKey || generateIdempotencyKey();

    let event: any;
    switch (type) {
      case 'DEPENDENCY_CHANGED':
        event = { type: 'DEPENDENCY_CHANGED', ...payload };
        break;
      case 'TEST_RECORDED':
        event = { type: 'TEST_RECORDED', ...payload };
        break;
      case 'EVIDENCE_WITHDRAWN':
        event = { type: 'EVIDENCE_WITHDRAWN', ...payload };
        break;
      case 'EVIDENCE_SUPERSEDED':
        event = { type: 'EVIDENCE_SUPERSEDED', ...payload };
        break;
      default:
        return res.status(400).json(errorEnvelope('VALIDATION_ERROR', `Unknown event type: ${type}`, false));
    }

    const result = await applyDomainEvent(event, expectedRevision, key);

    // affectedReleases comes back as IDs; expand to release summaries for the UI
    const summaries = await getReleaseSummaries();
    const affectedReleases = (result.affectedReleases || [])
      .map((releaseId: string) => summaries.find((s) => s.id === releaseId))
      .filter(Boolean)
      .map((s: any) => ({
        releaseId: s.id,
        name: s.name,
        status: s.status,
        evaluationPending: s.evaluationPending,
      }));

    const wsRev = await getWorkspaceRevision();
    res.json(
      successEnvelope(
        { eventId: result.eventId, newWorkspaceRevision: result.newWorkspaceRevision, affectedReleases },
        { workspaceRevision: wsRev, idempotencyKey: key }
      )
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Event application failed';
    if (message.includes('STALE_REVISION')) {
      return res.status(409).json(errorEnvelope('STALE_REVISION', message, true));
    }
    if (message.includes('DUPLICATE_KEY_CONFLICT')) {
      return res.status(409).json(errorEnvelope('DUPLICATE_KEY_CONFLICT', message, false));
    }
    if (message.includes('VALIDATION_ERROR')) {
      return res.status(400).json(errorEnvelope('VALIDATION_ERROR', message, false));
    }
    if (message.includes('INCOMPLETE_PRIOR_ATTEMPT')) {
      return res.status(409).json(errorEnvelope('INCOMPLETE_PRIOR_ATTEMPT', message, true));
    }
    res.status(500).json(errorEnvelope('DB_UNAVAILABLE', message, true));
  }
});

apiRouter.post('/agent/runs', async (req: Request, res: Response) => {
  try {
    const { releaseId, expectedRevision, eventId } = req.body;

    if (!releaseId || expectedRevision === undefined) {
      return res.status(400).json(errorEnvelope('VALIDATION_ERROR', 'releaseId and expectedRevision are required', false));
    }

    const wsRev = await getWorkspaceRevision();
    if (wsRev !== expectedRevision) {
      return res.status(409).json(errorEnvelope('STALE_REVISION', `Expected revision ${expectedRevision}, current is ${wsRev}`, true));
    }

    const { runId, status } = await createRun(releaseId, expectedRevision, eventId ? 'event' : 'manual', eventId);

    executeRun(runId).catch(err => {
      console.error(`Run ${runId} failed:`, err);
    });

    res.status(202).json(
      successEnvelope(
        {
          runId,
          releaseId,
          status,
          completionReason: '',
          snapshotRevision: expectedRevision,
          proposalIds: [],
          startedAt: nowISO(),
          completedAt: null,
          eventId: eventId || null,
        },
        { workspaceRevision: wsRev }
      )
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Run creation failed';
    if (message.includes('STALE_REVISION')) {
      return res.status(409).json(errorEnvelope('STALE_REVISION', message, true));
    }
    if (message.includes('not found')) {
      return res.status(404).json(errorEnvelope('NOT_FOUND', message, false));
    }
    res.status(500).json(errorEnvelope('RUN_FAILED', message, true));
  }
});

apiRouter.get('/agent/runs', async (req: Request, res: Response) => {
  try {
    const { releaseId, cursor, limit } = req.query;
    const { runs, nextCursor } = await listRuns(
      releaseId as string,
      cursor as string,
      parseInt(limit as string) || 20
    );
    const wsRev = await getWorkspaceRevision();
    res.json(successEnvelope({ runs: runs.map(mapRunSummaryDto), nextCursor }, { workspaceRevision: wsRev }));
  } catch (error) {
    res.status(500).json(errorEnvelope('DB_UNAVAILABLE', 'Failed to list runs', true));
  }
});

apiRouter.get('/agent/runs/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const wsRev = await getWorkspaceRevision();
    const detail = await buildRunDetailDto(id, wsRev);

    if (!detail) {
      return res.status(404).json(errorEnvelope('NOT_FOUND', 'Run not found', false));
    }

    res.json(successEnvelope(detail, { workspaceRevision: wsRev }));
  } catch (error) {
    res.status(500).json(errorEnvelope('DB_UNAVAILABLE', 'Failed to retrieve run', true));
  }
});

apiRouter.get('/proposals/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const proposal = await getProposal(id);

    if (!proposal) {
      return res.status(404).json(errorEnvelope('NOT_FOUND', 'Proposal not found', false));
    }

    const wsRev = await getWorkspaceRevision();
    res.json(successEnvelope(mapProposalDto(proposal, wsRev), { workspaceRevision: wsRev }));
  } catch (error) {
    res.status(500).json(errorEnvelope('DB_UNAVAILABLE', 'Failed to retrieve proposal', true));
  }
});

apiRouter.post('/proposals/:id/apply', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { expectedRevision, idempotencyKey } = req.body;

    if (expectedRevision === undefined) {
      return res.status(400).json(errorEnvelope('VALIDATION_ERROR', 'expectedRevision is required', false));
    }

    const existing = await getProposal(id);
    if (!existing) {
      return res.status(404).json(errorEnvelope('NOT_FOUND', 'Proposal not found', false));
    }

    const key = idempotencyKey || generateIdempotencyKey();
    const result = await applyProposal(id, expectedRevision, key);

    if (result.alreadyApplied || (result as any).error === 'already applied') {
      const wsRev = await getWorkspaceRevision();
      const nested = (result as any).result || {};
      return res.json(
        successEnvelope(
          {
            decisionId: nested.decisionId ?? null,
            taskId: nested.taskId ?? null,
            newWorkspaceRevision: (result as any).newWorkspaceRevision ?? wsRev,
            idempotent: true,
          },
          { workspaceRevision: wsRev }
        )
      );
    }

    if (!result.success) {
      if (result.error?.includes('STALE_REVISION')) {
        return res.status(409).json(errorEnvelope('STALE_REVISION', result.error, true));
      }
      return res.status(400).json(errorEnvelope('VALIDATION_ERROR', result.error || 'Proposal application failed', false));
    }

    const wsRev = await getWorkspaceRevision();
    res.json(
      successEnvelope(
        {
          decisionId: result.decisionId ?? null,
          taskId: result.taskId ?? null,
          newWorkspaceRevision: (result as any).newWorkspaceRevision ?? wsRev,
        },
        { workspaceRevision: wsRev }
      )
    );
  } catch (error) {
    res.status(500).json(errorEnvelope('DB_UNAVAILABLE', 'Proposal application failed', true));
  }
});

apiRouter.get('/tasks', async (req: Request, res: Response) => {
  try {
    const { releaseId, status } = req.query;
    const tasks = await listTasks(releaseId as string, status as 'OPEN' | 'RESOLVED');
    const wsRev = await getWorkspaceRevision();
    res.json(successEnvelope(tasks, { workspaceRevision: wsRev }));
  } catch (error) {
    res.status(500).json(errorEnvelope('DB_UNAVAILABLE', 'Failed to list tasks', true));
  }
});

apiRouter.get('/tasks/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const task = await getTask(id);

    if (!task) {
      return res.status(404).json(errorEnvelope('NOT_FOUND', 'Task not found', false));
    }

    const wsRev = await getWorkspaceRevision();
    res.json(successEnvelope(task, { workspaceRevision: wsRev }));
  } catch (error) {
    res.status(500).json(errorEnvelope('DB_UNAVAILABLE', 'Failed to retrieve task', true));
  }
});

app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error('Unhandled error:', err);
  res.status(500).json(errorEnvelope('INTERNAL_ERROR', 'Internal server error', false));
});

export async function startServer(): Promise<void> {
  validateConfig();
  const port = config.server.port;

  await runCypher(`MATCH (w:Workspace {id: $wsId}) RETURN w.revision as revision`, { wsId: FIXED_WORKSPACE_ID });

  app.listen(port, () => {
    console.log(`AFTERIMAGE API server listening on port ${port}`);
  });
}

export { app };
