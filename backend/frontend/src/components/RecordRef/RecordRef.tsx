import styles from './RecordRef.module.css';
import { RecordRefProps } from './types';
import { StatusMark } from '../StatusMark/StatusMark';

export function RecordRef({
  type,
  id,
  label,
  title,
  domainStatus,
  onClick,
  cited = false,
  'data-testid': testId,
}: RecordRefProps) {
  const typeLabel = label || type;
  // Show a short human-readable title when the server provided one; the full
  // ID remains the accessible name and tooltip (inspector holds full detail).
  const displayText = title ? `${typeLabel}: ${title}` : `${typeLabel} ${id}`;

  return (
    <button
      type="button"
      className={`${styles.recordRef} ${cited ? styles.cited : ''}`}
      onClick={onClick}
      data-testid={testId}
      title={id}
      aria-label={`${typeLabel} ${id}${title ? `, ${title}` : ''}, opens inspector`}
    >
      <span className={styles.typeGlyph} aria-hidden="true">{getTypeGlyph(type)}</span>
      <span className={styles.idText}>{displayText}</span>
      {domainStatus && <StatusMark status={domainStatus} size="small" />}
    </button>
  );
}

function getTypeGlyph(type: string): string {
  const glyphs: Record<string, string> = {
    Release: '📦',
    Revision: '🔢',
    DependencyVersion: '📚',
    Requirement: '✅',
    Evidence: '📄',
    Source: '🔗',
    Decision: '⚖️',
    AgentRun: '🔍',
    Proposal: '📝',
    ReviewTask: '📋',
    Event: '🕒',
    Record: '📎',
  };
  return glyphs[type] ?? '📎';
}