import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import type { ReleaseDetail, Decision, Evidence, Task } from '../../../api/types';
import { listTasks } from '../../../api/client';
import { StatusMark } from '../../StatusMark/StatusMark';
import { RecordRef } from '../../RecordRef/RecordRef';
import { AuthorityTag } from '../../AuthorityTag/AuthorityTag';
import { SyntheticNote } from '../../SyntheticNote/SyntheticNote';
import { Button } from '../../Button/Button';
import { useWorkspaceRevision } from '../../../hooks/useRevision';
import { formatTimestamp, getRequirementResultLabel, getStatusLabel } from '../../../lib/format';
import { uniqueIds } from '../../../lib/recordTypes';
import styles from './StatusTab.module.css';

interface StatusTabProps {
  release: ReleaseDetail;
  latestHistoricalDecision: Decision | null;
  onInvestigate: () => void;
  onOpenInspector: (type: string, id: string) => void;
}

export function StatusTab({
  release,
  latestHistoricalDecision,
  onInvestigate,
  onOpenInspector,
}: StatusTabProps) {
  const [expandedNonApplicable, setExpandedNonApplicable] = useState<Set<string>>(new Set());
  const [requests, setRequests] = useState<Task[]>([]);
  const [requestsLoaded, setRequestsLoaded] = useState(false);
  const workspaceRevision = useWorkspaceRevision();

  useEffect(() => {
    let cancelled = false;
    listTasks(release.id)
      .then((res) => {
        if (!cancelled) setRequests(res.data);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setRequestsLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [release.id, workspaceRevision]);

  const status = release.status;
  const isPending = release.evaluationPending;
  // Server-provided historical marker (P6/P7): its presence is the only signal;
  // currentness is never inferred by comparing revision numbers.
  const hasGhostStack = Boolean(latestHistoricalDecision);

  return (
    <div className={styles.container}>
      <section
        className={`${styles.statusBlock} ${isPending ? styles.statusBlockPending : ''}`}
        data-testid="status-block"
      >
        {isPending && (
          <div className={styles.hatchBar} aria-hidden="true" />
        )}
        <div className={styles.statusHeader}>
          <div className={styles.currentStatus}>
            <StatusMark
              status={status}
              variant={isPending ? 'pending' : 'current'}
              size="large"
              showLabel={true}
            />
            <div className={styles.statusText}>
              <h2 className={styles.headline}>
                {isPending
                  ? `${release.name} needs review`
                  : `${release.name} is ${getStatusLabel(status).toLowerCase()}`}
              </h2>
              {isPending && <p className={styles.pendingLabel}>Re-evaluation pending</p>}
              <p className={styles.staticExplanation}>{getStaticExplanation(status, isPending)}</p>
              {release.currentDecision?.explanation && (
                <p className={styles.serverReason}>{release.currentDecision.explanation}</p>
              )}
            </div>
          </div>
          {hasGhostStack && latestHistoricalDecision && (
            <div className={styles.ghostStack}>
              <Link
                to="?tab=history"
                className={styles.ghostLink}
                aria-label={`Historical decision: ${getStatusLabel(latestHistoricalDecision.status)} at revision ${latestHistoricalDecision.revisionNumber ?? latestHistoricalDecision.evaluatedWorkspaceRevision}, not current. Open history.`}
              >
                <StatusMark
                  status={latestHistoricalDecision.status}
                  variant="historical"
                  historicalRef={
                    latestHistoricalDecision.revisionNumber ??
                    latestHistoricalDecision.evaluatedWorkspaceRevision
                  }
                  showLabel={true}
                />
              </Link>
              <p className={styles.ghostExplanation}>
                Earlier decision retained for history. Not the current decision.
              </p>
            </div>
          )}
        </div>

        <div className={styles.actions}>
          <Button onClick={onInvestigate} variant="primary" data-testid="investigate-button">
            {isPending ? 'Investigate this release' : 'Investigate'}
          </Button>
        </div>
      </section>

      <section className={styles.revisionCard}>
        <h2 className={styles.sectionTitle}>Revision</h2>
        <div className={styles.revisionInfo}>
          <span className={styles.revisionNumber}>Revision {release.revision.revisionNumber}</span>
          <span className={styles.policyVersion}>Policy {release.revision.policyVersion}</span>
        </div>
        <div className={styles.dependencies}>
          {release.dependencies.map((dep) => (
            <span key={dep.id} className={styles.depChip}>
              <span className={styles.depName}>{dep.dependencyName}</span>
              <span className={styles.depVersion}>{dep.version}</span>
            </span>
          ))}
        </div>
        {release.previousRevision && (
          <p className={styles.previousRevisionNote}>
            Previous revision {release.previousRevision.revisionNumber} is retained in History.
          </p>
        )}
      </section>

      <section className={styles.requirements}>
        <h2 className={styles.sectionTitle}>Requirements and evidence</h2>
        {release.requirements.map((req) => (
          <div key={req.id} className={styles.requirement}>
            <div className={styles.requirementHeader}>
              <span className={styles.checkKind}>{req.checkKind}</span>
              <span className={`${styles.resultLabel} ${styles[`result_${req.result}`] ?? ''}`}>
                {getRequirementResultLabel(req.result)}
              </span>
              {req.requiredVersion && (
                <span className={styles.requiredVersion}>Requires {req.requiredVersion}</span>
              )}
            </div>
            <p className={styles.requirementDesc}>{req.description}</p>
            {req.explanation && (
              <p className={styles.requirementExplanation}>{req.explanation}</p>
            )}
            {req.reasonCodes.length > 0 && (
              <div className={styles.requirementReasons}>
                {req.reasonCodes.map((code) => (
                  <span key={code} className={styles.requirementReasonCode}>{code}</span>
                ))}
              </div>
            )}

            <div className={styles.evidenceList}>
              {req.evidence.filter(e => e.applicable).map((evidence) => (
                <EvidenceRow
                  key={evidence.id}
                  evidence={evidence}
                  onOpenInspector={onOpenInspector}
                  expanded={true}
                />
              ))}

              {(() => {
                const nonApplicable = req.evidence.filter(e => !e.applicable);
                if (nonApplicable.length === 0) return null;
                const isExpanded = expandedNonApplicable.has(req.id);
                return (
                  <div className={styles.nonApplicable}>
                    <button
                      className={styles.expandButton}
                      onClick={() => {
                        const next = new Set(expandedNonApplicable);
                        if (isExpanded) next.delete(req.id);
                        else next.add(req.id);
                        setExpandedNonApplicable(next);
                      }}
                      aria-expanded={isExpanded}
                    >
                      {nonApplicable.length} records that don't apply {isExpanded ? '▲' : '▼'}
                    </button>
                    {isExpanded && nonApplicable.map((evidence) => (
                      <EvidenceRow
                        key={evidence.id}
                        evidence={evidence}
                        onOpenInspector={onOpenInspector}
                        expanded={false}
                      />
                    ))}
                    {!isExpanded && (
                      <div className={styles.reasonList}>
                        {nonApplicable.slice(0, 3).map((e) => (
                          <p key={e.id} className={styles.reasonItem}>
                            {e.id}: {e.applicabilityReasonCodes.join(', ') || 'Does not apply'}
                          </p>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })()}

              {req.evidence.length === 0 && (
                <p className={styles.noEvidence}>No evidence recorded for this requirement.</p>
              )}
            </div>
          </div>
        ))}
      </section>

      {release.currentDecision && (
        <section className={styles.decisionBasis}>
          <h2 className={styles.sectionTitle}>Decision basis</h2>
          <div className={styles.decisionMeta}>
            <span>Status: {getStatusLabel(release.currentDecision.status)}</span>
            <span>Policy: {release.currentDecision.policyVersion}</span>
            <span>Evaluated: <time dateTime={release.currentDecision.evaluatedAt}>{formatTimestamp(release.currentDecision.evaluatedAt)}</time></span>
            <span>Workspace revision: {release.currentDecision.evaluatedWorkspaceRevision}</span>
          </div>
          {release.currentDecision.evaluatedWorkspaceRevision < workspaceRevision && (
            <p className={styles.workspaceNote}>
              Evaluated at workspace revision {release.currentDecision.evaluatedWorkspaceRevision}; the workspace is now at {workspaceRevision}.
            </p>
          )}
          <div className={styles.reasonCodes}>
            <span className={styles.reasonCodesLabel}>Reason codes:</span>
            {release.currentDecision.reasonCodes.map((code) => (
              <span key={code} className={styles.reasonCode}>{code}</span>
            ))}
          </div>
            <div className={styles.supportingEvidence}>
              <span className={styles.supportingLabel}>Supported by:</span>
              {uniqueIds(release.currentDecision.supportedByEvidenceIds).map((id) => (
                <RecordRef
                  key={id}
                  type="Evidence"
                  id={id}
                  onClick={() => onOpenInspector('Evidence', id)}
                />
              ))}
            </div>
        </section>
      )}

      <section className={styles.requestsSection}>
        <h2 className={styles.sectionTitle}>Related requests</h2>
        {!requestsLoaded && <p className={styles.noEvidence}>Loading requests...</p>}
        {requestsLoaded && requests.length === 0 && (
          <p className={styles.noEvidence}>No evidence requests for this release.</p>
        )}
        {requests.map((task) => (
          <div key={task.id} className={styles.requestRow}>
            <span className={styles.requestStatus}>{getStatusLabel(task.status)}</span>
            <span className={styles.requestDesc}>{task.description}</span>
            <span className={styles.requestMeta}>
              Created {formatTimestamp(task.createdAt)}
              {task.resolvedAt && ` · Resolved ${formatTimestamp(task.resolvedAt)}`}
            </span>
          </div>
        ))}
        {requests.length > 0 && (
          <p className={styles.requestsNote}>
            Requests are resolved by applying an agent proposal after matching evidence is recorded.{' '}
            <Link to="/requests" className={styles.requestsLink}>Open Requests</Link>
          </p>
        )}
      </section>
    </div>
  );
}

function getStaticExplanation(status: string, isPending: boolean): string {
  if (status === 'APPROVED' && !isPending) {
    return 'Every requirement has valid evidence for this revision. This is policy satisfaction, not a guarantee the software is safe.';
  }
  if (isPending) {
    return 'A change touched this release and no new decision has been recorded yet.';
  }
  if (status === 'BLOCKED') {
    return 'Valid evidence for this revision reports a failure under the policy.';
  }
  return "Evidence is missing, doesn't match this revision, or conflicts. This doesn't mean the code is broken.";
}

function EvidenceRow({
  evidence,
  onOpenInspector,
  expanded,
}: {
  evidence: Evidence;
  onOpenInspector: (type: string, id: string) => void;
  expanded: boolean;
}) {
  // Server-labelled history only: withdrawn or superseded evidence.
  const isHistorical = Boolean(evidence.withdrawnByEventId || evidence.supersededByEvidenceId);

  return (
    <div
      className={`${styles.evidenceRow} ${isHistorical ? styles.evidenceHistorical : ''}`}
      data-testid={`evidence-row-${evidence.id}`}
    >
      <div className={styles.evidenceHeader}>
        <RecordRef
          type="Evidence"
          id={evidence.id}
          title={evidence.contentSummary || undefined}
          onClick={() => onOpenInspector('Evidence', evidence.id)}
          domainStatus={evidence.outcome}
        />
        <span className={`${styles.outcome} ${evidence.outcome === 'PASS' ? styles.pass : styles.fail}`}>
          {evidence.outcome}
        </span>
        <span className={styles.sourceName}>Source: {evidence.sourceName}</span>
        <AuthorityTag authority={evidence.sourceAuthority} />
        {evidence.sourceAuthority === 'untrusted' && (
          <span className={styles.untrustedWarning}>Recorded but cannot grant approval.</span>
        )}
      </div>

      <div className={styles.evidenceMeta}>
        <SyntheticNote />
        <span className={styles.timestamp}>
          Observed: <time dateTime={evidence.observedAt} title={new Date(evidence.observedAt).toISOString()}>{formatTimestamp(evidence.observedAt)}</time>
        </span>
        <span className={styles.timestamp}>
          Received: <time dateTime={evidence.receivedAt} title={new Date(evidence.receivedAt).toISOString()}>{formatTimestamp(evidence.receivedAt)}</time>
        </span>
      </div>

      <div className={styles.applicability}>
        <span className={`${styles.applicabilityTag} ${evidence.applicable ? styles.applicable : styles.notApplicable}`}>
          {evidence.applicable ? 'Applies to this revision' : 'Does not apply'}
        </span>
        {evidence.applicabilityExplanation && (
          <span className={styles.applicabilityReason}>{evidence.applicabilityExplanation}</span>
        )}
        {!evidence.applicabilityExplanation && evidence.applicabilityReasonCodes.length > 0 && (
          <span className={styles.applicabilityReason}>
            {evidence.applicabilityReasonCodes.join(', ')}
          </span>
        )}
        {evidence.withdrawnByEventId && (
          <span className={styles.historicalNote}>
            Withdrawn by <RecordRef type="Event" id={evidence.withdrawnByEventId} onClick={() => onOpenInspector('Event', evidence.withdrawnByEventId!)} />
          </span>
        )}
        {evidence.supersededByEvidenceId && (
          <span className={styles.historicalNote}>
            Superseded by <RecordRef type="Evidence" id={evidence.supersededByEvidenceId} onClick={() => onOpenInspector('Evidence', evidence.supersededByEvidenceId!)} />
          </span>
        )}
      </div>

      {expanded && evidence.contentSummary && (
        <p className={styles.contentSummary}>{evidence.contentSummary}</p>
      )}
    </div>
  );
}
