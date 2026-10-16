import { useEffect, useRef, useCallback } from 'react';

interface PollOptions<T> {
  enabled: boolean;
  interval: number;
  backoffInterval?: number;
  backoffAfter?: number;
  onData: (data: T) => void;
  onError?: (error: Error) => void;
  fetchFn: () => Promise<T>;
}

export function usePolling<T>({
  enabled,
  interval,
  backoffInterval,
  backoffAfter,
  onData,
  onError,
  fetchFn,
}: PollOptions<T>) {
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const startTimeRef = useRef<number>(Date.now());
  const isMountedRef = useRef(true);
  const fetchFnRef = useRef(fetchFn);
  fetchFnRef.current = fetchFn;

  const stop = useCallback(() => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
  }, []);

  const start = useCallback(() => {
    if (!enabled || !isMountedRef.current) return;

    const elapsed = Date.now() - startTimeRef.current;
    const currentInterval = backoffInterval && elapsed > (backoffAfter ?? 60000) ? backoffInterval : interval;

    const tick = async () => {
      if (!enabled || !isMountedRef.current) return;
      try {
        const data = await fetchFnRef.current();
        if (isMountedRef.current) {
          onData(data);
        }
      } catch (error) {
        if (isMountedRef.current && onError) {
          onError(error as Error);
        }
      } finally {
        if (isMountedRef.current && enabled) {
          start();
        }
      }
    };

    timeoutRef.current = setTimeout(tick, currentInterval);
  }, [enabled, interval, backoffInterval, backoffAfter, onData, onError]);

  useEffect(() => {
    isMountedRef.current = true;
    startTimeRef.current = Date.now();
    if (enabled) {
      start();
    }
    return () => {
      isMountedRef.current = false;
      stop();
    };
  }, [enabled, start, stop]);

  return { stop, start };
}

export function useInvestigationPolling(
  runId: string | null,
  enabled: boolean,
  onData: (data: any) => void,
  onError?: (error: Error) => void
) {
  return usePolling({
    enabled: enabled && !!runId,
    interval: 1500,
    backoffInterval: 5000,
    backoffAfter: 60000,
    fetchFn: async () => {
      const res = await fetch(`/api/agent/runs/${runId}`);
      if (!res.ok) throw new Error('Failed to fetch run');
      return res.json();
    },
    onData,
    onError,
  });
}

export function useHealthPolling(
  onData: (data: { database: boolean; agent: boolean; details: string }) => void,
  onError?: (error: Error) => void
) {
  return usePolling({
    enabled: true,
    interval: 30000,
    fetchFn: async () => {
      const res = await fetch('/api/health');
      if (!res.ok) throw new Error('Health check failed');
      return res.json();
    },
    onData,
    onError,
  });
}