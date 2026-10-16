import { runCypher } from '../graph/client';
import { FIXED_WORKSPACE_ID } from '../seed/fixtures';
import {
  generateEventId,
  generateRevisionId,
  generateRequirementId,
  generateEvidenceId,
  generateDecisionId,
  generateTaskId,
  nowISO,
} from '../domain/ids';
import { evaluateReleaseRevision } from '../evaluation/policy';

const mutationQueue: Array<() => Promise<any>> = [];
let isProcessing = false;

async function processQueue(): Promise<void> {
  if (isProcessing || mutationQueue.length === 0) return;
  isProcessing = true;
  while (mutationQueue.length > 0) {
    const task = mutationQueue.shift();
    if (task) await task();
  }
  isProcessing = false;
}

export function enqueueMutation<T>(task: () => Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    mutationQueue.push(async () => {
      try {
        const result = await task();
        resolve(result);
      } catch (error) {
        reject(error);
      }
    });
    processQueue();
  });
}

export async function getWorkspaceRevision(): Promise<number> {
  const result = await runCypher(`MATCH (w:Workspace {id: $wsId}) RETURN w.revision as revision`, { wsId: FIXED_WORKSPACE_ID });
  return result.data[0]?.revision || 0;
}

export async function checkExpectedRevision(expectedRevision: number): Promise<{ valid: boolean; currentRevision: number }> {
  const currentRevision = await getWorkspaceRevision();
  return { valid: currentRevision === expectedRevision, currentRevision };
}

function stableStringify(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(obj[k])).join(',') + '}';
}

interface StoredEvent {
  id: string;
  state: string;
  payloadHash: string | null;
  appliedWorkspaceRevision: number | null;
  affectedReleases: string[] | null;
  decisionId: string | null;
}

async function readEventByKey(key: string): Promise<StoredEvent | null> {
  const query = `
    MATCH (e:Event {idempotencyKey: $key, workspaceId: $wsId})
    RETURN e.id as id, e.applicationState as state, e.payloadHash as payloadHash,
           e.appliedWorkspaceRevision as appliedWorkspaceRevision,
           e.affectedReleases as affectedReleases,
           e.decisionId as decisionId
  `;
  const result = await runCypher(query, { key, wsId: FIXED_WORKSPACE_ID });
  if (result.data.length === 0) return null;
  const row = result.data[0];
  return {
    id: row.id,
    state: row.state,
    payloadHash: row.payloadHash ?? null,
    appliedWorkspaceRevision: row.appliedWorkspaceRevision ?? null,
    affectedReleases: row.affectedReleases ?? null,
    decisionId: row.decisionId ?? null,
  };
}

function fastPathResult(existing: StoredEvent): { eventId: string; newWorkspaceRevision: number; affectedReleases: string[] } {
  return {
    eventId: existing.id,
    newWorkspaceRevision: existing.appliedWorkspaceRevision ?? 0,
    affectedReleases: existing.affectedReleases ?? [],
  };
}

async function resolveIdempotencyFastPath(key: string, payloadHash: string): Promise<
  { hit: true; result: { eventId: string; newWorkspaceRevision: number; affectedReleases: string[] } } | { hit: false }
> {
  const existing = await readEventByKey(key);
  if (!existing) return { hit: false };
  if (existing.state === 'PENDING' || existing.state === 'FAILED') {
    throw new Error(`INCOMPLETE_PRIOR_ATTEMPT: idempotency key ${key} was left in state ${existing.state}; recovery required before reuse`);
  }
  if (existing.payloadHash && existing.payloadHash !== payloadHash) {
    throw new Error('DUPLICATE_KEY_CONFLICT: Same idempotency key with different payload');
  }
  const result = fastPathResult(existing);
  if (result.newWorkspaceRevision === 0) {
    result.newWorkspaceRevision = await getWorkspaceRevision();
  }
  return { hit: true, result };
}

export async function checkIdempotencyKey(key: string, payloadHash?: string): Promise<{ exists: boolean; result?: any; conflict?: boolean }> {
  const query = `MATCH (e:Event {idempotencyKey: $key, workspaceId: $wsId}) RETURN e.applicationState as state, e.id as eventId, e.payloadHash as payloadHash`;
  const result = await runCypher(query, { key, wsId: FIXED_WORKSPACE_ID });
  if (result.data.length === 0) return { exists: false };
  const event = result.data[0];
  const conflict = event.state === 'CONFLICT' || (Boolean(payloadHash) && Boolean(event.payloadHash) && event.payloadHash !== payloadHash);
  return {
    exists: true,
    conflict,
    result: { eventId: event.eventId, state: event.state },
  };
}

