import { useState, useEffect, useMemo } from 'react';
import type { ReleaseGraphView, GraphScope } from '../../../api/types';
import { getReleaseGraph } from '../../../api/client';
import { RecordRef } from '../../RecordRef/RecordRef';
import { getRelationshipPhrase } from '../../../lib/phrases';
import { EmptyState } from '../../EmptyState/EmptyState';
import styles from './ConnectionsTab.module.css';

interface ConnectionsTabProps {
  releaseId: string;
  onOpenInspector: (type: string, id: string) => void;
}

export function ConnectionsTab({ releaseId, onOpenInspector }: ConnectionsTabProps) {
  const [scope, setScope] = useState<GraphScope>('CURRENT');
  const [graph, setGraph] = useState<ReleaseGraphView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    getReleaseGraph(releaseId, scope)
      .then((res) => {
        if (!cancelled) setGraph(res.data);
      })
      .catch((e) => {
        if (!cancelled) setError(e?.message || 'Failed to load connections.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [releaseId, scope, reloadKey]);

  const pathSentences = useMemo(() => {
    if (!graph) return [];
    return graph.edges.map((edge) => {
      const sourceNode = graph.nodes.find(n => n.id === edge.source);
      const targetNode = graph.nodes.find(n => n.id === edge.target);
      return {
        sourceId: edge.source,
        targetId: edge.target,
        sourceType: sourceNode?.type ?? 'Record',
        targetType: targetNode?.type ?? 'Record',
        sourceLabel: sourceNode?.label,
        targetLabel: targetNode?.label,
        phrase: getRelationshipPhrase(edge.type),
        type: edge.type,
        historical: edge.historical,
      };
    });
  }, [graph]);

  if (loading) {
    return <div className={styles.loading}>Loading connections...</div>;
  }

  if (error) {
    return (
      <div className={styles.errorPanel} role="alert">
        <p>{error}</p>
        <button
          className={styles.retryButton}
          onClick={() => setReloadKey((k) => k + 1)}
        >
          Retry
        </button>
      </div>
    );
  }

  if (!graph || (graph.nodes.length === 0 && graph.edges.length === 0)) {
    return <EmptyState message="No connections returned for this scope." />;
  }

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <h2 className={styles.title}>Connections</h2>

        <div className={styles.controls}>
          <div className={styles.scopeSelector} role="group" aria-label="Scope">
            <button
              aria-pressed={scope === 'CURRENT'}
              className={`${styles.scopeButton} ${scope === 'CURRENT' ? styles.active : ''}`}
              onClick={() => setScope('CURRENT')}
            >
              Current
            </button>
            <button
              aria-pressed={scope === 'HISTORY'}
              className={`${styles.scopeButton} ${scope === 'HISTORY' ? styles.active : ''}`}
              onClick={() => setScope('HISTORY')}
            >
              History
            </button>
          </div>
        </div>
      </div>

      <div className={styles.factLine}>
        Showing {graph.nodes.length} records and {graph.edges.length} relationships. This is a bounded view.
      </div>

      {graph.truncated && (
        <div className={styles.truncationBanner} role="alert">
          Some connections are omitted; this view alone does not establish approval.
        </div>
      )}

      <div className={styles.paths}>
        {pathSentences.map((sentence, index) => (
          <div key={index} className={`${styles.pathItem} ${sentence.historical ? styles.historicalPath : ''}`}>
            {sentence.historical && (
              <span className={styles.historicalTag} title={sentence.type}>Historical:</span>
            )}
            <span className={styles.pathText}>
              <RecordRef
                type={sentence.sourceType}
                id={sentence.sourceId}
                title={sentence.sourceLabel}
                onClick={() => onOpenInspector(sentence.sourceType, sentence.sourceId)}
              />
              {' '}{sentence.phrase}{' '}
              <RecordRef
                type={sentence.targetType}
                id={sentence.targetId}
                title={sentence.targetLabel}
                onClick={() => onOpenInspector(sentence.targetType, sentence.targetId)}
              />
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}