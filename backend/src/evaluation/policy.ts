import { runCypher } from '../graph/client';
import { FIXED_WORKSPACE_ID } from '../seed/fixtures';
import { generateDecisionId, nowISO } from '../domain/ids';

export type RequirementResult = 'SATISFIED' | 'MISSING' | 'CONFLICTING' | 'FAILING' | 'NOT_EVALUATED';

export interface EvaluatedEvidence {
  id: string;
  sourceId: string;
  outcome: 'PASS' | 'FAIL';
  observedAt: string;
  receivedAt: string;
  synthetic: boolean;
  contentSummary: string;
  withdrawnByEventId: string | null;
  supersededByEvidenceId: string | null;
  revisionId: string;
  requirementId: string;
  sourceAuthority: 'allowlisted' | 'untrusted';
  sourceName: string;
  applicabilityReasonCodes: string[];
  applicable: boolean;
  explanation: string;
}

export interface RequirementEvaluation {
  requirementId: string;
  checkKind: string;
  description: string;
  result: RequirementResult;
  explanation: string;
  reasonCodes: string[];
  evidence: EvaluatedEvidence[];
  supportingEvidenceIds: string[];
  conflictingEvidenceIds: string[];
}

export interface ReleaseEvaluation {
  releaseId: string;
  releaseName: string;
  revisionId: string;
  revisionNumber: number;
  status: 'APPROVED' | 'NEEDS_REVIEW' | 'BLOCKED';
  reasonCodes: string[];
  evaluatedAt: string;
  evaluatedWorkspaceRevision: number;
  requirements: RequirementEvaluation[];
  supportedByEvidenceIds: string[];
  evaluationIncomplete: boolean;
}

export const REASON_CODES = {
  ALL_REQUIREMENTS_SATISFIED: 'ALL_REQUIREMENTS_SATISFIED',
  MISSING_EVIDENCE: 'MISSING_EVIDENCE',
  REVISION_MISMATCH: 'REVISION_MISMATCH',
  DEPENDENCY_MISMATCH: 'DEPENDENCY_MISMATCH',
  UNTRUSTED_SOURCE: 'UNTRUSTED_SOURCE',
  EVIDENCE_WITHDRAWN: 'EVIDENCE_WITHDRAWN',
  EVIDENCE_SUPERSEDED: 'EVIDENCE_SUPERSEDED',
  CONFLICTING_EVIDENCE: 'CONFLICTING_EVIDENCE',
  APPLICABLE_FAILURE: 'APPLICABLE_FAILURE',
  EVALUATION_PENDING: 'EVALUATION_PENDING',
  INCOMPLETE_CONTEXT: 'INCOMPLETE_CONTEXT',
} as const;

