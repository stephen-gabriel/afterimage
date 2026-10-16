import { config } from '../config';
import type { ModelMessage, ModelResponse } from './model';

export const TEST_DOUBLE_PROVIDER = 'TEST MODEL';
export const TEST_DOUBLE_MODEL = 'deterministic-v1';

export function isTestModelDoubleActive(): boolean {
  const enabled = process.env.AFTERIMAGE_TEST_MODEL_DOUBLE === '1';
  const isolated = config.falkor.graphName !== 'afterimage_workspace';
  return enabled && isolated;
}

export function getModelLabel(): { provider: string; model: string } {
  if (isTestModelDoubleActive()) {
    return { provider: TEST_DOUBLE_PROVIDER, model: TEST_DOUBLE_MODEL };
  }
  return { provider: config.model.provider, model: config.model.model };
}

let callSeq = 0;

function nextCallId(): string {
  callSeq += 1;
  return `double_${callSeq}`;
}

function toolCallResponse(name: string, args: Record<string, unknown>): ModelResponse {
  return {
    choices: [
      {
        finish_reason: 'tool_calls',
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: nextCallId(),
              type: 'function',
              function: { name, arguments: JSON.stringify(args) },
            },
          ],
        },
      },
    ],
  };
}

function stopResponse(content: string): ModelResponse {
  return {
    choices: [
      {
        finish_reason: 'stop',
        message: { role: 'assistant', content },
      },
    ],
  };
}

function parseJsonObject(content: string | null | undefined): any | null {
  if (!content || typeof content !== 'string') return null;
  try {
    return JSON.parse(content);
  } catch {
    return null;
  }
}

function hasToolCall(messages: ModelMessage[], toolName: string): boolean {
  return messages.some((m) => m.tool_calls?.some((tc) => tc.function.name === toolName));
}

function latestToolResult(messages: ModelMessage[], toolName: string): any | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === 'tool' && m.name === toolName) {
      const parsed = parseJsonObject(m.content);
      if (parsed !== null) return parsed;
    }
  }
  return null;
}

function parseInvestigationTarget(messages: ModelMessage[]): { releaseId: string; revisionId: string } | null {
  for (const m of messages) {
    if (m.role !== 'user' || !m.content) continue;
    const match = m.content.match(/Investigate release (\S+) \(revision (\S+)\)/);
    if (match) {
      return { releaseId: match[1], revisionId: match[2] };
    }
  }
  return null;
}

function fallbackCitations(messages: ModelMessage[]): string[] {
  const context = latestToolResult(messages, 'get_release_context');
  if (!context) return [];
  const ids: string[] = [];
  if (Array.isArray(context.evidence)) {
    for (const ev of context.evidence) {
      if (ev && typeof ev.id === 'string') {
        ids.push(ev.id);
        if (ids.length >= 3) break;
      }
    }
  }
  if (ids.length === 0 && context.currentDecision && typeof context.currentDecision.id === 'string') {
    ids.push(context.currentDecision.id);
  }
  return ids;
}

function parseCorrectiveFeedback(content: string): {
  requiredAction: string | null;
  requirementId: string | null;
  citedIds: string[];
  reason: string | null;
} {
  const actionMatch = content.match(/Required action: (\w+)/);
  const reqMatch = content.match(/Affected requirement: (\S+)/);
  const citedMatch = content.match(/Cited IDs from evaluation: (.+)/);
  const reasonMatch = content.match(/Reason: (.+)/);

  const citedRaw = citedMatch ? citedMatch[1].trim() : 'none';
  const citedIds =
    citedRaw === 'none' || citedRaw === ''
      ? []
      : citedRaw
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);

  return {
    requiredAction: actionMatch ? actionMatch[1] : null,
    requirementId: reqMatch && reqMatch[1] !== 'N/A' ? reqMatch[1] : null,
    citedIds,
    reason: reasonMatch ? reasonMatch[1].trim() : null,
  };
}

