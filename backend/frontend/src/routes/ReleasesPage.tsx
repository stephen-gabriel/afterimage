import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { getReleases, RevisionStore } from '../api/client';
import type { ReleaseSummary } from '../api/types';
import { StatusMark } from '../components/StatusMark/StatusMark';
import { EmptyState } from '../components/EmptyState/EmptyState';
import { ErrorPanel } from '../components/ErrorPanel/ErrorPanel';
import { useWorkspaceRevision } from '../hooks/useRevision';
import styles from './ReleasesPage.module.css';

export function ReleasesPage() {
  const [releases, setReleases] = useState<ReleaseSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<any>(null);
  const workspaceRevision = useWorkspaceRevision();

  useEffect(() => {
    getReleases()
      .then((res) => {
        setReleases(res.data);
        RevisionStore.set(res.meta.workspaceRevision);
      })
      .catch(setError)
      .finally(() => setLoading(false));
  }, [workspaceRevision]);

  if (loading) {
    return (
      <div className={styles.loading}>
        <div className={styles.skeleton}></div>
        <div className={styles.skeleton}></div>
        <div className={styles.skeleton}></div>
      </div>
    );
  }

  if (error) {
    return <ErrorPanel error={error} onRetry={() => window.location.reload()} />;
  }

  if (releases.length === 0) {
    return (
      <EmptyState
        message="No releases in this workspace. The app doesn't seed itself. Follow the seed instructions in the README, then reload."
      />
    );
  }

  return (
    <div className={styles.container}>
      <h1 className={styles.title}>Releases</h1>
      <ul className={styles.list}>
        {releases.map((release) => (
          <li key={release.id}>
            <Link
              to={`/releases/${release.id}`}
              className={styles.releaseRow}
              data-testid={`release-row-${release.id}`}
            >
              <StatusMark
                status={release.status}
                variant={release.evaluationPending ? 'pending' : 'current'}
                showLabel={true}
              />
              <div className={styles.releaseInfo}>
                <span className={styles.releaseName}>{release.name}</span>
                <span className={styles.releaseMeta}>
                  Revision {release.currentRevisionNumber}
                  {release.evaluationPending && ' · Re-evaluation pending'}
                </span>
              </div>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}