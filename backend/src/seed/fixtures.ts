import {
  WorkspaceNode,
  ReleaseNode,
  ReleaseRevisionNode,
  DependencyVersionNode,
  RequirementNode,
  EvidenceNode,
  SourceNode,
  DecisionNode,
  Relationship,
} from '../domain/types';
import {
  generateWorkspaceId,
  generateReleaseId,
  generateRevisionId,
  generateDependencyVersionId,
  generateRequirementId,
  generateEvidenceId,
  generateSourceId,
  generateDecisionId,
  nowISO,
} from '../domain/ids';

export const FIXED_WORKSPACE_ID = 'ws_demo';
export const FIXED_CHECKOUT_RELEASE_ID = 'rel_checkout_r1';
export const FIXED_DOCS_RELEASE_ID = 'rel_docs_r1';

export function createSeedData(): {
  nodes: any[];
  relationships: Relationship[];
} {
  const timestamp = '2026-01-15T10:00:00.000Z';

  const nodes: any[] = [];

  const workspace: WorkspaceNode = {
    id: FIXED_WORKSPACE_ID,
    type: 'Workspace',
    workspaceId: FIXED_WORKSPACE_ID,
    createdAt: timestamp,
    revision: 1,
  };
  nodes.push(workspace);

  const checkoutRelease: ReleaseNode = {
    id: FIXED_CHECKOUT_RELEASE_ID,
    type: 'Release',
    workspaceId: FIXED_WORKSPACE_ID,
    createdAt: timestamp,
    name: 'checkout-r1',
    currentRevisionId: 'rev_checkout_r1_v1',
    currentDecisionId: 'dec_checkout_r1_v1_approved',
  };
  nodes.push(checkoutRelease);

  const docsRelease: ReleaseNode = {
    id: FIXED_DOCS_RELEASE_ID,
    type: 'Release',
    workspaceId: FIXED_WORKSPACE_ID,
    createdAt: timestamp,
    name: 'docs-r1',
    currentRevisionId: 'rev_docs_r1_v1',
    currentDecisionId: 'dec_docs_r1_v1_approved',
  };
  nodes.push(docsRelease);

  const checkoutRev: ReleaseRevisionNode = {
    id: 'rev_checkout_r1_v1',
    type: 'ReleaseRevision',
    workspaceId: FIXED_WORKSPACE_ID,
    createdAt: timestamp,
    releaseId: FIXED_CHECKOUT_RELEASE_ID,
    revisionNumber: 1,
    policyVersion: 'v1',
  };
  nodes.push(checkoutRev);

  const docsRev: ReleaseRevisionNode = {
    id: 'rev_docs_r1_v1',
    type: 'ReleaseRevision',
    workspaceId: FIXED_WORKSPACE_ID,
    createdAt: timestamp,
    releaseId: FIXED_DOCS_RELEASE_ID,
    revisionNumber: 1,
    policyVersion: 'v1',
  };
  nodes.push(docsRev);

  const paymentApiV2: DependencyVersionNode = {
    id: 'dep_payment_api_v2',
    type: 'DependencyVersion',
    workspaceId: FIXED_WORKSPACE_ID,
    createdAt: timestamp,
    dependencyName: 'payment-api',
    version: '2.0.0',
  };
  nodes.push(paymentApiV2);

  const checkoutReq: RequirementNode = {
    id: 'req_checkout_integration_v2',
    type: 'Requirement',
    workspaceId: FIXED_WORKSPACE_ID,
    createdAt: timestamp,
    checkKind: 'integration_test',
    description: 'Integration test for checkout-r1 with payment-api v2',
    revisionId: 'rev_checkout_r1_v1',
  };
  nodes.push(checkoutReq);

  const docsReq: RequirementNode = {
    id: 'req_docs_completeness',
    type: 'Requirement',
    workspaceId: FIXED_WORKSPACE_ID,
    createdAt: timestamp,
    checkKind: 'documentation_check',
    description: 'Documentation completeness check for docs-r1',
    revisionId: 'rev_docs_r1_v1',
  };
  nodes.push(docsReq);

  const ciSource: SourceNode = {
    id: 'src_ci_synthetic',
    type: 'Source',
    workspaceId: FIXED_WORKSPACE_ID,
    createdAt: timestamp,
    name: 'Synthetic CI',
    authority: 'allowlisted',
    synthetic: true,
  };
  nodes.push(ciSource);

  const docsSource: SourceNode = {
    id: 'src_docs_synthetic',
    type: 'Source',
    workspaceId: FIXED_WORKSPACE_ID,
    createdAt: timestamp,
    name: 'Synthetic Docs Checker',
    authority: 'allowlisted',
    synthetic: true,
  };
  nodes.push(docsSource);

  const checkoutEvidence: EvidenceNode = {
    id: 'ev_checkout_integration_v2_pass',
    type: 'Evidence',
    workspaceId: FIXED_WORKSPACE_ID,
    createdAt: timestamp,
    sourceId: 'src_ci_synthetic',
    outcome: 'PASS',
    observedAt: '2026-01-15T10:05:00.000Z',
    receivedAt: '2026-01-15T10:05:00.000Z',
    synthetic: true,
    contentSummary: 'Synthetic test evidence; no CI test was executed by AFTERIMAGE. Integration test for checkout-r1 with payment-api v2 passed.',
    revisionId: 'rev_checkout_r1_v1',
  };
  nodes.push(checkoutEvidence);

  const docsEvidence: EvidenceNode = {
    id: 'ev_docs_completeness_pass',
    type: 'Evidence',
    workspaceId: FIXED_WORKSPACE_ID,
    createdAt: timestamp,
    sourceId: 'src_docs_synthetic',
    outcome: 'PASS',
    observedAt: '2026-01-15T10:10:00.000Z',
    receivedAt: '2026-01-15T10:10:00.000Z',
    synthetic: true,
    contentSummary: 'Synthetic test evidence; no CI test was executed by AFTERIMAGE. Documentation completeness check for docs-r1 passed.',
    revisionId: 'rev_docs_r1_v1',
  };
  nodes.push(docsEvidence);

  const checkoutDecision: DecisionNode = {
    id: 'dec_checkout_r1_v1_approved',
    type: 'Decision',
    workspaceId: FIXED_WORKSPACE_ID,
    createdAt: timestamp,
    status: 'APPROVED',
    reasonCodes: ['ALL_REQUIREMENTS_SATISFIED'],
    evaluatedWorkspaceRevision: 1,
    policyVersion: 'v1',
    evaluatedAt: '2026-01-15T10:15:00.000Z',
    revisionId: 'rev_checkout_r1_v1',
  };
  nodes.push(checkoutDecision);

  const docsDecision: DecisionNode = {
    id: 'dec_docs_r1_v1_approved',
    type: 'Decision',
    workspaceId: FIXED_WORKSPACE_ID,
    createdAt: timestamp,
    status: 'APPROVED',
    reasonCodes: ['ALL_REQUIREMENTS_SATISFIED'],
    evaluatedWorkspaceRevision: 1,
    policyVersion: 'v1',
    evaluatedAt: '2026-01-15T10:15:00.000Z',
    revisionId: 'rev_docs_r1_v1',
  };
  nodes.push(docsDecision);

  const relationships: Relationship[] = [
    { id: 'rel_ws_checkout', type: 'HAS_REVISION', sourceId: FIXED_WORKSPACE_ID, targetId: 'rev_checkout_r1_v1' },
    { id: 'rel_ws_docs', type: 'HAS_REVISION', sourceId: FIXED_WORKSPACE_ID, targetId: 'rev_docs_r1_v1' },
    { id: 'rel_checkout_has_rev', type: 'HAS_REVISION', sourceId: FIXED_CHECKOUT_RELEASE_ID, targetId: 'rev_checkout_r1_v1' },
    { id: 'rel_docs_has_rev', type: 'HAS_REVISION', sourceId: FIXED_DOCS_RELEASE_ID, targetId: 'rev_docs_r1_v1' },
    { id: 'rel_checkout_current', type: 'CURRENT_REVISION', sourceId: FIXED_CHECKOUT_RELEASE_ID, targetId: 'rev_checkout_r1_v1' },
    { id: 'rel_docs_current', type: 'CURRENT_REVISION', sourceId: FIXED_DOCS_RELEASE_ID, targetId: 'rev_docs_r1_v1' },
    { id: 'rel_checkout_dep', type: 'DEPENDS_ON', sourceId: 'rev_checkout_r1_v1', targetId: 'dep_payment_api_v2' },
    { id: 'rel_checkout_req', type: 'REQUIRES', sourceId: 'rev_checkout_r1_v1', targetId: 'req_checkout_integration_v2' },
    { id: 'rel_docs_req', type: 'REQUIRES', sourceId: 'rev_docs_r1_v1', targetId: 'req_docs_completeness' },
    { id: 'rel_req_version', type: 'FOR_VERSION', sourceId: 'req_checkout_integration_v2', targetId: 'dep_payment_api_v2' },
    { id: 'rel_checkout_evidence_rev', type: 'FOR_REVISION', sourceId: 'ev_checkout_integration_v2_pass', targetId: 'rev_checkout_r1_v1' },
    { id: 'rel_docs_evidence_rev', type: 'FOR_REVISION', sourceId: 'ev_docs_completeness_pass', targetId: 'rev_docs_r1_v1' },
    { id: 'rel_checkout_evidence_req', type: 'SATISFIES_CHECK', sourceId: 'ev_checkout_integration_v2_pass', targetId: 'req_checkout_integration_v2' },
    { id: 'rel_docs_evidence_req', type: 'SATISFIES_CHECK', sourceId: 'ev_docs_completeness_pass', targetId: 'req_docs_completeness' },
    { id: 'rel_checkout_evidence_source', type: 'FROM_SOURCE', sourceId: 'ev_checkout_integration_v2_pass', targetId: 'src_ci_synthetic' },
    { id: 'rel_docs_evidence_source', type: 'FROM_SOURCE', sourceId: 'ev_docs_completeness_pass', targetId: 'src_docs_synthetic' },
    { id: 'rel_checkout_decision_assesses', type: 'ASSESSES', sourceId: 'dec_checkout_r1_v1_approved', targetId: 'rev_checkout_r1_v1' },
    { id: 'rel_docs_decision_assesses', type: 'ASSESSES', sourceId: 'dec_docs_r1_v1_approved', targetId: 'rev_docs_r1_v1' },
    { id: 'rel_checkout_decision_supported', type: 'SUPPORTED_BY', sourceId: 'dec_checkout_r1_v1_approved', targetId: 'ev_checkout_integration_v2_pass' },
    { id: 'rel_docs_decision_supported', type: 'SUPPORTED_BY', sourceId: 'dec_docs_r1_v1_approved', targetId: 'ev_docs_completeness_pass' },
    { id: 'rel_checkout_decision_evaluates', type: 'EVALUATES', sourceId: 'dec_checkout_r1_v1_approved', targetId: 'req_checkout_integration_v2' },
    { id: 'rel_docs_decision_evaluates', type: 'EVALUATES', sourceId: 'dec_docs_r1_v1_approved', targetId: 'req_docs_completeness' },
  ];

  return { nodes, relationships };
}