export async function callModelDouble(
  messages: ModelMessage[],
  _tools: any[],
  _options: any = {}
): Promise<ModelResponse> {
  if (hasToolCall(messages, 'propose_review_action')) {
    return stopResponse(
      'Investigation complete via propose_review_action. TEST MODEL submitted the required proposal for deterministic review.'
    );
  }

  const lastUser = [...messages].reverse().find((m) => m.role === 'user' && m.content);
  if (lastUser && lastUser.content && lastUser.content.startsWith('CORRECTIVE FEEDBACK:')) {
    const parsed = parseCorrectiveFeedback(lastUser.content);
    const target = parseInvestigationTarget(messages);
    if (!parsed.requiredAction || !target) {
      return stopResponse('TEST MODEL: could not parse corrective feedback or investigation target. INSUFFICIENT_EVIDENCE.');
    }
    const citedIds = parsed.citedIds.length > 0 ? parsed.citedIds : fallbackCitations(messages);
    if (citedIds.length === 0) {
      return stopResponse('TEST MODEL: no citable evidence or decision available. INSUFFICIENT_EVIDENCE.');
    }
    return toolCallResponse('propose_review_action', {
      actionType: parsed.requiredAction,
      releaseId: target.releaseId,
      revisionId: target.revisionId,
      requirementId: parsed.requirementId,
      citedIds,
      reason: parsed.reason || `TEST MODEL corrective proposal: ${parsed.requiredAction}`,
    });
  }

  const target = parseInvestigationTarget(messages);
  if (!target) {
    return stopResponse('TEST MODEL: could not parse investigation target. INSUFFICIENT_EVIDENCE.');
  }

  if (!hasToolCall(messages, 'get_release_context')) {
    return toolCallResponse('get_release_context', { revisionId: target.revisionId });
  }

  if (!hasToolCall(messages, 'evaluate_release')) {
    return toolCallResponse('evaluate_release', { revisionId: target.revisionId });
  }

  if (hasToolCall(messages, 'propose_review_action')) {
    return stopResponse(
      'Investigation complete via propose_review_action. TEST MODEL submitted the required proposal for deterministic review.'
    );
  }

  const evaluation = latestToolResult(messages, 'evaluate_release');
  if (!evaluation) {
    return stopResponse('TEST MODEL: evaluation unavailable. INSUFFICIENT_EVIDENCE.');
  }

  const citedBase =
    Array.isArray(evaluation.supportedByEvidenceIds) && evaluation.supportedByEvidenceIds.length > 0
      ? evaluation.supportedByEvidenceIds.slice(0, 5)
      : fallbackCitations(messages);

  const missing = Array.isArray(evaluation.requirements)
    ? evaluation.requirements.find((r: any) => r && r.result === 'MISSING')
    : null;

  if (missing) {
    if (citedBase.length === 0) {
      return stopResponse('TEST MODEL: MISSING requirement with no citable records. INSUFFICIENT_EVIDENCE.');
    }
    return toolCallResponse('propose_review_action', {
      actionType: 'CREATE_EVIDENCE_REQUEST',
      releaseId: target.releaseId,
      revisionId: target.revisionId,
      requirementId: missing.requirementId,
      citedIds: citedBase,
      reason: `TEST MODEL: requirement ${missing.requirementId} has no applicable evidence; request evidence.`,
    });
  }

  const reasonCodes: string[] = Array.isArray(evaluation.reasonCodes) ? evaluation.reasonCodes : [];
  const needsReview = evaluation.status === 'NEEDS_REVIEW';
  const revisionMismatchOnly =
    needsReview && reasonCodes.includes('REVISION_MISMATCH') && !reasonCodes.includes('MISSING_EVIDENCE');
  const conflictingOrFailing =
    needsReview &&
    (reasonCodes.includes('CONFLICTING_EVIDENCE') || reasonCodes.includes('APPLICABLE_FAILURE'));

  if (revisionMismatchOnly || conflictingOrFailing) {
    if (citedBase.length === 0) {
      return stopResponse('TEST MODEL: NEEDS_REVIEW with no citable records. INSUFFICIENT_EVIDENCE.');
    }
    return toolCallResponse('propose_review_action', {
      actionType: 'RECORD_REASSESSMENT',
      releaseId: target.releaseId,
      revisionId: target.revisionId,
      requirementId: null,
      citedIds: citedBase,
      reason: `TEST MODEL: NEEDS_REVIEW (${reasonCodes.join(', ')}); record reassessment.`,
    });
  }

  return stopResponse(
    `TEST MODEL investigation complete. Deterministic evaluation status: ${evaluation.status}. No action needed.`
  );
}
