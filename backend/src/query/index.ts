import { runCypher } from '../graph/client';
import { FIXED_WORKSPACE_ID } from '../seed/fixtures';
import { countIncompleteEvents } from '../evaluation/policy';

export interface ReleaseSummary {
  id: string;
  name: string;
  currentRevisionId: string;
  currentRevisionNumber: number | null;
  status: string;
  evaluationPending: boolean;
  latestDecisionId: string | null;
}

export interface RevisionContext {
  revisionId: string;
  revisionNumber: number;
  dependencies: Array<{ id: string; dependencyName: string; version: string }>;
  requirements: Array<{ id: string; checkKind: string; description: string }>;
  evidence: Array<{
    id: string;
    sourceId: string;
    outcome: string;
    observedAt: string;
    receivedAt: string;
    synthetic: boolean;
    contentSummary: string;
    withdrawnByEventId: string | null;
    supersededByEvidenceId: string | null;
    applicabilityReasonCodes: string[];
    requirementId: string;
    sourceAuthority: 'allowlisted' | 'untrusted';
    sourceName: string;
  }>;
  currentDecision: {
    id: string;
    status: string;
    reasonCodes: string[];
    evaluatedAt: string;
    supportedByEvidenceIds: string[];
  } | null;
}

export interface ImpactPath {
  entityId: string;
  entityType: string;
  affectedReleases: Array<{ releaseId: string; releaseName: string; revisionId: string }>;
  paths: Array<{ nodes: string[]; edges: string[] }>;
  truncated: boolean;
}

export interface DecisionHistoryEntry {
  decisionId: string;
  status: string;
  reasonCodes: string[];
  evaluatedAt: string;
  evaluatedWorkspaceRevision: number;
  policyVersion?: string;
  supportedByEvidenceIds: string[];
  replacesDecisionId: string | null;
}

export async function getReleaseSummaries(): Promise<ReleaseSummary[]> {
  const incompleteEvents = await countIncompleteEvents();

  const query = `
    MATCH (r:Release {workspaceId: $wsId})
    OPTIONAL MATCH (r)-[:CURRENT_REVISION]->(cur:ReleaseRevision)
    OPTIONAL MATCH (ptrDec:Decision {id: r.currentDecisionId})
    RETURN r.id as id, r.name as name, r.currentRevisionId as currentRevisionId,
           cur.revisionNumber as currentRevisionNumber,
           ptrDec.id as decisionId, ptrDec.status as status, ptrDec.revisionId as decisionRevisionId
  `;
  const result = await runCypher(query, { wsId: FIXED_WORKSPACE_ID });

  return result.data.map((row: any) => {
    const pointerFresh = Boolean(row.decisionId) && row.decisionRevisionId === row.currentRevisionId;
    const evaluationPending = !pointerFresh || incompleteEvents > 0;
    let status = row.status || 'NEEDS_REVIEW';
    if (incompleteEvents > 0) {
      status = 'NEEDS_REVIEW';
    }
    return {
      id: row.id,
      name: row.name,
      currentRevisionId: row.currentRevisionId,
      currentRevisionNumber: row.currentRevisionNumber ?? null,
      status,
      evaluationPending,
      latestDecisionId: row.decisionId ?? null,
    };
  });
}