export async function recordIdempotencyKey(key: string, eventId: string, state: string, payloadHash?: string): Promise<void> {
  const query = `
    MERGE (e:Event {idempotencyKey: $key, workspaceId: $wsId})
    ON CREATE SET e.id = $eventId, e.applicationState = $state, e.payloadHash = $payloadHash
    ON MATCH SET e.applicationState = $state, e.payloadHash = $payloadHash
  `;
  await runCypher(query, { key, eventId, state, payloadHash: payloadHash ?? null, wsId: FIXED_WORKSPACE_ID });
}

export async function advanceWorkspaceRevision(): Promise<number> {
  const query = `
    MATCH (w:Workspace {id: $wsId})
    SET w.revision = w.revision + 1
    RETURN w.revision as revision
  `;
  const result = await runCypher(query, { wsId: FIXED_WORKSPACE_ID });
  return result.data[0]?.revision || 1;
}

export interface DependencyChangedEvent {
  type: 'DEPENDENCY_CHANGED';
  releaseId: string;
  dependencyName: string;
  newVersion: string;
}

export interface TestRecordedEvent {
  type: 'TEST_RECORDED';
  revisionId: string;
  requirementId: string;
  sourceId: string;
  outcome: 'PASS' | 'FAIL';
  observedAt: string;
  summary: string;
}

export interface EvidenceWithdrawnEvent {
  type: 'EVIDENCE_WITHDRAWN';
  evidenceId: string;
  sourceId: string;
  reason: string;
}

export interface EvidenceSupersededEvent {
  type: 'EVIDENCE_SUPERSEDED';
  oldEvidenceId: string;
  replacement: {
    revisionId: string;
    requirementId: string;
    sourceId: string;
    outcome: 'PASS' | 'FAIL';
    observedAt: string;
    summary: string;
  };
}

export type DomainEvent = DependencyChangedEvent | TestRecordedEvent | EvidenceWithdrawnEvent | EvidenceSupersededEvent;

const applyGuard = `
  MATCH (w:Workspace {id: $wsId})
  OPTIONAL MATCH (existing:Event {idempotencyKey: $key, workspaceId: $wsId})
  WITH w, existing
  WHERE existing IS NULL AND w.revision = $expectedRevision
`;

interface ApplyPlan {
  query: string;
  params: Record<string, any>;
  affectedReleases: string[];
}

interface EventPropParams {
  eventId: string;
  key: string;
  payloadHash: string;
  now: string;
  expectedRevision: number;
  affectedReleases: string[];
  revisionId: string;
  evidenceId?: string;
  decisionId?: string;
}

function eventCreateClause(p: EventPropParams): string {
  return `
    CREATE (evt:Event {
      id: $eventId, workspaceId: $wsId, type: $eventType, eventType: $eventType,
      idempotencyKey: $key, receivedAt: $now, payloadHash: $payloadHash,
      applicationState: 'APPLIED', createdAt: $now,
      appliedWorkspaceRevision: $expectedRevision + 1,
      affectedReleases: $affectedReleases,
      revisionId: $revisionId,
      evidenceId: $evidenceId,
      decisionId: $decisionId
    })
  `;
}

function eventParams(p: EventPropParams, eventType: string): Record<string, any> {
  return {
    eventId: p.eventId,
    key: p.key,
    payloadHash: p.payloadHash,
    now: p.now,
    expectedRevision: p.expectedRevision,
    affectedReleases: p.affectedReleases,
    revisionId: p.revisionId,
    evidenceId: p.evidenceId ?? null,
    decisionId: p.decisionId ?? null,
    eventType,
    wsId: FIXED_WORKSPACE_ID,
  };
}

async function owningReleasesForRevision(revisionId: string): Promise<string[]> {
  const result = await runCypher(
    `MATCH (rev:ReleaseRevision {id: $revisionId, workspaceId: $wsId})<-[:HAS_REVISION]-(r:Release) RETURN DISTINCT r.id as releaseId`,
    { revisionId, wsId: FIXED_WORKSPACE_ID }
  );
  return result.data.map((row: any) => row.releaseId).filter(Boolean);
}

