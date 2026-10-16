import { useState, useEffect } from 'react';
import type { ReleaseHistoryEntry, Decision } from '../../../api/types';
import { getReleaseHistory } from '../../../api/client';
import { StatusMark } from '../../StatusMark/StatusMark';
import { RecordRef } from '../../RecordRef/RecordRef';
import { formatTimestamp } from '../../../lib/format';
import { uniqueIds } from '../../../lib/recordTypes';
import { useWorkspaceRevision } from '../../../hooks/useRevision';
import { EmptyState } from '../../EmptyState/EmptyState';
import styles from './HistoryTab.module.css';

interface HistoryTabProps {
  releaseId: string;
  currentDecision: Decision | null;
  onOpenInspector: (type: string, id: string) => void;
}

export function HistoryTab({ releaseId, currentDecision, onOpenInspector }: HistoryTabProps) {
  const [entries, setEntries] = useState<ReleaseHistoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const workspaceRevision = useWorkspaceRevision();

  useEffect(() => {
    getReleaseHistory(releaseId)
      .then((res) => setEntries(res.data))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [releaseId, workspaceRevision]);

  if (loading) {
    return <div className={styles.loading}>Loading history...</div>;
  }

  if (entries.length === 0) {
    return <EmptyState message="No decisions recorded for this release yet." />;
  }

  const supersessionMap = new Map<string, string>();
  entries.forEach((entry) => {
    if (entry.replacesDecisionId) {
      supersessionMap.set(entry.replacesDecisionId, entry.decisionId);
    }
  });

  return (
    <div className={styles.container}>
      <h2 className={styles.title}>Decision history</h2>

      <div className={styles.timeline}>
        {entries.map((entry, index) => {
          const isCurrent = index === 0 && currentDecision?.id === entry.decisionId;
          const replacedBy = supersessionMap.get(entry.decisionId);
          const replaces = entry.replacesDecisionId;
          const isExpanded = expanded.has(entry.decisionId);

          return (
            <div key={entry.decisionId} className={styles.decisionRow}>
              <div className={styles.rail}>
                <div className={`${styles.railLine} ${index < entries.length - 1 ? styles.railLineActive : ''}`} />
              </div>

              <div
                className={`${styles.decisionCard} ${isCurrent ? styles.current : styles.ghost}`}
                data-testid={`decision-card-${entry.decisionId}`}
              >
                <div className={styles.decisionHeader}>
                  <StatusMark
                    status={entry.status}
                    variant={isCurrent ? 'current' : 'historical'}
                    historicalRef={isCurrent ? undefined : entry.evaluatedWorkspaceRevision}
                    showLabel={true}
                  />
                  {!isCurrent && (
                    <span className={styles.historicalLabel}>Historical decision, not current</span>
                  )}
                </div>

                <div className={styles.decisionMeta}>
                  {entry.revisionNumber != null && (
                    <span className={styles.revision}>Release revision {entry.revisionNumber}</span>
                  )}
                  <span className={styles.revision}>Workspace revision {entry.evaluatedWorkspaceRevision}</span>
                  <span className={styles.policy}>Policy {entry.policyVersion}</span>
                  <span className={styles.time}>{formatTimestamp(entry.evaluatedAt)}</span>
                </div>

                <div className={styles.reasonCodes}>
                  <span className={styles.reasonCodesLabel}>Reason codes:</span>
                  {entry.reasonCodes.map((code) => (
                    <span key={code} className={styles.reasonCode}>{code}</span>
                  ))}
                </div>

                {entry.explanation && (
                  <p className={styles.explanation}>{entry.explanation}</p>
                )}

                <div className={styles.supporting}>
                  <span className={styles.supportingLabel}>Supported by:</span>
                  {uniqueIds(entry.supportedByEvidenceIds).map((id) => (
                    <RecordRef
                      key={id}
                      type="Evidence"
                      id={id}
                      onClick={() => onOpenInspector('Evidence', id)}
                    />
                  ))}
                </div>

                {(replacedBy || replaces) && (
                  <div className={styles.supersession}>
                    {replacedBy && (
                      <span className={styles.replacedBy}>
                        Replaced by <RecordRef type="Decision" id={replacedBy} onClick={() => onOpenInspector('Decision', replacedBy)} />
                      </span>
                    )}
                    {replaces && (
                      <span className={styles.replaces}>
                        Replaces <RecordRef type="Decision" id={replaces} onClick={() => onOpenInspector('Decision', replaces)} />
                      </span>
                    )}
                  </div>
                )}

                <button
                  className={styles.expandButton}
                  onClick={() => {
                    const next = new Set(expanded);
                    if (isExpanded) next.delete(entry.decisionId);
                    else next.add(entry.decisionId);
                    setExpanded(next);
                  }}
                  aria-expanded={isExpanded}
                >
                  {isExpanded ? 'Hide evidence path' : 'Show evidence path'}
                </button>

                {isExpanded && (
                  <div className={styles.evidencePath}>
                    {entry.supportedByEvidenceIds.length === 0 && (
                      <p className={styles.pathItem}>No supporting evidence recorded for this decision.</p>
                    )}
                    {uniqueIds(entry.supportedByEvidenceIds).map((id) => (
                      <p key={id} className={styles.pathItem}>
                        <RecordRef
                          type="Decision"
                          id={entry.decisionId}
                          onClick={() => onOpenInspector('Decision', entry.decisionId)}
                        />{' '}
                        was supported by{' '}
                        <RecordRef
                          type="Evidence"
                          id={id}
                          onClick={() => onOpenInspector('Evidence', id)}
                        />.
                      </p>
                    ))}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}