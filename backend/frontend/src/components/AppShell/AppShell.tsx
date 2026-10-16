import { ReactNode, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { TopBar } from '../TopBar/TopBar';
import { NavRail } from '../NavRail/NavRail';
import { BannerRegion } from '../BannerRegion/BannerRegion';
import { RecordInspector } from '../RecordInspector/RecordInspector';
import type { UiError } from '../../api/client';
import styles from './AppShell.module.css';

interface AppShellProps {
  children: ReactNode;
  errors?: UiError[];
  onRecordChange?: () => void;
}

export function AppShell({ children, errors = [], onRecordChange }: AppShellProps) {
  const [searchParams, setSearchParams] = useSearchParams();
  const inspectId = searchParams.get('inspect');
  const inspectRev = searchParams.get('inspectRev');

  // Shared inspector open/close for every route (release detail, requests, …).
  // `revisionId` scopes evidence applicability to the revision the reference
  // came from. When navigating connected records inside the inspector the
  // existing revision context is retained unless a new one is supplied.
  const openInspector = useCallback(
    (_type: string, id: string, revisionId?: string) => {
      setSearchParams((prev: URLSearchParams) => {
        const next = new URLSearchParams(prev);
        next.set('inspect', id);
        const rev = revisionId ?? next.get('inspectRev');
        if (rev) next.set('inspectRev', rev);
        else next.delete('inspectRev');
        return next;
      });
    },
    [setSearchParams]
  );

  const closeInspector = useCallback(() => {
    setSearchParams((prev: URLSearchParams) => {
      const next = new URLSearchParams(prev);
      next.delete('inspect');
      next.delete('inspectRev');
      return next;
    });
  }, [setSearchParams]);

  return (
    <div className={styles.shell}>
      <a href="#main-content" className="skip-link">Skip to release content</a>

      <TopBar onRecordChange={onRecordChange} />

      <div className={styles.body}>
        <NavRail />

        <main id="main-content" className={styles.main} role="main">
          {children}
        </main>
      </div>

      {inspectId && (
        <RecordInspector
          recordId={inspectId}
          revisionId={inspectRev || undefined}
          onClose={closeInspector}
          onOpenInspector={openInspector}
        />
      )}

      <BannerRegion errors={errors} />
    </div>
  );
}