async function planDependencyChanged(
  event: DependencyChangedEvent,
  eventId: string,
  key: string,
  payloadHash: string,
  now: string,
  expectedRevision: number
): Promise<ApplyPlan> {
  const releaseResult = await runCypher(
    `MATCH (r:Release {id: $releaseId, workspaceId: $wsId}) RETURN r.id as id, r.currentRevisionId as currentRevisionId, r.name as name`,
    { releaseId: event.releaseId, wsId: FIXED_WORKSPACE_ID }
  );
  if (releaseResult.data.length === 0) throw new Error('VALIDATION_ERROR: Release not found');
  const currentRevId = releaseResult.data[0].currentRevisionId;

  const currentRevResult = await runCypher(
    `MATCH (rev:ReleaseRevision {id: $revId, workspaceId: $wsId}) RETURN rev.id as id, rev.revisionNumber as revisionNumber`,
    { revId: currentRevId, wsId: FIXED_WORKSPACE_ID }
  );
  if (currentRevResult.data.length === 0) throw new Error('VALIDATION_ERROR: Current revision not found');
  const newRevisionNumber = currentRevResult.data[0].revisionNumber + 1;

  const reqResult = await runCypher(
    `MATCH (oldRev:ReleaseRevision {id: $oldRevId, workspaceId: $wsId})-[:REQUIRES]->(req:Requirement)
     RETURN req.id as id, req.checkKind as checkKind, req.description as description`,
    { oldRevId: currentRevId, wsId: FIXED_WORKSPACE_ID }
  );
  // Version-neutral rewrite: descriptions that pin the old dependency version
  // must not carry that version onto the new revision. Exact version is shown
  // separately on the revision's dependency list.
  const stripDependencyVersion = (description: string): string => {
    if (!description) return description;
    const esc = event.dependencyName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return description
      .replace(new RegExp(`${esc}\\s+v?\\d+(?:\\.\\d+)*`, 'gi'), event.dependencyName)
      .replace(new RegExp(`${esc}\\s+at\\s+v?\\d+(?:\\.\\d+)*`, 'gi'), event.dependencyName);
  };
  const newReqs = reqResult.data.map((row: any) => ({
    id: generateRequirementId(),
    checkKind: row.checkKind,
    description: stripDependencyVersion(row.description),
  }));

  const newRevId = generateRevisionId();
  const newDepId = `dep_${event.dependencyName.replace(/[^a-zA-Z0-9]+/g, '_')}_${event.newVersion.replace(/\./g, '_')}`;
  const affectedReleases = [event.releaseId];

  const query = `
    ${applyGuard}
    MATCH (rel:Release {id: $releaseId, workspaceId: $wsId})-[oldCur:CURRENT_REVISION]->(oldRev:ReleaseRevision {id: $oldRevId})
    MERGE (dep:DependencyVersion {id: $newDepId, workspaceId: $wsId})
    ON CREATE SET dep.dependencyName = $dependencyName, dep.version = $newVersion, dep.createdAt = $now
    CREATE (newRev:ReleaseRevision {
      id: $newRevId, workspaceId: $wsId, releaseId: $releaseId,
      revisionNumber: $newRevisionNumber, policyVersion: 'v1', createdAt: $now
    })
    CREATE (newRev)-[:DEPENDS_ON {id: 'rel_dep_' + $newRevId + '_' + $newDepId}]->(dep)
    FOREACH (req IN $newReqs |
      CREATE (newRev)-[:REQUIRES {id: 'rel_req_' + $newRevId + '_' + req.id}]->(nr:Requirement {
        id: req.id, workspaceId: $wsId, revisionId: $newRevId,
        checkKind: req.checkKind, description: req.description, createdAt: $now
      })-[:FOR_VERSION {id: 'rel_fv_' + req.id + '_' + $newDepId}]->(dep)
    )
    DELETE oldCur
    CREATE (rel)-[:CURRENT_REVISION {id: 'rel_cur_' + $newRevId}]->(newRev)
    CREATE (rel)-[:HAS_REVISION {id: 'rel_has_' + $newRevId}]->(newRev)
    CREATE (w)-[:HAS_REVISION {id: 'rel_ws_has_' + $newRevId}]->(newRev)
    SET rel.currentRevisionId = $newRevId
    SET rel.currentDecisionId = null
    ${eventCreateClause({
      eventId,
      key,
      payloadHash,
      now,
      expectedRevision,
      affectedReleases,
      revisionId: currentRevId,
    })}
    CREATE (evt)-[:CHANGES {id: 'rel_chg_' + $eventId + '_' + $oldRevId}]->(oldRev)
    SET w.revision = w.revision + 1
    RETURN w.revision as newRevision
  `;

  return {
    query,
    params: {
      ...eventParams(
        {
          eventId,
          key,
          payloadHash,
          now,
          expectedRevision,
          affectedReleases,
          revisionId: currentRevId,
        },
        event.type
      ),
      releaseId: event.releaseId,
      oldRevId: currentRevId,
      newRevId,
      newDepId,
      newRevisionNumber,
      dependencyName: event.dependencyName,
      newVersion: event.newVersion,
      newReqs,
    },
    affectedReleases,
  };
}