export async function getRevisionContext(revisionId: string): Promise<RevisionContext | null> {
  const pointerRows = await runCypher(
    `MATCH (rev:ReleaseRevision {id: $revisionId, workspaceId: $wsId})<-[:HAS_REVISION]-(r:Release)
     RETURN r.currentRevisionId as currentRevisionId, r.currentDecisionId as currentDecisionId`,
    { revisionId, wsId: FIXED_WORKSPACE_ID }
  );

  let decisionId: string | null = null;
  if (pointerRows.data.length > 0) {
    const row = pointerRows.data[0];
    if (row.currentRevisionId === revisionId) {
      decisionId = row.currentDecisionId ?? null;
    } else {
      const latest = await runCypher(
        `MATCH (dec:Decision)-[:ASSESSES]->(rev:ReleaseRevision {id: $revisionId, workspaceId: $wsId})
         RETURN dec.id as id ORDER BY dec.evaluatedAt DESC LIMIT 1`,
        { revisionId, wsId: FIXED_WORKSPACE_ID }
      );
      decisionId = latest.data[0]?.id || null;
    }
  }

  const query = `
    MATCH (rev:ReleaseRevision {id: $revisionId, workspaceId: $wsId})
    OPTIONAL MATCH (rev)-[:DEPENDS_ON]->(dep:DependencyVersion)
    OPTIONAL MATCH (rev)-[:REQUIRES]->(req:Requirement)
    OPTIONAL MATCH (req)<-[:SATISFIES_CHECK]-(ev:Evidence)-[:FOR_REVISION]->(rev)
    OPTIONAL MATCH (ev)-[:FROM_SOURCE]->(src:Source)
    OPTIONAL MATCH (dec:Decision {id: $decisionId})
    OPTIONAL MATCH (dec)-[:SUPPORTED_BY]->(supEv:Evidence)
    RETURN rev.id as revisionId, rev.revisionNumber as revisionNumber,
           collect(DISTINCT {id: dep.id, dependencyName: dep.dependencyName, version: dep.version}) as dependencies,
           collect(DISTINCT {id: req.id, checkKind: req.checkKind, description: req.description}) as requirements,
           collect(DISTINCT {
             id: ev.id,
             sourceId: ev.sourceId,
             outcome: ev.outcome,
             observedAt: ev.observedAt,
             receivedAt: ev.receivedAt,
             synthetic: ev.synthetic,
             contentSummary: ev.contentSummary,
             withdrawnByEventId: ev.withdrawnByEventId,
              supersededByEvidenceId: ev.supersededByEvidenceId,
              applicabilityReasonCodes: CASE
                WHEN ev.withdrawnByEventId IS NOT NULL THEN ['EVIDENCE_WITHDRAWN']
                WHEN ev.supersededByEvidenceId IS NOT NULL THEN ['EVIDENCE_SUPERSEDED']
               WHEN ev.revisionId <> rev.id THEN ['REVISION_MISMATCH']
               ELSE []
             END,
             requirementId: req.id,
             sourceAuthority: src.authority,
             sourceName: src.name
           }) as evidence,
           collect(DISTINCT {
             id: dec.id,
             status: dec.status,
             reasonCodes: dec.reasonCodes,
             evaluatedAt: dec.evaluatedAt
           }) as decisions,
           collect(DISTINCT supEv.id) as supportedByEvidenceIds
  `;
  const result = await runCypher(query, { revisionId, wsId: FIXED_WORKSPACE_ID, decisionId });
  if (result.data.length === 0) return null;

  const row = result.data[0];
  const decision = row.decisions.filter((d: any) => d.id)[0] || null;
  return {
    revisionId: row.revisionId,
    revisionNumber: row.revisionNumber,
    dependencies: row.dependencies.filter((d: any) => d.id),
    requirements: row.requirements.filter((r: any) => r.id),
    evidence: row.evidence.filter((e: any) => e.id).map((e: any) => ({
      ...e,
      supersededByEvidenceId: e.supersededByEvidenceId || null,
      sourceAuthority: e.sourceAuthority || 'untrusted',
      sourceName: e.sourceName || '',
    })),
    currentDecision: decision
      ? {
          ...decision,
          supportedByEvidenceIds: row.supportedByEvidenceIds.filter((id: any) => id),
        }
      : null,
  };
}

export async function getDecisionHistory(releaseId: string): Promise<DecisionHistoryEntry[]> {
  const query = `
    MATCH (r:Release {id: $releaseId, workspaceId: $wsId})-[:HAS_REVISION]->(rev:ReleaseRevision)
    OPTIONAL MATCH (dec:Decision)-[:ASSESSES]->(rev)
    OPTIONAL MATCH (dec)-[:SUPPORTED_BY]->(ev:Evidence)
    OPTIONAL MATCH (dec)-[:REPLACES]->(prevDec:Decision)
    WITH dec, collect(DISTINCT ev.id) as supportedByEvidenceIds, prevDec
    WHERE dec IS NOT NULL
    RETURN dec.id as decisionId, dec.status as status, dec.reasonCodes as reasonCodes,
           dec.evaluatedAt as evaluatedAt, dec.evaluatedWorkspaceRevision as evaluatedWorkspaceRevision,
           dec.policyVersion as policyVersion,
           supportedByEvidenceIds,
           prevDec.id as replacesDecisionId
    ORDER BY dec.evaluatedAt DESC
  `;
  const result = await runCypher(query, { releaseId, wsId: FIXED_WORKSPACE_ID });
  return result.data.map((row: any) => ({
    decisionId: row.decisionId,
    status: row.status,
    reasonCodes: row.reasonCodes,
    evaluatedAt: row.evaluatedAt,
    evaluatedWorkspaceRevision: row.evaluatedWorkspaceRevision,
    policyVersion: row.policyVersion ?? undefined,
    supportedByEvidenceIds: row.supportedByEvidenceIds.filter((id: any) => id),
    replacesDecisionId: row.replacesDecisionId,
  }));
}

