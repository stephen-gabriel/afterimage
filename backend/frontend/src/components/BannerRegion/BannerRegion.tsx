import styles from './BannerRegion.module.css';
import type { UiError } from '../../api/client';

export function BannerRegion({ errors }: { errors: UiError[] }) {
  if (errors.length === 0) return null;

  return (
    <div className={styles.region} aria-live="polite" aria-atomic="true">
      {errors.map((error, index) => (
        <div key={index} className={`${styles.banner} ${getBannerClass(error)}`}>
          <span className={styles.message}>{error.message}</span>
          {error.retryable && (
            <button className={styles.retry} onClick={() => window.location.reload()}>
              Retry
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

function getBannerClass(error: UiError): string {
  if (error.code === 'DB_UNAVAILABLE') return styles.blocking;
  if (error.code === 'QUOTA_EXCEEDED') return styles.quota;
  if (error.code === 'MODEL_UNAVAILABLE') return styles.warning;
  if (error.code === 'RESULT_TRUNCATED') return styles.truncation;
  return styles.error;
}