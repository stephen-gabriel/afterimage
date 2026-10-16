import styles from './ScopePanel.module.css';

interface ScopePanelProps {
  eventType: string;
  selections: Record<string, string>;
  releaseName?: string;
  revisionNumber?: number;
}

export function ScopePanel({ eventType, selections, releaseName, revisionNumber }: ScopePanelProps) {
  const label = getScopeLabel(eventType, selections, releaseName, revisionNumber);

  return (
    <div className={styles.panel} role="status" aria-live="polite">
      <span className={styles.icon} aria-hidden="true">ℹ️</span>
      <span className={styles.text}>{label}</span>
    </div>
  );
}

function getScopeLabel(
  eventType: string,
  selections: Record<string, string>,
  releaseName?: string,
  revisionNumber?: number
): string {
  const release = releaseName ? `release ${releaseName}` : 'a release';
  const revision = revisionNumber ? `revision ${revisionNumber}` : 'a revision';

  switch (eventType) {
    case 'DEPENDENCY_CHANGED':
      return `This changes a dependency version for ${release} (${revision}).`;
    case 'TEST_RECORDED':
      return `This records a result for ${selections.requirement || 'a requirement'} on ${revision} of ${release}.`;
    case 'EVIDENCE_WITHDRAWN':
      return `This withdraws evidence for ${selections.evidenceId || 'a record'} on ${revision} of ${release}.`;
    case 'EVIDENCE_SUPERSEDED':
      return `This supersedes evidence for ${selections.oldEvidenceId || 'a record'} on ${revision} of ${release}.`;
    default:
      return `This records a change for ${release}.`;
  }
}