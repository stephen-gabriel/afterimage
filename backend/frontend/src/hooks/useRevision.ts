import { useEffect, useState } from 'react';
import { RevisionStore } from '../api/client';

export function useWorkspaceRevision(): number {
  const [revision, setRevision] = useState(() => RevisionStore.get());

  useEffect(() => {
    return RevisionStore.subscribe(setRevision);
  }, []);

  return revision;
}

export function useMonotonicRevision(): number {
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    return RevisionStore.subscribe((rev) => {
      setRevision((prev) => Math.max(prev, rev));
    });
  }, []);

  return revision;
}