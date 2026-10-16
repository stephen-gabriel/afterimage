import styles from './Button.module.css';

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'ghost';
  size?: 'small' | 'medium' | 'large';
  loading?: boolean;
}

export function Button({
  children,
  variant = 'primary',
  size = 'medium',
  loading = false,
  disabled,
  className = '',
  ...props
}: ButtonProps) {
  return (
    <button
      type="button"
      className={`${styles.button} ${styles[variant]} ${styles[size]} ${disabled ? styles.disabled : ''} ${loading ? styles.loading : ''} ${className}`}
      disabled={disabled || loading}
      {...props}
    >
      {loading && <span className={styles.spinner} aria-hidden="true" />}
      <span className={styles.content}>{children}</span>
    </button>
  );
}