export function evidenceLimit(): number {
  const raw = parseInt(process.env.EVIDENCE_LIMIT || '500', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 500;
}

export async function countIncompleteEvents(): Promise<number> {
  const result = await runCypher(
    `MATCH (e:Event {workspaceId: $wsId}) WHERE e.applicationState IN ['PENDING', 'FAILED'] RETURN count(e) as c`,
    { wsId: FIXED_WORKSPACE_ID }
  );
  return result.data[0]?.c || 0;
}

async function getWorkspaceRevisionValue(): Promise<number> {
  const result = await runCypher(`MATCH (w:Workspace {id: $wsId}) RETURN w.revision as revision`, { wsId: FIXED_WORKSPACE_ID });
  return result.data[0]?.revision || 1;
}

export function computeApplicabilityCodes(
  raw: { withdrawnByEventId: string | null; supersededByEvidenceId: string | null; revisionId: string },
  evaluatedRevisionId: string
): string[] {
  const codes: string[] = [];
  if (raw.withdrawnByEventId) {
    codes.push(REASON_CODES.EVIDENCE_WITHDRAWN);
  } else if (raw.supersededByEvidenceId) {
    codes.push(REASON_CODES.EVIDENCE_SUPERSEDED);
  } else if (raw.revisionId !== evaluatedRevisionId) {
    codes.push(REASON_CODES.REVISION_MISMATCH);
  }
  return codes;
}

function buildEvidenceExplanation(
  evidenceId: string,
  codes: string[],
  sourceAuthority: string,
  sourceName: string,
  outcome: string,
  evaluatedRevisionId: string
): string {
  if (codes.includes(REASON_CODES.EVIDENCE_WITHDRAWN)) {
    return `Evidence ${evidenceId} was withdrawn and does not count toward any requirement.`;
  }
  if (codes.includes(REASON_CODES.EVIDENCE_SUPERSEDED)) {
    return `Evidence ${evidenceId} was explicitly superseded and does not count toward any requirement.`;
  }
  if (codes.includes(REASON_CODES.REVISION_MISMATCH)) {
    return `Evidence ${evidenceId} is recorded against a different release revision than ${evaluatedRevisionId}; it is returned as context only and cannot satisfy this revision.`;
  }
  if (codes.includes(REASON_CODES.DEPENDENCY_MISMATCH)) {
    return `Evidence ${evidenceId} dependency scope does not match the evaluated revision ${evaluatedRevisionId}.`;
  }
  if (sourceAuthority === 'untrusted') {
    return `Evidence ${evidenceId} is applicable but comes from untrusted source ${sourceName || 'unknown'}; untrusted evidence cannot satisfy requirements.`;
  }
  if (outcome === 'PASS') {
    return `Evidence ${evidenceId} is an applicable PASS from allowlisted source ${sourceName || 'unknown'}.`;
  }
  return `Evidence ${evidenceId} is an applicable FAIL from allowlisted source ${sourceName || 'unknown'}.`;
}

export function buildEvaluatedEvidence(
  raw: {
    id: string;
    sourceId: string;
    outcome: 'PASS' | 'FAIL';
    observedAt: string;
    receivedAt: string;
    synthetic: boolean;
    contentSummary: string;
    withdrawnByEventId: string | null;
    supersededByEvidenceId: string | null;
    revisionId: string;
    sourceAuthority: string | null;
    sourceName: string | null;
  },
  evaluatedRevisionId: string,
  requirementId: string
): EvaluatedEvidence {
  const supersededByEvidenceId = raw.supersededByEvidenceId || null;
  const applicabilityReasonCodes = computeApplicabilityCodes(
    {
      withdrawnByEventId: raw.withdrawnByEventId || null,
      supersededByEvidenceId,
      revisionId: raw.revisionId,
    },
    evaluatedRevisionId
  );
  const sourceAuthority: 'allowlisted' | 'untrusted' = raw.sourceAuthority === 'allowlisted' ? 'allowlisted' : 'untrusted';
  return {
    id: raw.id,
    sourceId: raw.sourceId,
    outcome: raw.outcome,
    observedAt: raw.observedAt,
    receivedAt: raw.receivedAt,
    synthetic: Boolean(raw.synthetic),
    contentSummary: raw.contentSummary,
    withdrawnByEventId: raw.withdrawnByEventId || null,
    supersededByEvidenceId,
    revisionId: raw.revisionId,
    requirementId,
    sourceAuthority,
    sourceName: raw.sourceName || '',
    applicabilityReasonCodes,
    applicable: applicabilityReasonCodes.length === 0,
    explanation: buildEvidenceExplanation(raw.id, applicabilityReasonCodes, sourceAuthority, raw.sourceName || '', raw.outcome, evaluatedRevisionId),
  };
}

export function evaluateRequirement(
  requirementId: string,
  checkKind: string,
  description: string,
  evidence: EvaluatedEvidence[]
): RequirementEvaluation {
  const applicableEvidence = evidence.filter((e) => e.applicable);
  const trustedApplicable = applicableEvidence.filter((e) => e.sourceAuthority === 'allowlisted');
  const untrustedApplicable = applicableEvidence.filter((e) => e.sourceAuthority === 'untrusted');
  const trustedPass = trustedApplicable.filter((e) => e.outcome === 'PASS');
  const trustedFail = trustedApplicable.filter((e) => e.outcome === 'FAIL');
  const untrustedPass = untrustedApplicable.filter((e) => e.outcome === 'PASS');
  const untrustedFail = untrustedApplicable.filter((e) => e.outcome === 'FAIL');

  let result: RequirementResult;
  const primaryCodes: string[] = [];
  let explanation: string;

  if (applicableEvidence.length === 0) {
    result = 'MISSING';
    primaryCodes.push(REASON_CODES.MISSING_EVIDENCE);
    explanation = `No applicable evidence found for requirement "${description}" (checkKind: ${checkKind}).`;
  } else if (trustedFail.length > 0 && trustedPass.length > 0) {
    result = 'CONFLICTING';
    primaryCodes.push(REASON_CODES.CONFLICTING_EVIDENCE);
    explanation = `Unresolved conflict for requirement "${description}": ${trustedPass.length} trusted PASS and ${trustedFail.length} applicable FAIL evidence exist for the same scope. Latest evidence does not automatically win.`;
  } else if (trustedFail.length > 0) {
    result = 'FAILING';
    primaryCodes.push(REASON_CODES.APPLICABLE_FAILURE);
    explanation = `Applicable FAIL evidence from an allowlisted source exists without any trusted PASS for requirement "${description}".`;
  } else if (trustedPass.length > 0) {
    result = 'SATISFIED';
    primaryCodes.push(REASON_CODES.ALL_REQUIREMENTS_SATISFIED);
    explanation = `Requirement "${description}" is satisfied by ${trustedPass.length} trusted PASS evidence from allowlisted sources.`;
  } else if (untrustedPass.length > 0 || untrustedFail.length > 0) {
    result = 'MISSING';
    primaryCodes.push(REASON_CODES.UNTRUSTED_SOURCE);
    explanation = `Only untrusted evidence is available for requirement "${description}"; untrusted sources cannot satisfy requirements.`;
  } else {
    result = 'MISSING';
    primaryCodes.push(REASON_CODES.MISSING_EVIDENCE);
    explanation = `No valid evidence satisfies requirement "${description}".`;
  }

  const untrustedPresent = untrustedApplicable.length > 0 ? [REASON_CODES.UNTRUSTED_SOURCE] : [];
  const allReasonCodes = [...new Set([
    ...primaryCodes,
    ...untrustedPresent,
    ...evidence.flatMap((e) => e.applicabilityReasonCodes),
  ])];

  return {
    requirementId,
    checkKind,
    description,
    result,
    explanation,
    reasonCodes: allReasonCodes,
    evidence,
    supportingEvidenceIds: [...new Set(trustedPass.map((e) => e.id))],
    conflictingEvidenceIds: [...new Set(trustedFail.map((e) => e.id))],
  };
}

function aggregateStatus(requirements: RequirementEvaluation[]): {
  status: 'APPROVED' | 'NEEDS_REVIEW' | 'BLOCKED';
  reasonCodes: string[];
} {
  const primary: string[] = [];
  if (requirements.length === 0) {
    primary.push(REASON_CODES.EVALUATION_PENDING);
  } else if (requirements.some((r) => r.result === 'FAILING')) {
    primary.push(REASON_CODES.APPLICABLE_FAILURE);
  } else if (requirements.some((r) => r.result === 'CONFLICTING')) {
    primary.push(REASON_CODES.CONFLICTING_EVIDENCE);
  } else if (requirements.some((r) => r.result === 'NOT_EVALUATED')) {
    primary.push(REASON_CODES.EVALUATION_PENDING);
  } else if (requirements.some((r) => r.result === 'MISSING')) {
    primary.push(REASON_CODES.MISSING_EVIDENCE);
  } else {
    primary.push(REASON_CODES.ALL_REQUIREMENTS_SATISFIED);
  }

  let status: 'APPROVED' | 'NEEDS_REVIEW' | 'BLOCKED';
  if (primary[0] === REASON_CODES.ALL_REQUIREMENTS_SATISFIED) {
    status = 'APPROVED';
  } else if (primary[0] === REASON_CODES.APPLICABLE_FAILURE) {
    status = 'BLOCKED';
  } else {
    status = 'NEEDS_REVIEW';
  }

  const reasonCodes = [...new Set([...primary, ...requirements.flatMap((r) => r.reasonCodes)])];
  return { status, reasonCodes };
}

function buildIncompleteEvaluation(
  requirements: Array<{ id: string; checkKind: string; description: string }>,
  revisionId: string,
  revisionNumber: number,
  wsRevision: number,
  reason: string
): ReleaseEvaluation {
  const requirementEvaluations: RequirementEvaluation[] = requirements.map((req) => ({
    requirementId: req.id,
    checkKind: req.checkKind,
    description: req.description,
    result: 'NOT_EVALUATED',
    explanation: `Evaluation of requirement "${req.description}" is pending: ${reason}. No approval can be produced from an incomplete context.`,
    reasonCodes: [REASON_CODES.INCOMPLETE_CONTEXT],
    evidence: [],
    supportingEvidenceIds: [],
    conflictingEvidenceIds: [],
  }));
  return {
    releaseId: '',
    releaseName: '',
    revisionId,
    revisionNumber,
    status: 'NEEDS_REVIEW',
    reasonCodes: [REASON_CODES.INCOMPLETE_CONTEXT],
    evaluatedAt: nowISO(),
    evaluatedWorkspaceRevision: wsRevision,
    requirements: requirementEvaluations,
    supportedByEvidenceIds: [],
    evaluationIncomplete: true,
  };
}

async function fetchRevisionAndRequirements(
  revisionId: string
): Promise<{ revisionId: string; revisionNumber: number; requirements: Array<{ id: string; checkKind: string; description: string }> } | null> {
  const query = `
    MATCH (rev:ReleaseRevision {id: $revisionId, workspaceId: $wsId})
    OPTIONAL MATCH (rev)-[:REQUIRES]->(req:Requirement)
    RETURN rev.id as revisionId, rev.revisionNumber as revisionNumber,
           collect(DISTINCT {id: req.id, checkKind: req.checkKind, description: req.description}) as requirements
  `;
  const result = await runCypher(query, { revisionId, wsId: FIXED_WORKSPACE_ID });
  if (result.data.length === 0) return null;
  const row = result.data[0];
  return {
    revisionId: row.revisionId,
    revisionNumber: row.revisionNumber,
    requirements: (row.requirements || []).filter((r: any) => r.id),
  };
}

interface RawEvidenceRow {
  id: string;
  sourceId: string;
  outcome: 'PASS' | 'FAIL';
  observedAt: string;
  receivedAt: string;
  synthetic: boolean;
  contentSummary: string;
  withdrawnByEventId: string | null;
  supersededByEvidenceId: string | null;
  revisionId: string;
  requirementId: string;
  checkKind: string | null;
  sourceAuthority: string | null;
  sourceName: string | null;
}

async function fetchDirectEvidence(revisionId: string, limitPlusOne: number): Promise<{ rows: RawEvidenceRow[]; truncated: boolean }> {
  const query = `
    MATCH (rev:ReleaseRevision {id: $revisionId, workspaceId: $wsId})-[:REQUIRES]->(req:Requirement)
    MATCH (ev:Evidence)-[:SATISFIES_CHECK]->(req)
    MATCH (ev)-[:FOR_REVISION]->(rev)
    OPTIONAL MATCH (ev)-[:FROM_SOURCE]->(src:Source)
    RETURN ev.id as id,
           ev.sourceId as sourceId,
           ev.outcome as outcome,
           ev.observedAt as observedAt,
           ev.receivedAt as receivedAt,
           ev.synthetic as synthetic,
           ev.contentSummary as contentSummary,
           ev.withdrawnByEventId as withdrawnByEventId,
           ev.supersededByEvidenceId as supersededByEvidenceId,
           ev.revisionId as revisionId,
           src.authority as sourceAuthority,
           src.name as sourceName,
           req.id as requirementId,
           req.checkKind as checkKind
    LIMIT $limit
  `;
  const result = await runCypher(query, { revisionId, wsId: FIXED_WORKSPACE_ID, limit: limitPlusOne });
  const rows: RawEvidenceRow[] = result.data;
  return { rows, truncated: rows.length >= limitPlusOne };
}

async function fetchContextEvidence(
  revisionId: string,
  checkKinds: string[],
  limitPlusOne: number
): Promise<{ rows: RawEvidenceRow[]; truncated: boolean }> {
  if (checkKinds.length === 0) return { rows: [], truncated: false };
  const query = `
    MATCH (rev:ReleaseRevision {id: $revisionId, workspaceId: $wsId})<-[:HAS_REVISION]-(r:Release)-[:HAS_REVISION]->(otherRev:ReleaseRevision)
    MATCH (otherRev)-[:REQUIRES]->(otherReq:Requirement)
    WHERE otherReq.checkKind IN $checkKinds
    MATCH (ctxEv:Evidence)-[:SATISFIES_CHECK]->(otherReq)
    MATCH (ctxEv)-[:FOR_REVISION]->(otherRev)
    OPTIONAL MATCH (ctxEv)-[:FROM_SOURCE]->(src:Source)
    RETURN ctxEv.id as id,
           ctxEv.sourceId as sourceId,
           ctxEv.outcome as outcome,
           ctxEv.observedAt as observedAt,
           ctxEv.receivedAt as receivedAt,
           ctxEv.synthetic as synthetic,
           ctxEv.contentSummary as contentSummary,
           ctxEv.withdrawnByEventId as withdrawnByEventId,
           ctxEv.supersededByEvidenceId as supersededByEvidenceId,
           ctxEv.revisionId as revisionId,
           src.authority as sourceAuthority,
           src.name as sourceName,
           otherReq.id as requirementId,
           otherReq.checkKind as checkKind
    LIMIT $limit
  `;
  const result = await runCypher(query, { revisionId, wsId: FIXED_WORKSPACE_ID, checkKinds, limit: limitPlusOne });
  const rows: RawEvidenceRow[] = result.data;
  return { rows, truncated: rows.length >= limitPlusOne };
}

export async function evaluateReleaseRevision(revisionId: string): Promise<ReleaseEvaluation | null> {
  const revision = await fetchRevisionAndRequirements(revisionId);
  if (!revision) return null;

  const wsRevision = await getWorkspaceRevisionValue();
  const incompleteEvents = await countIncompleteEvents();
  const limit = evidenceLimit() + 1;

  let direct: { rows: RawEvidenceRow[]; truncated: boolean } = { rows: [], truncated: false };
  let context: { rows: RawEvidenceRow[]; truncated: boolean } = { rows: [], truncated: false };

  if (incompleteEvents === 0) {
    direct = await fetchDirectEvidence(revisionId, limit);
    context = await fetchContextEvidence(revisionId, revision.requirements.map((r) => r.checkKind), limit);
  }

  const truncated = direct.truncated || context.truncated;
  if (incompleteEvents > 0) {
    return buildIncompleteEvaluation(
      revision.requirements,
      revision.revisionId,
      revision.revisionNumber,
      wsRevision,
      `${incompleteEvents} event application(s) are pending or failed`
    );
  }
  if (truncated) {
    return buildIncompleteEvaluation(
      revision.requirements,
      revision.revisionId,
      revision.revisionNumber,
      wsRevision,
      `evidence retrieval exceeded the configured limit of ${evidenceLimit()}`
    );
  }

  const requirementEvaluations = revision.requirements.map((req) => {
    const raws = [
      ...direct.rows.filter((r) => r.requirementId === req.id),
      ...context.rows.filter((r) => r.checkKind === req.checkKind),
    ];
    const seen = new Set<string>();
    const evidence = raws
      .filter((r) => {
        if (seen.has(r.id)) return false;
        seen.add(r.id);
        return true;
      })
      .map((r) => buildEvaluatedEvidence(r, revision.revisionId, req.id));
    return evaluateRequirement(req.id, req.checkKind, req.description, evidence);
  });

  const { status, reasonCodes } = aggregateStatus(requirementEvaluations);
  const supportedByEvidenceIds = [
    ...new Set(requirementEvaluations.flatMap((r) => r.supportingEvidenceIds)),
  ];

  return {
    releaseId: '',
    releaseName: '',
    revisionId: revision.revisionId,
    revisionNumber: revision.revisionNumber,
    status,
    reasonCodes,
    evaluatedAt: nowISO(),
    evaluatedWorkspaceRevision: wsRevision,
    requirements: requirementEvaluations,
    supportedByEvidenceIds,
    evaluationIncomplete: false,
  };
}

export async function recordDecision(evaluation: ReleaseEvaluation, releaseId: string): Promise<string> {
  const decisionId = generateDecisionId();
  const now = nowISO();

  const prevResult = await runCypher(
    `MATCH (dec:Decision)-[:ASSESSES]->(rev:ReleaseRevision {id: $revisionId, workspaceId: $wsId})
     RETURN dec.id as id ORDER BY dec.evaluatedAt DESC LIMIT 1`,
    { revisionId: evaluation.revisionId, wsId: FIXED_WORKSPACE_ID }
  );
  const prevDecId: string | null = prevResult.data[0]?.id || null;

  const replacesClause = prevDecId
    ? `FOREACH (p IN [prevDec] | CREATE (dec)-[:REPLACES {id: 'rel_replaces_' + $decisionId + '_' + $prevDecId}]->(p))`
    : '';

  const query = `
    MATCH (rev:ReleaseRevision {id: $revisionId, workspaceId: $wsId})
    MATCH (rel:Release {id: $releaseId, workspaceId: $wsId})
    OPTIONAL MATCH (prevDec:Decision {id: $prevDecId})
    WITH rev, rel, prevDec
    OPTIONAL MATCH (ev:Evidence) WHERE ev.id IN $supportedIds
    WITH rev, rel, prevDec, collect(ev) as supportedEvs
    OPTIONAL MATCH (req:Requirement) WHERE req.id IN $requirementIds
    WITH rev, rel, prevDec, supportedEvs, collect(req) as evalReqs
    CREATE (dec:Decision {
      id: $decisionId, workspaceId: $wsId, status: $status, reasonCodes: $reasonCodes,
      evaluatedWorkspaceRevision: $evaluatedWorkspaceRevision, policyVersion: 'v1',
      evaluatedAt: $evaluatedAt, revisionId: rev.id, createdAt: $createdAt
    })
    CREATE (dec)-[:ASSESSES {id: 'rel_assesses_' + $decisionId + '_' + rev.id}]->(rev)
    FOREACH (e IN supportedEvs | CREATE (dec)-[:SUPPORTED_BY {id: 'rel_sup_' + $decisionId + '_' + e.id}]->(e))
    FOREACH (rq IN evalReqs | CREATE (dec)-[:EVALUATES {id: 'rel_eval_' + $decisionId + '_' + rq.id}]->(rq))
    ${replacesClause}
    SET rel.currentDecisionId = $decisionId
    RETURN dec.id as decisionId
  `;

  const result = await runCypher(query, {
    revisionId: evaluation.revisionId,
    releaseId,
    prevDecId,
    supportedIds: evaluation.evaluationIncomplete ? [] : evaluation.supportedByEvidenceIds,
    requirementIds: evaluation.requirements.map((r) => r.requirementId),
    decisionId,
    wsId: FIXED_WORKSPACE_ID,
    status: evaluation.status,
    reasonCodes: evaluation.reasonCodes,
    evaluatedWorkspaceRevision: evaluation.evaluatedWorkspaceRevision,
    evaluatedAt: evaluation.evaluatedAt,
    createdAt: now,
  });

  if (!result.data || result.data.length === 0) {
    throw new Error(`Decision write failed for release ${releaseId} revision ${evaluation.revisionId}`);
  }
  return decisionId;
}

export async function evaluateRelease(releaseId: string): Promise<ReleaseEvaluation | null> {
  const releaseQuery = `
    MATCH (r:Release {id: $releaseId, workspaceId: $wsId})-[:CURRENT_REVISION]->(rev:ReleaseRevision)
    RETURN r.name as name, rev.id as revisionId
  `;
  const result = await runCypher(releaseQuery, { releaseId, wsId: FIXED_WORKSPACE_ID });
  if (result.data.length === 0) return null;

  const name = result.data[0].name;
  const revisionId = result.data[0].revisionId;
  const evaluation = await evaluateReleaseRevision(revisionId);
  if (!evaluation) return null;

  evaluation.releaseId = releaseId;
  evaluation.releaseName = name;
  await recordDecision(evaluation, releaseId);
  return evaluation;
}

export async function evaluateAndRecordDecision(
  revisionId: string,
  releaseId: string,
  releaseName: string
): Promise<ReleaseEvaluation> {
  const evaluation = await evaluateReleaseRevision(revisionId);
  if (!evaluation) {
    throw new Error(`Revision ${revisionId} not found`);
  }
  evaluation.releaseId = releaseId;
  evaluation.releaseName = releaseName;
  await recordDecision(evaluation, releaseId);
  return evaluation;
}

export async function evaluateAllReleases(): Promise<ReleaseEvaluation[]> {
  const releasesQuery = `
    MATCH (r:Release {workspaceId: $wsId})-[:CURRENT_REVISION]->(rev:ReleaseRevision)
    RETURN r.id as releaseId, r.name as name, rev.id as revisionId
  `;
  const result = await runCypher(releasesQuery, { wsId: FIXED_WORKSPACE_ID });
  const evaluations: ReleaseEvaluation[] = [];
  for (const row of result.data) {
    const evaluation = await evaluateAndRecordDecision(row.revisionId, row.releaseId, row.name);
    evaluations.push(evaluation);
  }
  return evaluations;
}

export async function evaluateReleaseRevisionReadOnly(revisionId: string): Promise<ReleaseEvaluation | null> {
  return evaluateReleaseRevision(revisionId);
}
