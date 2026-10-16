export const ReleaseStatus = {
  APPROVED: 'APPROVED',
  NEEDS_REVIEW: 'NEEDS_REVIEW',
  BLOCKED: 'BLOCKED',
} as const;

export type ReleaseStatus = typeof ReleaseStatus[keyof typeof ReleaseStatus];

export const RunStatus = {
  QUEUED: 'QUEUED',
  RUNNING: 'RUNNING',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
  STALE: 'STALE',
} as const;

export type RunStatus = typeof RunStatus[keyof typeof RunStatus];

export const ProposalStatus = {
  PENDING: 'PENDING',
  APPLIED: 'APPLIED',
  STALE: 'STALE',
  REJECTED: 'REJECTED',
} as const;

export type ProposalStatus = typeof ProposalStatus[keyof typeof ProposalStatus];

export const ProposalAction = {
  RECORD_REASSESSMENT: 'RECORD_REASSESSMENT',
  CREATE_EVIDENCE_REQUEST: 'CREATE_EVIDENCE_REQUEST',
  RESOLVE_EVIDENCE_REQUEST: 'RESOLVE_EVIDENCE_REQUEST',
} as const;

export type ProposalAction = typeof ProposalAction[keyof typeof ProposalAction];

export const TaskStatus = {
  OPEN: 'OPEN',
  RESOLVED: 'RESOLVED',
} as const;

export type TaskStatus = typeof TaskStatus[keyof typeof TaskStatus];

export const EventType = {
  DEPENDENCY_CHANGED: 'DEPENDENCY_CHANGED',
  TEST_RECORDED: 'TEST_RECORDED',
  EVIDENCE_WITHDRAWN: 'EVIDENCE_WITHDRAWN',
  EVIDENCE_SUPERSEDED: 'EVIDENCE_SUPERSEDED',
} as const;

export type EventType = typeof EventType[keyof typeof EventType];

export const ErrorCode = {
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  NOT_FOUND: 'NOT_FOUND',
  STALE_REVISION: 'STALE_REVISION',
  DUPLICATE_KEY_CONFLICT: 'DUPLICATE_KEY_CONFLICT',
  DB_UNAVAILABLE: 'DB_UNAVAILABLE',
  MODEL_UNAVAILABLE: 'MODEL_UNAVAILABLE',
  QUOTA_EXCEEDED: 'QUOTA_EXCEEDED',
  RUN_FAILED: 'RUN_FAILED',
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  RESULT_TRUNCATED: 'RESULT_TRUNCATED',
} as const;

export type ErrorCode = typeof ErrorCode[keyof typeof ErrorCode];

export const RequirementResult = {
  SATISFIED: 'SATISFIED',
  MISSING: 'MISSING',
  CONFLICTING: 'CONFLICTING',
  FAILING: 'FAILING',
  NOT_EVALUATED: 'NOT_EVALUATED',
} as const;

export type RequirementResult = typeof RequirementResult[keyof typeof RequirementResult];

export const SourceAuthority = {
  ALLOWLISTED: 'allowlisted',
  UNTRUSTED: 'untrusted',
} as const;

export type SourceAuthority = typeof SourceAuthority[keyof typeof SourceAuthority];

export const EvidenceOutcome = {
  PASS: 'PASS',
  FAIL: 'FAIL',
  INCONCLUSIVE: 'INCONCLUSIVE',
} as const;

export type EvidenceOutcome = typeof EvidenceOutcome[keyof typeof EvidenceOutcome];

export const GraphScope = {
  CURRENT: 'CURRENT',
  HISTORY: 'HISTORY',
} as const;

export type GraphScope = typeof GraphScope[keyof typeof GraphScope];

export interface ApiError {
  code: ErrorCode;
  message: string;
  retryable: boolean;
  fields?: Array<{ path: string; message: string }>;
}

export interface Meta {
  workspaceRevision: number;
  truncated?: boolean;
  scope?: GraphScope;
  paths?: string[];
  provider?: string;
  model?: string;
}

export interface ApiResponse<T> {
  data: T;
  meta: Meta;
  error?: ApiError;
}

export interface HealthCheck {
  database: boolean;
  agent: boolean;
  details: string;
  testModelDoubleActive?: boolean;
  provider?: string;
  model?: string;
}

export interface ReleaseSummary {
  id: string;
  name: string;
  currentRevisionId: string;
  currentRevisionNumber: number | null;
  status: ReleaseStatus;
  evaluationPending: boolean;
  latestDecisionId: string | null;
}

export interface DependencyVersion {
  id: string;
  dependencyName: string;
  version: string;
}

export interface Requirement {
  id: string;
  checkKind: string;
  description: string;
  requiredVersion?: string;
  result: RequirementResult;
  explanation: string;
  reasonCodes: string[];
  evidence: Evidence[];
}

export interface Evidence {
  id: string;
  sourceId: string;
  sourceName: string;
  sourceAuthority: SourceAuthority;
  outcome: EvidenceOutcome;
  observedAt: string;
  receivedAt: string;
  synthetic: boolean;
  contentSummary: string;
  withdrawnByEventId: string | null;
  supersededByEvidenceId: string | null;
  applicabilityReasonCodes: string[];
  applicable: boolean;
  applicabilityExplanation: string;
  requirementId: string;
  revisionId?: string;
}

