import { useState, useEffect, useCallback } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import type { Task } from '../../api/types';
import { listTasks, getReleases } from '../../api/client';
import { RecordRef } from '../RecordRef/RecordRef';
import { StatusMark } from '../StatusMark/StatusMark';
import { formatTimestamp, getStatusLabel } from '../../lib/format';
import { EmptyState } from '../EmptyState/EmptyState';
import styles from './RequestsPage.module.css';

export function RequestsPage() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [filterRelease, setFilterRelease] = useState<string>('');
  const [releases, setReleases] = useState<Array<{ id: string; name: string }>>([]);
  const [, setSearchParams] = useSearchParams();

  // AppShell mounts RecordInspector from ?inspect=&inspectRev=.
  // Evidence opens retain the task's revision for applicability.
  const openInspector = useCallback(
    (id: string, revisionId?: string) => {
      setSearchParams((prev: URLSearchParams) => {
        const next = new URLSearchParams(prev);
        next.set('inspect', id);
        if (revisionId) next.set('inspectRev', revisionId);
        else next.delete('inspectRev');
        return next;
      });
    },
    [setSearchParams]
  );

  useEffect(() => {
    Promise.all([
      listTasks(),
      getReleases(),
    ])
      .then(([tasksRes, releasesRes]) => {
        setTasks(tasksRes.data);
        setReleases(releasesRes.data.map(r => ({ id: r.id, name: r.name })));
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const releaseName = (id: string) => releases.find(r => r.id === id)?.name || id;
  const filteredTasks = filterRelease
    ? tasks.filter(t => t.releaseId === filterRelease)
    : tasks;

  const openTasks = filteredTasks.filter(t => t.status === 'OPEN');
  const resolvedTasks = filteredTasks.filter(t => t.status === 'RESOLVED');

  if (loading) {
    return <div className={styles.loading}>Loading requests...</div>;
  }

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <h1 className={styles.title}>Requests</h1>
        <div className={styles.filter}>
          <label htmlFor="release-filter" className={styles.filterLabel}>Filter by release:</label>
          <select
            id="release-filter"
            value={filterRelease}
            onChange={(e) => setFilterRelease(e.target.value)}
            className={styles.filterSelect}
          >
            <option value="">All releases</option>
            {releases.map(r => (
              <option key={r.id} value={r.id}>{r.name}</option>
            ))}
          </select>
        </div>
      </div>

      <p className={styles.note}>
        Requests are resolved by applying an agent proposal after matching evidence is recorded.
      </p>

      <section className={styles.group}>
        <h2 className={styles.groupTitle}>Open requests ({openTasks.length})</h2>
        {openTasks.length === 0 ? (
          <EmptyState message="No open evidence requests. When an investigation finds missing evidence, the proposal to request it appears under that release's Investigation tab." />
        ) : (
          <div className={styles.taskList}>
            {openTasks.map(task => (
              <TaskCard key={task.id} task={task} releaseName={releaseName(task.releaseId)} onOpenInspector={openInspector} />
            ))}
          </div>
        )}
      </section>

      <section className={styles.group}>
        <h2 className={styles.groupTitle}>Resolved requests ({resolvedTasks.length})</h2>
        {resolvedTasks.length === 0 ? (
          <p className={styles.emptyResolved}>No resolved requests yet.</p>
        ) : (
          <div className={styles.taskList}>
            {resolvedTasks.map(task => (
              <TaskCard key={task.id} task={task} releaseName={releaseName(task.releaseId)} onOpenInspector={openInspector} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function TaskCard({
  task,
  releaseName,
  onOpenInspector,
}: {
  task: Task;
  releaseName: string;
  onOpenInspector: (id: string, revisionId?: string) => void;
}) {
  const createdByProposalId = task.createdByProposalId;
  const resolvedByProposalId = task.resolvedByProposalId;
  const resolvedByDecisionId = task.resolvedByDecisionId;

  return (
    <div className={styles.taskCard} data-testid={`task-card-${task.id}`}>
      <div className={styles.taskHeader}>
        <StatusMark
          status={task.status === 'OPEN' ? 'NEEDS_REVIEW' : 'APPROVED'}
          size="small"
          showLabel={false}
        />
        <span className={styles.taskStatus}>{getStatusLabel(task.status)}</span>
        <span className={styles.taskScope}>
          <strong>{task.checkKind}</strong>
          {' · '}{releaseName}
          {' · '}revision {task.revisionNumber}
        </span>
      </div>

      <p className={styles.taskDescription}>{task.description}</p>

      <div className={styles.taskMeta}>
        <span>
          Release:{' '}
          <RecordRef
            type="Release"
            id={task.releaseId}
            title={releaseName !== task.releaseId ? releaseName : undefined}
            data-testid={`task-release-ref-${task.id}`}
            onClick={() => onOpenInspector(task.releaseId)}
          />
        </span>
        <span>
          Requirement:{' '}
          <RecordRef
            type="Requirement"
            id={task.requirementId}
            data-testid={`task-requirement-ref-${task.id}`}
            onClick={() => onOpenInspector(task.requirementId)}
          />
        </span>
        <span>Revision: {task.revisionNumber}</span>
        <span>Check: {task.checkKind}</span>
      </div>

      <div className={styles.taskTimestamps}>
        <span>Created: {formatTimestamp(task.createdAt)}</span>
        {task.resolvedAt && (
          <span>Resolved: {formatTimestamp(task.resolvedAt)}</span>
        )}
      </div>

      {createdByProposalId && (
        <div className={styles.taskProposal}>
          Created by proposal:{' '}
          <RecordRef
            type="Proposal"
            id={createdByProposalId}
            data-testid={`task-create-proposal-ref-${task.id}`}
            onClick={() => onOpenInspector(createdByProposalId)}
          />
        </div>
      )}

      {resolvedByProposalId && (
        <div className={styles.taskResolution}>
          <h3 className={styles.resolutionTitle}>How it was resolved</h3>
          <p>
            Resolved by proposal:{' '}
            <RecordRef
              type="Proposal"
              id={resolvedByProposalId}
              data-testid={`task-resolve-proposal-ref-${task.id}`}
              onClick={() => onOpenInspector(resolvedByProposalId)}
            />
          </p>
          {task.resolvedByEvidenceIds.length > 0 && (
            <p>
              Resolved by evidence:
              {task.resolvedByEvidenceIds.map(id => (
                <RecordRef
                  key={id}
                  type="Evidence"
                  id={id}
                  data-testid={`task-evidence-ref-${task.id}`}
                  onClick={() => onOpenInspector(id, task.revisionId)}
                />
              ))}
            </p>
          )}
          {resolvedByDecisionId && (
            <p>
              Decision:{' '}
              <RecordRef
                type="Decision"
                id={resolvedByDecisionId}
                data-testid={`task-decision-ref-${task.id}`}
                onClick={() => onOpenInspector(resolvedByDecisionId)}
              />
            </p>
          )}
          {!resolvedByDecisionId && (
            <p className={styles.noDecisionNote} data-testid={`task-no-decision-note-${task.id}`}>
              No decision had assessed this revision when the request was resolved; evidence resolved it directly.
            </p>
          )}
        </div>
      )}

      {task.status === 'OPEN' && (
        <Link
          to={`/releases/${task.releaseId}`}
          className={styles.investigateLink}
          data-testid={`task-investigate-link-${task.id}`}
        >
          Open {releaseName} to investigate
        </Link>
      )}
    </div>
  );
}