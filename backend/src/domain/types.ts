export type NodeType =
  | 'Workspace'
  | 'Release'
  | 'ReleaseRevision'
  | 'DependencyVersion'
  | 'Requirement'
  | 'Evidence'
  | 'Source'
  | 'Decision'
  | 'Event'
  | 'ReviewTask'
  | 'AgentRun'
  | 'Proposal';

export interface BaseNode {
  id: string;
  type: NodeType;
  workspaceId: string;
  createdAt: string;
}

export interface WorkspaceNode extends BaseNode {
  type: 'Workspace';
  revision: number;
}

export interface ReleaseNode extends BaseNode {
  type: 'Release';
  name: string;
  currentRevisionId: string;
  currentDecisionId?: string;
}

export interface ReleaseRevisionNode extends BaseNode {
  type: 'ReleaseRevision';
  releaseId: string;
  revisionNumber: number;
  policyVersion: string;
}

export interface DependencyVersionNode extends BaseNode {
  type: 'DependencyVersion';
  dependencyName: string;
  version: string;
}

export interface RequirementNode extends BaseNode {
  type: 'Requirement';
  checkKind: string;
  description: string;
  revisionId: string;
}

export interface EvidenceNode extends BaseNode {
  type: 'Evidence';
  sourceId: string;
  outcome: 'PASS' | 'FAIL';
  observedAt: string;
  receivedAt: string;
  synthetic: boolean;
  contentSummary: string;
  withdrawnByEventId?: string;
  supersededByEvidenceId?: string;
  revisionId: string;
}

export interface SourceNode extends BaseNode {
  type: 'Source';
  name: string;
  authority: 'allowlisted' | 'untrusted';
  synthetic: boolean;
}

export interface DecisionNode extends BaseNode {
  type: 'Decision';
  status: 'APPROVED' | 'NEEDS_REVIEW' | 'BLOCKED';
  reasonCodes: string[];
  evaluatedWorkspaceRevision: number;
  policyVersion: string;
  evaluatedAt: string;
  revisionId: string;
}

export interface EventNode extends BaseNode {
  type: 'Event';
  eventType: 'DEPENDENCY_CHANGED' | 'TEST_RECORDED' | 'EVIDENCE_WITHDRAWN' | 'EVIDENCE_SUPERSEDED' | 'RECORD_REASSESSMENT';
  idempotencyKey: string;
  receivedAt: string;
  payloadHash: string;
  applicationState: 'PENDING' | 'APPLIED' | 'FAILED' | 'CONFLICT';
  appliedWorkspaceRevision?: number;
  affectedReleases?: string[];
  evidenceId?: string;
  decisionId?: string;
  revisionId?: string;
}

export interface ReviewTaskNode extends BaseNode {
  type: 'ReviewTask';
  taskKey: string;
  status: 'OPEN' | 'RESOLVED';
  description: string;
  requirementId: string;
  revisionId: string;
  createdByProposalId?: string;
  resolvedByProposalId?: string;
  resolvedByEvidenceIds: string[];
  resolvedByDecisionId?: string;
  resolvedAt?: string;
}

export interface AgentRunNode extends BaseNode {
  type: 'AgentRun';
  status: 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'STALE';
  snapshotRevision: number;
  provider: string;
  model: string;
  startedAt: string;
  endedAt?: string;
}

export interface ProposalNode extends BaseNode {
  type: 'Proposal';
  runId: string;
  expectedRevision: number;
  status: 'PENDING' | 'APPLIED' | 'STALE' | 'REJECTED';
  actionType: 'RECORD_REASSESSMENT' | 'CREATE_EVIDENCE_REQUEST' | 'RESOLVE_EVIDENCE_REQUEST';
  citedIds: string[];
  completionReason?: string;
  appliedAt?: string;
}

export type AnyNode =
  | WorkspaceNode
  | ReleaseNode
  | ReleaseRevisionNode
  | DependencyVersionNode
  | RequirementNode
  | EvidenceNode
  | SourceNode
  | DecisionNode
  | EventNode
  | ReviewTaskNode
  | AgentRunNode
  | ProposalNode;

export type RelationshipType =
  | 'HAS_REVISION'
  | 'CURRENT_REVISION'
  | 'DEPENDS_ON'
  | 'REQUIRES'
  | 'FOR_VERSION'
  | 'FOR_REVISION'
  | 'SATISFIES_CHECK'
  | 'FROM_SOURCE'
  | 'SUPERSEDES'
  | 'WITHDRAWS'
  | 'ASSESSES'
  | 'SUPPORTED_BY'
  | 'EVALUATES'
  | 'REPLACES'
  | 'CHANGES'
  | 'FOR_REQUIREMENT'
  | 'INSPECTED'
  | 'PROPOSED'
  | 'BASED_ON';

export interface Relationship {
  id: string;
  type: RelationshipType;
  sourceId: string;
  targetId: string;
  properties?: Record<string, unknown>;
}

export type ReleaseStatus = 'APPROVED' | 'NEEDS_REVIEW' | 'BLOCKED';
export type EvidenceOutcome = 'PASS' | 'FAIL';
export type SourceAuthority = 'allowlisted' | 'untrusted';
export type TaskStatus = 'OPEN' | 'RESOLVED';
export type RunStatus = 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'STALE';
export type ProposalStatus = 'PENDING' | 'APPLIED' | 'STALE' | 'REJECTED';
export type EventType = 'DEPENDENCY_CHANGED' | 'TEST_RECORDED' | 'EVIDENCE_WITHDRAWN' | 'EVIDENCE_SUPERSEDED' | 'RECORD_REASSESSMENT';
export type EventApplicationState = 'PENDING' | 'APPLIED' | 'FAILED' | 'CONFLICT';