export interface Decision {
  id: string;
  status: ReleaseStatus;
  reasonCodes: string[];
  explanation?: string;
  evaluatedAt: string;
  evaluatedWorkspaceRevision: number;
  policyVersion: string;
  revisionId?: string | null;
  revisionNumber?: number | null;
  supportedByEvidenceIds: string[];
  replacesDecisionId: string | null;
}

export interface ReleaseDetail {
  id: string;
  name: string;
  status: ReleaseStatus;
  revision: RevisionDetail;
  currentDecision: Decision | null;
  previousRevision: RevisionSummary | null;
  latestHistoricalDecision: Decision | null;
  requirements: Requirement[];
  dependencies: DependencyVersion[];
  evaluationPending: boolean;
}

export interface RevisionDetail {
  id: string;
  revisionNumber: number;
  policyVersion: string;
}

export interface RevisionSummary {
  id: string;
  revisionNumber: number;
  dependencies: DependencyVersion[];
  latestHistoricalDecision: Decision | null;
}

export interface ReleaseHistoryEntry {
  decisionId: string;
  status: ReleaseStatus;
  reasonCodes: string[];
  explanation?: string;
  evaluatedAt: string;
  evaluatedWorkspaceRevision: number;
  policyVersion: string;
  revisionId?: string | null;
  revisionNumber?: number | null;
  supportedByEvidenceIds: string[];
  replacesDecisionId: string | null;
}

export interface ReleaseGraphNode {
  id: string;
  type: string;
  label: string;
  revision?: string;
  domainStatus?: ReleaseStatus;
  historical?: boolean;
}

export interface ReleaseGraphEdge {
  source: string;
  target: string;
  type: string;
  label?: string;
  historical?: boolean;
}

export interface ReleaseGraphView {
  nodes: ReleaseGraphNode[];
  edges: ReleaseGraphEdge[];
  paths: string[];
  truncated: boolean;
  scope: GraphScope;
  meta: Meta;
}

export interface Proposal {
  id: string;
  runId: string;
  actionType: ProposalAction;
  status: ProposalStatus;
  reason: string;
  citedIds: string[];
  expectedRevision: number;
  whatApplyingDoes?: string;
  releaseId?: string;
  revisionId?: string;
  requirementId?: string | null;
  createdAt?: string;
  appliedAt?: string | null;
  decisionId?: string | null;
  taskId?: string | null;
}

export interface Task {
  id: string;
  taskKey: string;
  status: TaskStatus;
  description: string;
  releaseId: string;
  revisionId: string;
  requirementId: string;
  createdAt: string;
  resolvedAt: string | null;
  createdByProposalId: string | null;
  resolvedByProposalId: string | null;
  resolvedByEvidenceIds: string[];
  resolvedByDecisionId: string | null;
  checkKind?: string;
  revisionNumber?: number;
}

export interface RunStep {
  tool: string;
  arguments: Record<string, unknown>;
  resultSummary: string;
  returnedEntityIds: string[];
  error: string | null;
  timestamp: string;
}

export interface RunSummary {
  runId: string;
  releaseId: string;
  status: RunStatus;
  completionReason: string;
  snapshotRevision: number;
  proposalIds: string[];
  startedAt: string;
  completedAt: string | null;
  eventId: string | null;
}

export interface RunDetail {
  runId: string;
  releaseId: string;
  status: RunStatus;
  completionReason: string;
  explanation: string;
  snapshotRevision: number;
  steps: RunStep[];
  proposalIds: string[];
  startedAt: string;
  completedAt: string | null;
  eventId: string | null;
  provider: string | null;
  model: string | null;
  proposals?: Proposal[];
}

export interface EventPayload {
  type: EventType;
  payload: DependencyChangedPayload | TestRecordedPayload | EvidenceWithdrawnPayload | EvidenceSupersededPayload;
  expectedRevision: number;
  idempotencyKey: string;
}

export interface DependencyChangedPayload {
  releaseId: string;
  dependencyName: string;
  newVersion: string;
}

export interface TestRecordedPayload {
  revisionId: string;
  requirementId: string;
  sourceId: string;
  outcome: EvidenceOutcome;
  observedAt: string;
  summary: string;
}

export interface EvidenceWithdrawnPayload {
  evidenceId: string;
  sourceId: string;
  reason: string;
}

export interface EvidenceSupersededPayload {
  oldEvidenceId: string;
  replacement: {
    revisionId: string;
    requirementId: string;
    sourceId: string;
    outcome: EvidenceOutcome;
    observedAt: string;
    summary: string;
  };
}

export interface Source {
  id: string;
  name: string;
  authority: SourceAuthority;
  synthetic: boolean;
}

export interface ApplyProposalResult {
  decisionId?: string;
  taskId?: string;
  newWorkspaceRevision: number;
}

export interface EventResult {
  newWorkspaceRevision: number;
  affectedReleases: Array<{
    releaseId: string;
    name: string;
    status: ReleaseStatus;
    evaluationPending: boolean;
  }>;
}

export interface RecordDetail {
  type: string;
  id: string;
  label: string;
  domainStatus?: string;
  sourceRecordId?: string;
  fields: Record<string, unknown>;
  incidentEdges?: Array<{ type: string; targetId: string; targetLabel: string; historical?: boolean }>;
  evaluatedRevisionId?: string;
  applicable?: boolean;
}