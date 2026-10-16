import { Link, useLocation } from 'react-router-dom';
import { useState, useEffect } from 'react';
import { getReleases } from '../../api/client';
import type { ReleaseSummary } from '../../api/types';
import { StatusMark } from '../StatusMark/StatusMark';
import { useWorkspaceRevision } from '../../hooks/useRevision';
import styles from './NavRail.module.css';

export function NavRail() {
  const location = useLocation();
  const [releases, setReleases] = useState<ReleaseSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const workspaceRevision = useWorkspaceRevision();

  useEffect(() => {
    getReleases()
      .then((res) => setReleases(res.data))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [workspaceRevision]);

  return (
    <nav className={styles.rail} aria-label="Releases and requests">
      <ul className={styles.list}>
        {releases.map((release) => {
          const isActive = location.pathname === `/releases/${release.id}`;
          return (
            <li key={release.id}>
              <Link
                to={`/releases/${release.id}`}
                className={`${styles.releaseRow} ${isActive ? styles.active : ''}`}
                aria-current={isActive ? 'page' : undefined}
                data-testid={`release-row-${release.id}`}
              >
                <StatusMark
                  status={release.status}
                  size="small"
                  variant={release.evaluationPending ? 'pending' : 'current'}
                  showLabel={true}
                />
                <div className={styles.releaseInfo}>
                  <span className={styles.releaseName}>{release.name}</span>
                  <span className={styles.releaseMeta}>
                    rev {release.currentRevisionNumber}
                    {release.evaluationPending && ' · Re-evaluation pending'}
                  </span>
                </div>
              </Link>
            </li>
          );
        })}
        {loading && <li className={styles.loading}>Loading releases...</li>}
      </ul>

      <div className={styles.footer}>
        <Link
          to="/requests"
          className={`${styles.requestsLink} ${location.pathname === '/requests' ? styles.active : ''}`}
          aria-current={location.pathname === '/requests' ? 'page' : undefined}
        >
          Requests
        </Link>
      </div>
    </nav>
  );
}