import styles from './EmptyState.module.css';

export function EmptyState({ message, action }: { message: string; action?: React.ReactNode }) {
  return (
    <div className={styles.empty} role="status" aria-live="polite">
      <p className={styles.message}>{message}</p>
      {action && <div className={styles.action}>{action}</div>}
    </div>
  );
}