async function planTestRecorded(
  event: TestRecordedEvent,
  eventId: string,
  key: string,
  payloadHash: string,
  now: string,
  expectedRevision: number
): Promise<ApplyPlan> {
  const reqCheck = await runCypher(
    `MATCH (rev:ReleaseRevision {id: $revisionId, workspaceId: $wsId})-[:REQUIRES]->(req:Requirement {id: $requirementId, workspaceId: $wsId})
     RETURN req.id as id`,
    { revisionId: event.revisionId, requirementId: event.requirementId, wsId: FIXED_WORKSPACE_ID }
  );
  if (reqCheck.data.length === 0) throw new Error('VALIDATION_ERROR: Requirement is not required by the given revision');

  const sourceCheck = await runCypher(
    `MATCH (src:Source {id: $sourceId, workspaceId: $wsId}) RETURN src.id as id`,
    { sourceId: event.sourceId, wsId: FIXED_WORKSPACE_ID }
  );
  if (sourceCheck.data.length === 0) throw new Error('VALIDATION_ERROR: Source not found');

  const revCheck = await runCypher(
    `MATCH (rev:ReleaseRevision {id: $revisionId, workspaceId: $wsId}) RETURN rev.id as id`,
    { revisionId: event.revisionId, wsId: FIXED_WORKSPACE_ID }
  );
  if (revCheck.data.length === 0) throw new Error('VALIDATION_ERROR: Revision not found');

  const evId = generateEvidenceId();
  const affectedReleases = await owningReleasesForRevision(event.revisionId);

  const query = `
    ${applyGuard}
    MATCH (rev:ReleaseRevision {id: $revisionId, workspaceId: $wsId})
    MATCH (req:Requirement {id: $requirementId, workspaceId: $wsId})
    MATCH (src:Source {id: $sourceId, workspaceId: $wsId})
    OPTIONAL MATCH (ar:Release) WHERE ar.id IN $affectedReleases
    WITH w, rev, req, src, collect(ar) as affectedNodes
    CREATE (ev:Evidence {
      id: $evId, workspaceId: $wsId, sourceId: $sourceId, outcome: $outcome,
      observedAt: $observedAt, receivedAt: $now, synthetic: true,
      contentSummary: $summary, revisionId: $revisionId, createdAt: $now
    })
    CREATE (ev)-[:SATISFIES_CHECK {id: 'rel_sat_' + $evId + '_' + $requirementId}]->(req)
    CREATE (ev)-[:FROM_SOURCE {id: 'rel_src_' + $evId + '_' + $sourceId}]->(src)
    CREATE (ev)-[:FOR_REVISION {id: 'rel_rev_' + $evId + '_' + $revisionId}]->(rev)
    FOREACH (a IN affectedNodes | SET a.currentDecisionId = null)
    ${eventCreateClause({
      eventId,
      key,
      payloadHash,
      now,
      expectedRevision,
      affectedReleases,
      revisionId: event.revisionId,
      evidenceId: evId,
    })}
    CREATE (evt)-[:CHANGES {id: 'rel_chg_' + $eventId + '_' + $evId}]->(ev)
    SET w.revision = w.revision + 1
    RETURN w.revision as newRevision
  `;

  return {
    query,
    params: {
      ...eventParams(
        {
          eventId,
          key,
          payloadHash,
          now,
          expectedRevision,
          affectedReleases,
          revisionId: event.revisionId,
          evidenceId: evId,
        },
        event.type
      ),
      revisionId: event.revisionId,
      requirementId: event.requirementId,
      sourceId: event.sourceId,
      outcome: event.outcome,
      observedAt: event.observedAt,
      summary: event.summary,
      evId,
    },
    affectedReleases,
  };
}

