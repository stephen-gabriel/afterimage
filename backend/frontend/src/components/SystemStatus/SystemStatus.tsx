import { useState, useEffect } from 'react';
import { getHealth } from '../../api/client';
import type { HealthCheck } from '../../api/types';
import { Button } from '../Button/Button';
import styles from './SystemStatus.module.css';

export function SystemStatus() {
  const [health, setHealth] = useState<HealthCheck | null>(null);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchHealth = async () => {
    try {
      const res = await getHealth();
      setHealth(res.data);
    } catch (e) {
      setError('Health check failed');
    }
  };

  useEffect(() => {
    fetchHealth();
    const interval = setInterval(fetchHealth, 30000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (!open) return;
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  }, [open]);

  if (error) return <span className={styles.error}>System status unavailable</span>;
  if (!health) return <span className={styles.loading}>Loading...</span>;

  return (
    <div className={styles.container}>
      <button
        className={styles.trigger}
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-haspopup="dialog"
      >
        <span className={`${styles.indicator} ${health.database ? styles.ready : styles.notReady}`} aria-hidden="true" />
        <span className={styles.text}>{health.database ? 'DB ready' : 'DB unavailable'}</span>
        <span className={`${styles.indicator} ${health.agent ? styles.ready : styles.notReady}`} aria-hidden="true" />
        <span className={styles.text}>{health.agent ? 'Agent ready' : 'Agent unavailable'}</span>
        {health.testModelDoubleActive && (
          <span className={styles.testDoubleBadge} data-testid="test-model-indicator">
            TEST MODEL · {health.provider}/{health.model}
          </span>
        )}
      </button>
      {open && (
        <div className={styles.popover} role="dialog" aria-label="System status details">
          <p>Database: {health.database ? 'Ready' : 'Not ready'}</p>
          <p>Agent: {health.agent ? 'Ready' : 'Not ready'}</p>
          {health.testModelDoubleActive && (
            <p className={styles.testDoubleDetail}>
              Model double active: {health.provider} / {health.model}. No real model calls are made.
            </p>
          )}
          {health.details && <p className={styles.details}>{health.details}</p>}
          <Button variant="ghost" size="small" onClick={() => { setOpen(false); fetchHealth(); }}>Refresh</Button>
        </div>
      )}
    </div>
  );
}