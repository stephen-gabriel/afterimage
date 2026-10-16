import styles from './AuthorityTag.module.css';

export function AuthorityTag({ authority }: { authority: 'allowlisted' | 'untrusted' }) {
  const isAllowlisted = authority === 'allowlisted';
  return (
    <span
      className={`${styles.tag} ${isAllowlisted ? styles.allowlisted : styles.untrusted}`}
      aria-label={isAllowlisted ? 'Allowlisted source' : 'Untrusted source'}
    >
      {isAllowlisted ? 'Allowlisted' : 'Untrusted'}
    </span>
  );
}