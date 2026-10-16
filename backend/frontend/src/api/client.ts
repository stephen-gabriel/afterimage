import axios, { AxiosError, AxiosResponse } from 'axios';
import type {
  ApiResponse,
  HealthCheck,
  ReleaseSummary,
  ReleaseDetail,
  ReleaseHistoryEntry,
  ReleaseGraphView,
  Proposal,
  Task,
  RunSummary,
  RunDetail,
  EventPayload,
  EventResult,
  ApplyProposalResult,
  Source,
  RecordDetail,
} from './types';

const API_BASE = import.meta.env.VITE_API_BASE || '/api';

function createApiClient() {
  const client = axios.create({
    baseURL: API_BASE,
    withCredentials: true,
    headers: {
      'Content-Type': 'application/json',
    },
  });

  client.interceptors.response.use(
    (response: AxiosResponse<ApiResponse<unknown>>) => {
      if (response.data?.meta?.workspaceRevision) {
        RevisionStore.set(response.data.meta.workspaceRevision);
      }
      return response;
    },
    (error: AxiosError<ApiResponse<unknown>>) => {
      const normalized: UiError = {
        code: error.response?.data?.error?.code ?? 'UNKNOWN',
        message: error.response?.data?.error?.message ?? error.message,
        retryable: error.response?.data?.error?.retryable ?? false,
        fields: error.response?.data?.error?.fields,
        status: error.response?.status,
      };
      return Promise.reject(normalized);
    }
  );

  return client;
}

export const api = createApiClient();

export interface UiError {
  code: string;
  message: string;
  retryable: boolean;
  fields?: Array<{ path: string; message: string }>;
  status?: number;
}

export function isUiError(error: unknown): error is UiError {
  return typeof error === 'object' && error !== null && 'code' in error && 'message' in error;
}

export function normalizeError(error: unknown): UiError {
  if (isUiError(error)) return error;
  if (error instanceof Error) {
    return { code: 'UNKNOWN', message: error.message, retryable: false };
  }
  return { code: 'UNKNOWN', message: 'An unknown error occurred', retryable: false };
}

class RevisionStoreClass {
  private revision = 0;
  private listeners = new Set<(rev: number) => void>();

  get(): number {
    return this.revision;
  }

  set(rev: number): void {
    if (rev > this.revision) {
      this.revision = rev;
      this.listeners.forEach((fn) => fn(rev));
    }
  }

  subscribe(fn: (rev: number) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}

export const RevisionStore = new RevisionStoreClass();

export async function getHealth(): Promise<ApiResponse<HealthCheck>> {
  const res = await api.get<ApiResponse<HealthCheck>>('/health');
  return res.data;
}

export async function getReleases(): Promise<ApiResponse<ReleaseSummary[]>> {
  const res = await api.get<ApiResponse<ReleaseSummary[]>>('/releases');
  return res.data;
}

export async function getRelease(id: string, revisionId?: string): Promise<ApiResponse<ReleaseDetail>> {
  const url = revisionId ? `/releases/${id}?revisionId=${revisionId}` : `/releases/${id}`;
  const res = await api.get<ApiResponse<ReleaseDetail>>(url);
  return res.data;
}

export async function getReleaseHistory(id: string, cursor?: string): Promise<ApiResponse<ReleaseHistoryEntry[]>> {
  const url = cursor ? `/releases/${id}/history?cursor=${cursor}` : `/releases/${id}/history`;
  const res = await api.get<ApiResponse<{ decisions: ReleaseHistoryEntry[]; nextCursor: string | null }>>(url);
  return { ...res.data, data: res.data.data?.decisions ?? [] };
}

export async function getReleaseGraph(id: string, scope: 'CURRENT' | 'HISTORY' = 'CURRENT'): Promise<ApiResponse<ReleaseGraphView>> {
  const res = await api.get<ApiResponse<ReleaseGraphView>>(`/releases/${id}/graph?scope=${scope}`);
  return res.data;
}

export async function postEvent(payload: EventPayload): Promise<ApiResponse<EventResult>> {
  const res = await api.post<ApiResponse<EventResult>>('/events', payload);
  return res.data;
}

export async function postRun(releaseId: string, expectedRevision: number, eventId?: string): Promise<ApiResponse<RunSummary>> {
  const res = await api.post<ApiResponse<RunSummary>>('/agent/runs', { releaseId, expectedRevision, eventId });
  return res.data;
}

export async function getRun(runId: string): Promise<ApiResponse<RunDetail>> {
  const res = await api.get<ApiResponse<RunDetail>>(`/agent/runs/${runId}`);
  return res.data;
}

export async function listRuns(releaseId?: string, cursor?: string): Promise<ApiResponse<{ runs: RunSummary[]; nextCursor: string | null }>> {
  const params = new URLSearchParams();
  if (releaseId) params.set('releaseId', releaseId);
  if (cursor) params.set('cursor', cursor);
  const res = await api.get<ApiResponse<{ runs: RunSummary[]; nextCursor: string | null }>>(`/agent/runs?${params.toString()}`);
  return res.data;
}

export async function getProposal(proposalId: string): Promise<ApiResponse<Proposal>> {
  const res = await api.get<ApiResponse<Proposal>>(`/proposals/${proposalId}`);
  return res.data;
}

export async function applyProposal(proposalId: string, expectedRevision: number, idempotencyKey: string): Promise<ApiResponse<ApplyProposalResult>> {
  const res = await api.post<ApiResponse<ApplyProposalResult>>(`/proposals/${proposalId}/apply`, { expectedRevision, idempotencyKey });
  return res.data;
}

export async function listTasks(releaseId?: string, status?: string): Promise<ApiResponse<Task[]>> {
  const params = new URLSearchParams();
  if (releaseId) params.set('releaseId', releaseId);
  if (status) params.set('status', status);
  const res = await api.get<ApiResponse<Task[]>>(`/tasks?${params.toString()}`);
  return res.data;
}

export async function getTask(taskId: string): Promise<ApiResponse<Task>> {
  const res = await api.get<ApiResponse<Task>>(`/tasks/${taskId}`);
  return res.data;
}

export async function getSources(): Promise<ApiResponse<Source[]>> {
  const res = await api.get<ApiResponse<Source[]>>('/sources');
  return res.data;
}

export async function getRecord(recordId: string, revisionId?: string): Promise<ApiResponse<RecordDetail>> {
  const url = revisionId ? `/records/${recordId}?revisionId=${revisionId}` : `/records/${recordId}`;
  const res = await api.get<ApiResponse<RecordDetail>>(url);
  return res.data;
}

export function generateIdempotencyKey(): string {
  return crypto.randomUUID();
}