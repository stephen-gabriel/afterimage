import { useState, useEffect, useRef, type KeyboardEvent } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { getRelease, postRun, getRun, listRuns, applyProposal, RevisionStore } from '../../api/client';
import type { ReleaseDetail as ReleaseDetailType, RunDetail } from '../../api/types';
import { useWorkspaceRevision } from '../../hooks/useRevision';
import { StatusTab } from './StatusTab/StatusTab';
import { InvestigationTab } from './InvestigationTab/InvestigationTab';
import { HistoryTab } from './HistoryTab/HistoryTab';
import { ConnectionsTab } from './ConnectionsTab/ConnectionsTab';
import { EmptyState } from '../EmptyState/EmptyState';
import { ErrorPanel } from '../ErrorPanel/ErrorPanel';
import { getStatusLabel } from '../../lib/format';
import styles from './ReleaseDetail.module.css';

type Tab = 'status' | 'investigation' | 'history' | 'connections';
const TAB_ORDER: Tab[] = ['status', 'investigation', 'history', 'connections'];

export function ReleaseDetail() {
  const { releaseId } = useParams<{ releaseId: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({});

  const tab = (searchParams.get('tab') as Tab) || 'status';
  const runId = searchParams.get('run');

  const [release, setRelease] = useState<ReleaseDetailType | null>(null);
  const [run, setRun] = useState<RunDetail | null>(null);
  const [runLoaded, setRunLoaded] = useState(false);
  const [discoveringRuns, setDiscoveringRuns] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<any>(null);
  const [isPolling, setIsPolling] = useState(false);
  const workspaceRevision = useWorkspaceRevision();

  const proposals = run?.proposals ?? [];

  useEffect(() => {
    if (!releaseId) return;
    setLoading(true);
    getRelease(releaseId)
      .then((res) => {
        setRelease(res.data);
        RevisionStore.set(res.meta.workspaceRevision);
      })
      .catch(setError)
      .finally(() => setLoading(false));
  }, [releaseId, workspaceRevision]);

  // P2 run discovery: a fresh visit to the Investigation tab without a run
  // parameter resolves the newest run from server state before rendering.
  useEffect(() => {
    if (tab !== 'investigation' || runId || !releaseId) return;
    let cancelled = false;
    setDiscoveringRuns(true);
    listRuns(releaseId)
      .then((res) => {
        if (cancelled) return;
        const latest = res.data.runs[0];
        if (latest) {
          setSearchParams((prev: URLSearchParams) => {
            const next = new URLSearchParams(prev);
            next.set('run', latest.runId);
            return next;
          });
        }
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setDiscoveringRuns(false);
      });
    return () => {
      cancelled = true;
    };
  }, [tab, runId, releaseId, setSearchParams]);

  useEffect(() => {
    if (!runId) {
      setRun(null);
      setRunLoaded(false);
      setIsPolling(false);
      return;
    }

    let cancelled = false;
    getRun(runId)
      .then((res) => {
        if (cancelled) return;
        setRun(res.data);
        setIsPolling(res.data.status === 'QUEUED' || res.data.status === 'RUNNING');
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setRunLoaded(true);
      });

    return () => {
      cancelled = true;
    };
  }, [runId]);

  useEffect(() => {
    if (!isPolling || !runId) return;

    const interval = setInterval(() => {
      if (document.hidden) return;
      getRun(runId)
        .then((res) => {
          setRun(res.data);
          if (res.data.status !== 'QUEUED' && res.data.status !== 'RUNNING') {
            setIsPolling(false);
          }
        })
        .catch(() => {});
    }, 1500);

    return () => clearInterval(interval);
  }, [isPolling, runId]);

  const handleInvestigate = async () => {
    if (!releaseId || !release) return;
    try {
      const expectedRevision = RevisionStore.get();
      const res = await postRun(releaseId, expectedRevision);
      setSearchParams((prev: URLSearchParams) => {
        const next = new URLSearchParams(prev);
        next.set('run', res.data.runId);
        next.set('tab', 'investigation');
        return next;
      });
    } catch (e) {
      setError(e);
    }
  };

  const handleApplyProposal = async (proposalId: string) => {
    try {
      const expectedRevision = RevisionStore.get();
      const idempotencyKey = crypto.randomUUID();
      await applyProposal(proposalId, expectedRevision, idempotencyKey);
      // Refetch run (server marks sibling proposals STALE) and release.
      if (runId) {
        getRun(runId).then((res) => setRun(res.data)).catch(() => {});
      }
      getRelease(releaseId!).then((res) => setRelease(res.data)).catch(() => {});
    } catch (e) {
      setError(e);
    }
  };

  const handleRunAgain = () => {
    handleInvestigate();
  };

  const openInspector = (_type: string, id: string) => {
    setSearchParams((prev: URLSearchParams) => {
      const next = new URLSearchParams(prev);
      next.set('inspect', id);
      // AppShell mounts RecordInspector; scope evidence to this release revision.
      if (release) next.set('inspectRev', release.revision.id);
      return next;
    });
  };

  const setTab = (newTab: Tab) => {
    setSearchParams((prev: URLSearchParams) => {
      const next = new URLSearchParams(prev);
      next.set('tab', newTab);
      return next;
    });
  };

  // WAI-ARIA tabs pattern: arrow keys, Home and End move between tabs.
  const handleTabKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const currentIndex = TAB_ORDER.indexOf(tab);
    let nextIndex: number | null = null;
    if (event.key === 'ArrowRight') nextIndex = (currentIndex + 1) % TAB_ORDER.length;
    else if (event.key === 'ArrowLeft') nextIndex = (currentIndex - 1 + TAB_ORDER.length) % TAB_ORDER.length;
    else if (event.key === 'Home') nextIndex = 0;
    else if (event.key === 'End') nextIndex = TAB_ORDER.length - 1;
    if (nextIndex === null) return;
    event.preventDefault();
    const nextTab = TAB_ORDER[nextIndex];
    setTab(nextTab);
    tabRefs.current[nextTab]?.focus();
  };

  if (loading) {
    return <div className={styles.loading}>Loading release...</div>;
  }

  if (error) {
    return <ErrorPanel error={error} onRetry={() => window.location.reload()} />;
  }

  if (!release) {
    return <EmptyState message="Release not found." />;
  }

  return (
    <div className={styles.container}>
      <header className={styles.header}>
        <h1 className={styles.releaseName}>{release.name}</h1>
        <div className={styles.headerMeta}>
          <span className={styles.revisionNumber}>Revision {release.revision.revisionNumber}</span>
          <span className={styles.statusLabel}>{getStatusLabel(release.status)}</span>
          {release.evaluationPending && <span className={styles.pendingLabel}>Re-evaluation pending</span>}
        </div>
      </header>

      <nav
        className={styles.tabs}
        role="tablist"
        aria-label="Release sections"
        onKeyDown={handleTabKeyDown}
      >
        {TAB_ORDER.map((t) => (
          <button
            key={t}
            ref={(el) => {
              tabRefs.current[t] = el;
            }}
            role="tab"
            id={`tab-${t}`}
            aria-selected={tab === t}
            aria-controls={`panel-${t}`}
            tabIndex={tab === t ? 0 : -1}
            className={`${styles.tab} ${tab === t ? styles.active : ''}`}
            onClick={() => setTab(t)}
            data-testid={t === 'investigation' ? 'investigation-tab' : undefined}
          >
            {t === 'status' && 'Status'}
            {t === 'investigation' && 'Investigation'}
            {t === 'history' && 'History'}
            {t === 'connections' && 'Connections'}
            {t === 'investigation' && runId && <span className={styles.tabBadge} aria-hidden="true">●</span>}
          </button>
        ))}
      </nav>

      <div
        className={styles.tabContent}
        role="tabpanel"
        id={`panel-${tab}`}
        aria-labelledby={`tab-${tab}`}
        tabIndex={0}
      >
        {tab === 'status' && (
          <StatusTab
            release={release}
            latestHistoricalDecision={release.latestHistoricalDecision}
            onInvestigate={handleInvestigate}
            onOpenInspector={openInspector}
          />
        )}

        {tab === 'investigation' && (
          <InvestigationTab
            run={run}
            loading={discoveringRuns || (Boolean(runId) && !runLoaded)}
            onRunAgain={handleRunAgain}
            onApplyProposal={handleApplyProposal}
            proposals={proposals}
            onOpenInspector={openInspector}
          />
        )}

        {tab === 'history' && (
          <HistoryTab
            releaseId={releaseId!}
            currentDecision={release.currentDecision}
            onOpenInspector={openInspector}
          />
        )}

        {tab === 'connections' && (
          <ConnectionsTab
            releaseId={releaseId!}
            onOpenInspector={openInspector}
          />
        )}
      </div>
    </div>
  );
}