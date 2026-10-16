export function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  return date.toLocaleString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'UTC',
    hour12: false,
  }) + ' UTC';
}

export function formatTimestampTitle(iso: string): string {
  const date = new Date(iso);
  return date.toLocaleString(undefined, {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short',
  });
}

export function formatElapsed(startedAt: string, completedAt: string | null): string {
  const start = new Date(startedAt).getTime();
  const end = completedAt ? new Date(completedAt).getTime() : Date.now();
  const diff = end - start;
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}m ${remainingSeconds}s`;
}

export function formatRevision(revisionNumber: number): string {
  return `rev ${revisionNumber}`;
}

export function getStatusLabel(status: string): string {
  const labels: Record<string, string> = {
    APPROVED: 'Approved',
    NEEDS_REVIEW: 'Needs review',
    BLOCKED: 'Blocked',
    QUEUED: 'Queued',
    RUNNING: 'Investigating',
    COMPLETED: 'Completed',
    FAILED: 'Failed',
    STALE: 'Stale',
    PENDING: 'Ready to review',
    APPLIED: 'Applied',
    REJECTED: 'Rejected',
    OPEN: 'Open',
    RESOLVED: 'Resolved',
  };
  return labels[status] ?? status;
}

export function getRequirementResultLabel(result: string): string {
  const labels: Record<string, string> = {
    SATISFIED: 'Satisfied',
    MISSING: 'Missing evidence',
    CONFLICTING: 'Conflicting evidence',
    FAILING: 'Failing',
    NOT_EVALUATED: 'Not evaluated',
  };
  return labels[result] ?? result;
}

export function getProposalActionLabel(action: string): string {
  const labels: Record<string, string> = {
    RECORD_REASSESSMENT: 'Record a reassessment',
    CREATE_EVIDENCE_REQUEST: 'Create an evidence request',
    RESOLVE_EVIDENCE_REQUEST: 'Resolve an evidence request',
  };
  return labels[action] ?? action;
}

export function getEventTypeLabel(type: string): string {
  const labels: Record<string, string> = {
    DEPENDENCY_CHANGED: 'Change a dependency version',
    TEST_RECORDED: 'Record a synthetic test result',
    EVIDENCE_WITHDRAWN: 'Withdraw evidence',
    EVIDENCE_SUPERSEDED: 'Supersede evidence',
  };
  return labels[type] ?? type;
}

export function getEventSubmitLabel(type: string): string {
  const labels: Record<string, string> = {
    DEPENDENCY_CHANGED: 'Change dependency version',
    TEST_RECORDED: 'Record synthetic result',
    EVIDENCE_WITHDRAWN: 'Withdraw evidence',
    EVIDENCE_SUPERSEDED: 'Supersede evidence',
  };
  return labels[type] ?? 'Submit';
}

export function getProposalExplanation(action: string): string {
  const explanations: Record<string, string> = {
    RECORD_REASSESSMENT: 'Records a new decision after the policy is evaluated again. It does not deploy anything.',
    CREATE_EVIDENCE_REQUEST: 'Creates one internal evidence request. It does not run a test or contact anyone.',
    RESOLVE_EVIDENCE_REQUEST: 'Marks one internal evidence request resolved.',
  };
  return explanations[action] ?? '';
}