export async function findAffectedReleases(entityId: string): Promise<ImpactPath> {
  const query = `
    MATCH (entity {id: $entityId})
    WHERE entity.workspaceId = $wsId
    OPTIONAL MATCH (entity)<-[:DEPENDS_ON]-(depRev:ReleaseRevision {workspaceId: $wsId})
    OPTIONAL MATCH (depRev)<-[:CURRENT_REVISION]-(depRel:Release)
    OPTIONAL MATCH (entity)<-[:FOR_VERSION]-(depReq:Requirement)<-[:REQUIRES]-(reqRev:ReleaseRevision {workspaceId: $wsId})
    OPTIONAL MATCH (reqRev)<-[:CURRENT_REVISION]-(reqRel:Release)
    OPTIONAL MATCH (entity)<-[:SATISFIES_CHECK]-(satEv:Evidence)-[:FOR_REVISION]-(satRev:ReleaseRevision {workspaceId: $wsId})
    OPTIONAL MATCH (satRev)<-[:CURRENT_REVISION]-(satRel:Release)
    OPTIONAL MATCH (entity)<-[:FROM_SOURCE]-(srcEv:Evidence)-[:FOR_REVISION]-(srcRev:ReleaseRevision {workspaceId: $wsId})
    OPTIONAL MATCH (srcRev)<-[:CURRENT_REVISION]-(srcRel:Release)
    OPTIONAL MATCH (entity)<-[:REQUIRES]-(rqRev:ReleaseRevision {workspaceId: $wsId})
    OPTIONAL MATCH (rqRev)<-[:CURRENT_REVISION]-(rqRel:Release)
    RETURN entity,
           labels(entity) as labels,
           collect(DISTINCT {releaseId: depRel.id, releaseName: depRel.name, revisionId: depRev.id}) +
           collect(DISTINCT {releaseId: reqRel.id, releaseName: reqRel.name, revisionId: reqRev.id}) +
           collect(DISTINCT {releaseId: satRel.id, releaseName: satRel.name, revisionId: satRev.id}) +
           collect(DISTINCT {releaseId: srcRel.id, releaseName: srcRel.name, revisionId: srcRev.id}) +
           collect(DISTINCT {releaseId: rqRel.id, releaseName: rqRel.name, revisionId: rqRev.id}) as affectedReleases
  `;
  const result = await runCypher(query, { entityId, wsId: FIXED_WORKSPACE_ID });
  if (result.data.length === 0) {
    return { entityId, entityType: 'unknown', affectedReleases: [], paths: [], truncated: false };
  }
  const row = result.data[0];
  const seen = new Set<string>();
  const affectedReleases = (row.affectedReleases || [])
    .filter((r: any) => r && r.releaseId)
    .filter((r: any) => {
      const key = `${r.releaseId}:${r.revisionId}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  return {
    entityId,
    entityType: row.labels?.[0] || 'unknown',
    affectedReleases,
    paths: [],
    truncated: false,
  };
}

export async function getGraphView(
  revisionId: string,
  scope: 'CURRENT' | 'HISTORY' = 'CURRENT'
): Promise<{ nodes: any[]; edges: any[]; truncated: boolean }> {
  const nodeLimit = 100;
  const edgeLimit = 200;

  let query: string;
  if (scope === 'CURRENT') {
    query = `
      MATCH (rev:ReleaseRevision {id: $revisionId, workspaceId: $wsId})
      OPTIONAL MATCH (rev)-[:DEPENDS_ON]->(dep:DependencyVersion)
      OPTIONAL MATCH (rev)-[:REQUIRES]->(req:Requirement)
      OPTIONAL MATCH (req)<-[:SATISFIES_CHECK]-(ev:Evidence)-[:FOR_REVISION]->(rev)
      OPTIONAL MATCH (ev)-[:FROM_SOURCE]->(src:Source)
      OPTIONAL MATCH (rev)<-[:ASSESSES]-(dec:Decision)
      OPTIONAL MATCH (dec)-[:SUPPORTED_BY]->(supEv:Evidence)
      OPTIONAL MATCH (dec)-[:EVALUATES]->(evalReq:Requirement)
      RETURN collect(DISTINCT rev) + collect(DISTINCT dep) + collect(DISTINCT req) + collect(DISTINCT ev) + collect(DISTINCT src) + collect(DISTINCT dec) + collect(DISTINCT evalReq) as nodes
    `;
  } else {
    query = `
      MATCH (r:Release {workspaceId: $wsId})-[:HAS_REVISION]->(rev:ReleaseRevision)
      OPTIONAL MATCH (rev)<-[:ASSESSES]-(dec:Decision)
      OPTIONAL MATCH (dec)-[:SUPPORTED_BY]->(ev:Evidence)
      OPTIONAL MATCH (dec)-[:REPLACES]->(prevDec:Decision)
      RETURN collect(DISTINCT rev) + collect(DISTINCT dec) + collect(DISTINCT ev) + collect(DISTINCT prevDec) as nodes
    `;
  }

  const result = await runCypher(query, { revisionId, wsId: FIXED_WORKSPACE_ID });
  const nodes = result.data[0]?.nodes || [];
  const flatNodes = nodes.flat();

  const edgeQuery = `
    MATCH (a)-[r]->(b)
    WHERE a.workspaceId = $wsId AND b.workspaceId = $wsId
    RETURN a.id as source, b.id as target, type(r) as type, r.id as id, properties(r) as props
    LIMIT $limit
  `;
  const edgeResult = await runCypher(edgeQuery, { wsId: FIXED_WORKSPACE_ID, limit: edgeLimit });

  return {
    nodes: flatNodes.slice(0, nodeLimit).map((n: any) => ({
      id: n.properties?.id || n.id,
      type: n.labels?.[0] || 'Unknown',
      label: n.properties?.name || n.properties?.id || n.id,
      domainStatus: n.properties?.status || n.properties?.outcome || null,
      sourceRecordId: n.properties?.id || null,
    })),
    edges: edgeResult.data.map((e: any) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      type: e.type,
      historical: false,
    })),
    truncated: flatNodes.length > nodeLimit || edgeResult.data.length >= edgeLimit,
  };
}
