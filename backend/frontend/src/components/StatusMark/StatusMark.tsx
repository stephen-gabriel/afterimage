import styles from './StatusMark.module.css';
import type { StatusMarkProps } from './types';

const statusConfigs: Record<string, { shape: 'circle' | 'square'; glyph: 'check' | 'half' | 'cross'; label: string }> = {
  APPROVED: { shape: 'circle', glyph: 'check', label: 'Approved' },
  NEEDS_REVIEW: { shape: 'circle', glyph: 'half', label: 'Needs review' },
  BLOCKED: { shape: 'square', glyph: 'cross', label: 'Blocked' },
};

export function StatusMark({
  status,
  size = 'medium',
  variant = 'current',
  showLabel = true,
  historicalRef,
  'data-testid': testId,
}: StatusMarkProps) {
  const config = statusConfigs[status] ?? { shape: 'circle', glyph: 'check', label: status };
  const isHistorical = variant === 'historical';
  const isPending = variant === 'pending';

  return (
    <span
      className={`${styles.statusMark} ${styles[size]} ${isHistorical ? styles.historical : ''} ${isPending ? styles.pending : ''}`}
      data-testid={testId}
      role="img"
      aria-label={isHistorical ? `${config.label} at revision ${historicalRef} · not current` : config.label}
    >
      <svg className={styles.svg} viewBox="0 0 24 24" aria-hidden="true">
        {config.shape === 'circle' && (
          <>
            {config.glyph === 'check' && (
              <circle cx="12" cy="12" r="10" className={styles.circleFill} />
            )}
            {config.glyph === 'half' && (
              <>
                <circle cx="12" cy="12" r="10" className={styles.circleStroke} />
                <path d="M12 2 A10 10 0 0 1 12 22 L12 2 Z" className={styles.halfFill} />
              </>
            )}
          </>
        )}
        {config.shape === 'square' && (
          <>
            <rect x="4" y="4" width="16" height="16" rx="2" className={styles.squareFill} />
            {config.glyph === 'cross' && (
              <path d="M8 8 L16 16 M16 8 L8 16" className={styles.cross} />
            )}
          </>
        )}
        {isHistorical && (
          <>
            {config.shape === 'circle' ? (
              <circle cx="12" cy="12" r="10" className={styles.historicalCircle} />
            ) : (
              <rect x="4" y="4" width="16" height="16" rx="2" className={styles.historicalSquare} />
            )}
          </>
        )}
      </svg>
      {showLabel && (
        <span className={`${styles.label} ${isHistorical ? styles.historicalLabel : ''}`}>
          {isHistorical ? `${config.label} at revision ${historicalRef} · not current` : config.label}
        </span>
      )}
      {isPending && <span className={styles.pendingOverlay} aria-hidden="true" />}
    </span>
  );
}