async function planEvidenceWithdrawn(
  event: EvidenceWithdrawnEvent,
  eventId: string,
  key: string,
  payloadHash: string,
  now: string,
  expectedRevision: number
): Promise<ApplyPlan> {
  const evResult = await runCypher(
    `MATCH (ev:Evidence {id: $evidenceId, workspaceId: $wsId})
     RETURN ev.id as id, ev.sourceId as sourceId, ev.withdrawnByEventId as withdrawnByEventId, ev.revisionId as revisionId`,
    { evidenceId: event.evidenceId, wsId: FIXED_WORKSPACE_ID }
  );
  if (evResult.data.length === 0) throw new Error('VALIDATION_ERROR: Evidence not found');
  const evidence = evResult.data[0];
  if (evidence.withdrawnByEventId) throw new Error('VALIDATION_ERROR: Evidence already withdrawn');
  if (evidence.sourceId !== event.sourceId) {
    throw new Error('VALIDATION_ERROR: Withdrawal source does not match the evidence source');
  }

  const sourceResult = await runCypher(
    `MATCH (src:Source {id: $sourceId, workspaceId: $wsId}) RETURN src.authority as authority`,
    { sourceId: event.sourceId, wsId: FIXED_WORKSPACE_ID }
  );
  if (sourceResult.data.length === 0) throw new Error('VALIDATION_ERROR: Source not found');
  if (sourceResult.data[0].authority !== 'allowlisted') {
    throw new Error('VALIDATION_ERROR: Only allowlisted sources may withdraw evidence');
  }

  const affectedReleases = await owningReleasesForRevision(evidence.revisionId);

  const query = `
    ${applyGuard}
    MATCH (ev:Evidence {id: $evidenceId, workspaceId: $wsId})
    OPTIONAL MATCH (ar:Release) WHERE ar.id IN $affectedReleases
    WITH w, ev, collect(ar) as affectedNodes
    SET ev.withdrawnByEventId = $eventId
    FOREACH (a IN affectedNodes | SET a.currentDecisionId = null)
    ${eventCreateClause({
      eventId,
      key,
      payloadHash,
      now,
      expectedRevision,
      affectedReleases,
      revisionId: evidence.revisionId,
      evidenceId: event.evidenceId,
    })}
    CREATE (evt)-[:WITHDRAWS {id: 'rel_wd_' + $eventId + '_' + $evidenceId}]->(ev)
    SET w.revision = w.revision + 1
    RETURN w.revision as newRevision
  `;

  return {
    query,
    params: {
      ...eventParams(
        {
          eventId,
          key,
          payloadHash,
          now,
          expectedRevision,
          affectedReleases,
          revisionId: evidence.revisionId,
          evidenceId: event.evidenceId,
        },
        event.type
      ),
      evidenceId: event.evidenceId,
      reason: event.reason,
    },
    affectedReleases,
  };
}

