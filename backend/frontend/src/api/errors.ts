import type { UiError } from './client';

export function getErrorMessage(error: UiError): string {
  switch (error.code) {
    case 'VALIDATION_ERROR':
      return error.message;
    case 'NOT_FOUND':
      return 'This record doesn\'t exist in the current workspace';
    case 'STALE_REVISION':
      return 'Records changed since this action was initiated';
    case 'DUPLICATE_KEY_CONFLICT':
      return 'This request key was already used with different contents. Review the form and submit again.';
    case 'DB_UNAVAILABLE':
      return 'The database isn\'t reachable. AFTERIMAGE needs it for every view and won\'t show stored records it can\'t verify.';
    case 'MODEL_UNAVAILABLE':
      return `The agent isn't available: ${error.message}. Records, history and events still work.`;
    case 'QUOTA_EXCEEDED':
      return 'The provider rejected this investigation because of quota limits.';
    case 'RUN_FAILED':
      return `Investigation failed: ${error.message}`;
    case 'VALIDATION_FAILED':
      return `Proposal validation failed: ${error.message}`;
    case 'RESULT_TRUNCATED':
      return 'This result is incomplete. AFTERIMAGE doesn\'t show an approval based on incomplete context.';
    default:
      return error.message || 'Something went wrong on the server';
  }
}

export function getErrorAction(error: UiError): { label: string; action: () => void } | null {
  if (error.retryable) {
    return { label: 'Retry', action: () => window.location.reload() };
  }
  return null;
}

export function isBlockingError(error: UiError): boolean {
  return error.code === 'DB_UNAVAILABLE' || error.status === 503;
}

export function isOfflineError(error: UiError): boolean {
  return error.code === 'NETWORK_ERROR' || !navigator.onLine;
}