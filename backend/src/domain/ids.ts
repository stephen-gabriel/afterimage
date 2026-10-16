import { v4 as uuidv4 } from 'uuid';

export function generateId(prefix: string): string {
  return `${prefix}_${uuidv4().replace(/-/g, '').slice(0, 12)}`;
}

export function generateWorkspaceId(): string {
  return generateId('ws');
}

export function generateReleaseId(): string {
  return generateId('rel');
}

export function generateRevisionId(): string {
  return generateId('rev');
}

export function generateDependencyVersionId(): string {
  return generateId('dep');
}

export function generateRequirementId(): string {
  return generateId('req');
}

export function generateEvidenceId(): string {
  return generateId('ev');
}

export function generateSourceId(): string {
  return generateId('src');
}

export function generateDecisionId(): string {
  return generateId('dec');
}

export function generateEventId(): string {
  return generateId('evt');
}

export function generateTaskId(): string {
  return generateId('tsk');
}

export function generateRunId(): string {
  return generateId('run');
}

export function generateProposalId(): string {
  return generateId('prop');
}

export function generateIdempotencyKey(): string {
  return `idem_${uuidv4().replace(/-/g, '')}`;
}

export function nowISO(): string {
  return new Date().toISOString();
}