async function planEvidenceSuperseded(
  event: EvidenceSupersededEvent,
  eventId: string,
  key: string,
  payloadHash: string,
  now: string,
  expectedRevision: number
): Promise<ApplyPlan> {
  const oldResult = await runCypher(
    `MATCH (ev:Evidence {id: $oldEvidenceId, workspaceId: $wsId})
     OPTIONAL MATCH (ev)-[:SATISFIES_CHECK]->(oldReq:Requirement)
     RETURN ev.id as id, ev.revisionId as revisionId, ev.supersededByEvidenceId as supersededByEvidenceId, oldReq.id as requirementId`,
    { oldEvidenceId: event.oldEvidenceId, wsId: FIXED_WORKSPACE_ID }
  );
  if (oldResult.data.length === 0) throw new Error('VALIDATION_ERROR: Old evidence not found');
  const oldEv = oldResult.data[0];
  if (oldEv.supersededByEvidenceId) throw new Error('VALIDATION_ERROR: Evidence already superseded');

  const { revisionId, requirementId, sourceId, outcome, observedAt, summary } = event.replacement;

  if (oldEv.revisionId !== revisionId || oldEv.requirementId !== requirementId) {
    throw new Error(
      'CROSS_SCOPE_REPLACEMENT: Replacement must match the old evidence revision and requirement exactly; submit separate evidence instead'
    );
  }

  const sourceResult = await runCypher(
    `MATCH (src:Source {id: $sourceId, workspaceId: $wsId}) RETURN src.authority as authority`,
    { sourceId, wsId: FIXED_WORKSPACE_ID }
  );
  if (sourceResult.data.length === 0) throw new Error('VALIDATION_ERROR: Source not found');
  if (sourceResult.data[0].authority !== 'allowlisted') {
    throw new Error('VALIDATION_ERROR: Source not authorized to supersede');
  }

  const reqCheck = await runCypher(
    `MATCH (req:Requirement {id: $requirementId, workspaceId: $wsId}) RETURN req.id as id`,
    { requirementId, wsId: FIXED_WORKSPACE_ID }
  );
  if (reqCheck.data.length === 0) throw new Error('VALIDATION_ERROR: Requirement not found');

  const revCheck = await runCypher(
    `MATCH (rev:ReleaseRevision {id: $revisionId, workspaceId: $wsId}) RETURN rev.id as id`,
    { revisionId, wsId: FIXED_WORKSPACE_ID }
  );
  if (revCheck.data.length === 0) throw new Error('VALIDATION_ERROR: Replacement revision not found');

  const newEvId = generateEvidenceId();
  const affectedReleases = await owningReleasesForRevision(revisionId);

  const query = `
    ${applyGuard}
    MATCH (oldEv:Evidence {id: $oldEvidenceId, workspaceId: $wsId})
    MATCH (rev:ReleaseRevision {id: $revisionId, workspaceId: $wsId})
    MATCH (req:Requirement {id: $requirementId, workspaceId: $wsId})
    MATCH (src:Source {id: $sourceId, workspaceId: $wsId})
    OPTIONAL MATCH (ar:Release) WHERE ar.id IN $affectedReleases
    WITH w, oldEv, rev, req, src, collect(ar) as affectedNodes
    CREATE (newEv:Evidence {
      id: $newEvId, workspaceId: $wsId, sourceId: $sourceId, outcome: $outcome,
      observedAt: $observedAt, receivedAt: $now, synthetic: true,
      contentSummary: $summary, revisionId: $revisionId, createdAt: $now
    })
    CREATE (newEv)-[:SUPERSEDES {id: 'rel_sup_ev_' + $newEvId + '_' + $oldEvidenceId}]->(oldEv)
    CREATE (newEv)-[:SATISFIES_CHECK {id: 'rel_sat_' + $newEvId + '_' + $requirementId}]->(req)
    CREATE (newEv)-[:FROM_SOURCE {id: 'rel_src_' + $newEvId + '_' + $sourceId}]->(src)
    CREATE (newEv)-[:FOR_REVISION {id: 'rel_rev_' + $newEvId + '_' + $revisionId}]->(rev)
    SET oldEv.supersededByEvidenceId = $newEvId
    FOREACH (a IN affectedNodes | SET a.currentDecisionId = null)
    ${eventCreateClause({
      eventId,
      key,
      payloadHash,
      now,
      expectedRevision,
      affectedReleases,
      revisionId,
      evidenceId: newEvId,
    })}
    CREATE (evt)-[:CHANGES {id: 'rel_chg_' + $eventId + '_' + $newEvId}]->(newEv)
    SET w.revision = w.revision + 1
    RETURN w.revision as newRevision
  `;

  return {
    query,
    params: {
      ...eventParams(
        {
          eventId,
          key,
          payloadHash,
          now,
          expectedRevision,
          affectedReleases,
          revisionId,
          evidenceId: newEvId,
        },
        event.type
      ),
      oldEvidenceId: event.oldEvidenceId,
      newEvId,
      revisionId,
      requirementId,
      sourceId,
      outcome,
      observedAt,
      summary,
    },
    affectedReleases,
  };
}

async function diagnoseApplyFailure(
  key: string,
  payloadHash: string,
  expectedRevision: number
): Promise<Error> {
  const existing = await readEventByKey(key);
  if (existing) {
    if (existing.state === 'PENDING' || existing.state === 'FAILED') {
      return new Error(`INCOMPLETE_PRIOR_ATTEMPT: idempotency key ${key} was left in state ${existing.state}`);
    }
    if (existing.payloadHash && existing.payloadHash !== payloadHash) {
      return new Error('DUPLICATE_KEY_CONFLICT: Same idempotency key with different payload');
    }
    return new Error('DUPLICATE_KEY_CONFLICT: Event with this idempotency key was already applied concurrently');
  }
  const currentRevision = await getWorkspaceRevision();
  if (currentRevision !== expectedRevision) {
    return new Error(`STALE_REVISION: Expected revision ${expectedRevision}, current is ${currentRevision}`);
  }
  return new Error('APPLY_FAILED: Guarded write produced no rows although revision and idempotency key look valid');
}

