import styles from './ErrorPanel.module.css';
import { Button } from '../Button/Button';
import type { UiError } from '../../api/client';

export function ErrorPanel({ error, onRetry, title }: { error: UiError; onRetry?: () => void; title?: string }) {
  return (
    <div className={styles.panel} role="alert" aria-live="assertive">
      {title && <h3 className={styles.title}>{title}</h3>}
      <p className={styles.message}>{error.message}</p>
      {error.fields && error.fields.length > 0 && (
        <details className={styles.details}>
          <summary>Details</summary>
          <pre className={styles.pre}>{JSON.stringify(error.fields, null, 2)}</pre>
        </details>
      )}
      {onRetry && error.retryable && (
        <Button onClick={onRetry} className={styles.retry} variant="primary">
          Retry
        </Button>
      )}
    </div>
  );
}