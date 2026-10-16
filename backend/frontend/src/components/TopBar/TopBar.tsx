import { useWorkspaceRevision } from '../../hooks/useRevision';
import { SystemStatus } from '../SystemStatus/SystemStatus';
import { Button } from '../Button/Button';
import styles from './TopBar.module.css';

interface TopBarProps {
  onRecordChange?: () => void;
}

export function TopBar({ onRecordChange }: TopBarProps) {
  const revision = useWorkspaceRevision();

  return (
    <header className={styles.bar}>
      <a href="/" className={styles.wordmark}>Afterimage</a>

      <div className={styles.revision}>
        <span className={styles.revisionLabel}>Workspace revision</span>
        <span className={styles.revisionNumber}>{revision}</span>
      </div>

      <div className={styles.syntheticPill} role="status">
        Synthetic data. No tests are run.
      </div>

      <SystemStatus />

      {onRecordChange && (
        <Button onClick={onRecordChange} variant="primary" size="small">
          Record a change
        </Button>
      )}
    </header>
  );
}