export async function applyEvent(
  event: DomainEvent,
  expectedRevision: number,
  idempotencyKey: string
): Promise<{ eventId: string; newWorkspaceRevision: number; affectedReleases: string[] }> {
  return enqueueMutation(async () => {
    const payloadHash = stableStringify(event);
    const fastPath = await resolveIdempotencyFastPath(idempotencyKey, payloadHash);
    if (fastPath.hit) return fastPath.result;

    const revCheck = await checkExpectedRevision(expectedRevision);
    if (!revCheck.valid) {
      throw new Error(`STALE_REVISION: Expected revision ${expectedRevision}, current is ${revCheck.currentRevision}`);
    }

    const eventId = generateEventId();
    const now = nowISO();

    let plan: ApplyPlan;
    if (event.type === 'DEPENDENCY_CHANGED') {
      plan = await planDependencyChanged(event, eventId, idempotencyKey, payloadHash, now, expectedRevision);
    } else if (event.type === 'TEST_RECORDED') {
      plan = await planTestRecorded(event, eventId, idempotencyKey, payloadHash, now, expectedRevision);
    } else if (event.type === 'EVIDENCE_WITHDRAWN') {
      plan = await planEvidenceWithdrawn(event, eventId, idempotencyKey, payloadHash, now, expectedRevision);
    } else if (event.type === 'EVIDENCE_SUPERSEDED') {
      plan = await planEvidenceSuperseded(event, eventId, idempotencyKey, payloadHash, now, expectedRevision);
    } else {
      throw new Error(`VALIDATION_ERROR: Unknown event type ${(event as any).type}`);
    }

    const result = await runCypher(plan.query, plan.params);
    if (!result.data || result.data.length === 0) {
      throw await diagnoseApplyFailure(idempotencyKey, payloadHash, expectedRevision);
    }
    const newWorkspaceRevision = result.data[0].newRevision;

    // Contracts: domain events re-evaluate pending state (currentDecisionId
    // already nulled by the plan) but never persist a Decision. Only an
    // explicit RECORD_REASSESSMENT records decisions.
    return { eventId, newWorkspaceRevision, affectedReleases: plan.affectedReleases };
  });
}

export async function recordReassessment(
  releaseId: string,
  expectedRevision: number,
  idempotencyKey: string
): Promise<{ decisionId: string; newWorkspaceRevision: number }> {
  return enqueueMutation(async () => {
    const payloadHash = stableStringify({ type: 'RECORD_REASSESSMENT', releaseId });
    const existing = await readEventByKey(idempotencyKey);
    if (existing) {
      if (existing.state === 'PENDING' || existing.state === 'FAILED') {
        throw new Error(`INCOMPLETE_PRIOR_ATTEMPT: idempotency key ${idempotencyKey} was left in state ${existing.state}`);
      }
      if (existing.payloadHash && existing.payloadHash !== payloadHash) {
        throw new Error('DUPLICATE_KEY_CONFLICT: Same idempotency key with different payload');
      }
      return {
        decisionId: existing.decisionId ?? existing.id,
        newWorkspaceRevision: existing.appliedWorkspaceRevision ?? (await getWorkspaceRevision()),
      };
    }

    const revCheck = await checkExpectedRevision(expectedRevision);
    if (!revCheck.valid) {
      throw new Error(`STALE_REVISION: Expected revision ${expectedRevision}, current is ${revCheck.currentRevision}`);
    }

    const releaseResult = await runCypher(
      `MATCH (r:Release {id: $releaseId, workspaceId: $wsId})-[:CURRENT_REVISION]->(rev:ReleaseRevision)
       RETURN r.name as name, rev.id as revisionId`,
      { releaseId, wsId: FIXED_WORKSPACE_ID }
    );
    if (releaseResult.data.length === 0) {
      throw new Error(`Release ${releaseId} not found or has no current revision`);
    }
    const releaseName = releaseResult.data[0].name;
    const revisionId = releaseResult.data[0].revisionId;

    const evaluation = await evaluateReleaseRevision(revisionId);
    if (!evaluation) {
      throw new Error(`Revision ${revisionId} not found`);
    }
    evaluation.releaseId = releaseId;
    evaluation.releaseName = releaseName;
    evaluation.evaluatedWorkspaceRevision = expectedRevision + 1;

    const decisionId = generateDecisionId();
    const eventId = generateEventId();
    const now = nowISO();

    const prevResult = await runCypher(
      `MATCH (dec:Decision)-[:ASSESSES]->(rev:ReleaseRevision {id: $revisionId, workspaceId: $wsId})
       RETURN dec.id as id ORDER BY dec.evaluatedAt DESC LIMIT 1`,
      { revisionId, wsId: FIXED_WORKSPACE_ID }
    );
    const prevDecId: string | null = prevResult.data[0]?.id || null;
    const replacesClause = prevDecId
      ? `FOREACH (p IN [prevDec] | CREATE (dec)-[:REPLACES {id: 'rel_replaces_' + $decisionId + '_' + $prevDecId}]->(p))`
      : '';

    const query = `
      ${applyGuard}
      MATCH (rel:Release {id: $releaseId, workspaceId: $wsId})
      MATCH (rev:ReleaseRevision {id: $revisionId, workspaceId: $wsId})
      OPTIONAL MATCH (prevDec:Decision {id: $prevDecId})
      WITH w, rel, rev, prevDec
      OPTIONAL MATCH (ev:Evidence) WHERE ev.id IN $supportedIds
      WITH w, rel, rev, prevDec, collect(ev) as supportedEvs
      OPTIONAL MATCH (req:Requirement) WHERE req.id IN $requirementIds
      WITH w, rel, rev, prevDec, supportedEvs, collect(req) as evalReqs
      CREATE (dec:Decision {
        id: $decisionId, workspaceId: $wsId, status: $status, reasonCodes: $reasonCodes,
        evaluatedWorkspaceRevision: $expectedRevision + 1, policyVersion: 'v1',
        evaluatedAt: $evaluatedAt, revisionId: rev.id, createdAt: $now
      })
      CREATE (dec)-[:ASSESSES {id: 'rel_assesses_' + $decisionId + '_' + rev.id}]->(rev)
      FOREACH (e IN supportedEvs | CREATE (dec)-[:SUPPORTED_BY {id: 'rel_sup_' + $decisionId + '_' + e.id}]->(e))
      FOREACH (rq IN evalReqs | CREATE (dec)-[:EVALUATES {id: 'rel_eval_' + $decisionId + '_' + rq.id}]->(rq))
      ${replacesClause}
      SET rel.currentDecisionId = $decisionId
      CREATE (evt:Event {
        id: $eventId, workspaceId: $wsId, type: 'RECORD_REASSESSMENT', eventType: 'RECORD_REASSESSMENT',
        idempotencyKey: $key, receivedAt: $now, payloadHash: $payloadHash,
        applicationState: 'APPLIED', createdAt: $now,
        appliedWorkspaceRevision: $expectedRevision + 1,
        affectedReleases: $affectedReleases,
        revisionId: $revisionId,
        decisionId: $decisionId
      })
      SET w.revision = w.revision + 1
      RETURN w.revision as newRevision
    `;

    const result = await runCypher(query, {
      releaseId,
      revisionId,
      prevDecId,
      supportedIds: evaluation.evaluationIncomplete ? [] : evaluation.supportedByEvidenceIds,
      requirementIds: evaluation.requirements.map((r) => r.requirementId),
      decisionId,
      status: evaluation.status,
      reasonCodes: evaluation.reasonCodes,
      evaluatedAt: evaluation.evaluatedAt,
      eventId,
      key: idempotencyKey,
      payloadHash,
      now,
      expectedRevision,
      affectedReleases: [releaseId],
      wsId: FIXED_WORKSPACE_ID,
    });

    if (!result.data || result.data.length === 0) {
      throw await diagnoseApplyFailure(idempotencyKey, payloadHash, expectedRevision);
    }

    return { decisionId, newWorkspaceRevision: result.data[0].newRevision };
  });
}

