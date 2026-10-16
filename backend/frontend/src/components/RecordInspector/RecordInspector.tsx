import { useState, useEffect, useRef } from 'react';
import { getRecord } from '../../api/client';
import type { RecordDetail } from '../../api/types';
import { StatusMark } from '../StatusMark/StatusMark';
import { Button } from '../Button/Button';
import { getRelationshipPhrase } from '../../lib/phrases';
import styles from './RecordInspector.module.css';

interface RecordInspectorProps {
  recordId: string;
  revisionId?: string;
  onClose: () => void;
  onOpenInspector?: (type: string, id: string) => void;
}

export function RecordInspector({ recordId, revisionId, onClose, onOpenInspector }: RecordInspectorProps) {
  const [record, setRecord] = useState<RecordDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<any>(null);
  const panelRef = useRef<HTMLElement>(null);
  const previouslyFocused = useRef<Element | null>(null);

  useEffect(() => {
    previouslyFocused.current = document.activeElement;
    setLoading(true);
    setError(null);
    // Revision-scoped applicability: when opened from a release page the
    // current revision id is supplied so the server evaluates applicability.
    getRecord(recordId, revisionId)
      .then((res) => setRecord(res.data))
      .catch(setError)
      .finally(() => {
        setLoading(false);
        panelRef.current?.focus();
      });
    return () => {
      if (previouslyFocused.current instanceof HTMLElement) {
        previouslyFocused.current.focus();
      }
    };
  }, [recordId, revisionId]);

  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  }, [onClose]);

  return (
    <aside
      className={styles.inspector}
      role="dialog"
      aria-modal="true"
      aria-label="Record inspector"
      data-testid="record-inspector"
      ref={panelRef}
      tabIndex={-1}
    >
      <div className={styles.header}>
        <h2 className={styles.title}>Record inspector</h2>
        <Button onClick={onClose} variant="ghost" size="small" aria-label="Close inspector">
          ✕
        </Button>
      </div>

      {loading && <div className={styles.loading}>Loading record...</div>}

      {error && (
        <div className={styles.error} role="alert">
          <p>
            {error.code === 'NOT_FOUND'
              ? "This record doesn't exist in the current workspace."
              : error.message || "Details for this record aren't loaded."}
          </p>
          <p className={styles.errorId}>ID: {recordId}</p>
        </div>
      )}

      {!loading && !error && !record && (
        <div className={styles.error} role="alert">
          <p>No record details to show.</p>
          <p className={styles.errorId}>ID: {recordId}</p>
        </div>
      )}

      {record && (
        <div className={styles.content}>
          <div className={styles.typeLabel}>
            <span className={styles.type}>{record.type}</span>
            {record.domainStatus && (
              <StatusMark status={record.domainStatus} size="small" showLabel={true} />
            )}
          </div>

          <h3 className={styles.recordLabel}>{record.label || record.id}</h3>

          <p className={styles.recordId}>{record.id}</p>

          {record.type === 'Evidence' && (
            <div className={styles.applicabilityBlock}>
              <span
                className={`${styles.applicabilityTag} ${record.applicable ? styles.applicable : styles.notApplicable}`}
              >
                {record.applicable ? 'Applies to this revision' : 'Does not apply'}
              </span>
              {record.evaluatedRevisionId && (
                <span className={styles.evaluationScope}>
                  Evaluated for revision context <span className={styles.mono}>{record.evaluatedRevisionId}</span>
                </span>
              )}
              {typeof record.fields.applicabilityExplanation === 'string' && record.fields.applicabilityExplanation && (
                <span className={styles.evaluationScope}>{record.fields.applicabilityExplanation}</span>
              )}
            </div>
          )}

          <div className={styles.fields}>
            {Object.entries(record.fields).map(([key, value]) => (
              <div key={key} className={styles.field}>
                <span className={styles.fieldKey}>{key}</span>
                <span className={styles.fieldValue}>
                  {value === null || value === undefined
                    ? '—'
                    : typeof value === 'object'
                      ? JSON.stringify(value)
                      : String(value)}
                </span>
              </div>
            ))}
          </div>

          {record.incidentEdges && record.incidentEdges.length > 0 && (
            <div className={styles.edges}>
              <h4 className={styles.edgesTitle}>Connected records</h4>
              {record.incidentEdges.map((edge, index) => (
                <div key={index} className={`${styles.edge} ${edge.historical ? styles.historicalEdge : ''}`}>
                  <span className={styles.edgeType}>
                    {getRelationshipPhrase(edge.type)}
                  </span>
                  {onOpenInspector ? (
                    <button
                      type="button"
                      className={styles.edgeTargetButton}
                      onClick={() => onOpenInspector('Record', edge.targetId)}
                      aria-label={`Record ${edge.targetId}, opens inspector`}
                    >
                      {edge.targetLabel || edge.targetId}
                    </button>
                  ) : (
                    <span className={styles.edgeTarget}>{edge.targetLabel || edge.targetId}</span>
                  )}
                  {edge.historical && <span className={styles.historicalTag}>historical</span>}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </aside>
  );
}
