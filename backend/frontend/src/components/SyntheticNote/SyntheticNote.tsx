import styles from './SyntheticNote.module.css';

export function SyntheticNote() {
  return (
    <span className={styles.note} aria-label="Synthetic test evidence; no CI test was executed by AFTERIMAGE">
      Synthetic test evidence; no CI test was executed by AFTERIMAGE.
    </span>
  );
}