export async function createReviewTask(
  revisionId: string,
  requirementId: string,
  description: string,
  proposalId: string
): Promise<string> {
  return enqueueMutation(async () => {
    const taskId = generateTaskId();
    await runCypher(
      `CREATE (tsk:ReviewTask {
        id: $id, workspaceId: $wsId, taskKey: $taskKey, status: 'OPEN',
        description: $description, requirementId: $reqId, revisionId: $revId,
        createdByProposalId: $propId, resolvedByEvidenceIds: [], createdAt: $createdAt
      })`,
      {
        id: taskId,
        wsId: FIXED_WORKSPACE_ID,
        taskKey: `task_${requirementId}_${Date.now()}`,
        description,
        reqId: requirementId,
        revId: revisionId,
        propId: proposalId,
        createdAt: nowISO(),
      }
    );
    return taskId;
  });
}

export async function resolveReviewTask(
  taskId: string,
  proposalId: string,
  evidenceIds: string[],
  decisionId?: string
): Promise<void> {
  return enqueueMutation(async () => {
    await runCypher(
      `MATCH (tsk:ReviewTask {id: $taskId, workspaceId: $wsId})
       SET tsk.status = 'RESOLVED', tsk.resolvedByProposalId = $propId,
           tsk.resolvedByEvidenceIds = $evidenceIds, tsk.resolvedByDecisionId = $decisionId,
           tsk.resolvedAt = $resolvedAt`,
      {
        taskId,
        wsId: FIXED_WORKSPACE_ID,
        propId: proposalId,
        evidenceIds,
        decisionId: decisionId || null,
        resolvedAt: nowISO(),
      }
    );
  });
}
