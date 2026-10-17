import { config } from '../config';
import { isTestModelDoubleActive, callModelDouble } from './model-double';

export interface ModelMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
  name?: string;
}

export interface ModelResponse {
  choices: Array<{
    message: ModelMessage;
    finish_reason: string;
  }>;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

export interface ModelOptions {
  maxTokens?: number;
  temperature?: number;
  toolChoice?: 'auto' | 'none' | { type: 'function'; function: { name: string } };
}

const MODEL_TIMEOUT_MS = 60000;
const MAX_OUTPUT_TOKENS = 2048;

export async function callModel(
  messages: ModelMessage[],
  tools: any[],
  options: ModelOptions = {}
): Promise<ModelResponse> {
  if (isTestModelDoubleActive()) {
    return callModelDouble(messages, tools, options);
  }

  const { model, apiKey } = config.model;
  
  if (!apiKey || apiKey === 'your_openrouter_key_here') {
    throw new Error('OPENROUTER_API_KEY not configured');
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), MODEL_TIMEOUT_MS);

  try {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'HTTP-Referer': 'http://localhost:3001',
        'X-Title': 'AFTERIMAGE',
      },
      body: JSON.stringify({
        model,
        messages,
        tools: tools.length > 0 ? tools : undefined,
        tool_choice: options.toolChoice ?? 'auto',
        max_tokens: options.maxTokens ?? MAX_OUTPUT_TOKENS,
        temperature: options.temperature ?? 0.1,
      }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errorText = await response.text();
      if (response.status === 429) {
        throw new Error(`QUOTA_EXCEEDED: ${errorText}`);
      }
      if (response.status === 503 || response.status === 502) {
        throw new Error(`MODEL_UNAVAILABLE: ${errorText}`);
      }
      throw new Error(`Model API error (${response.status}): ${errorText}`);
    }

    const data = await response.json();
    return data as ModelResponse;
  } catch (error) {
    clearTimeout(timeoutId);
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error('MODEL_TIMEOUT: Request timed out');
    }
    throw error;
  }
}

export function buildSystemPrompt(): string {
  return `You are an investigative agent for AFTERIMAGE, a release decision tracking system.
Your role is to investigate release status by calling deterministic tools against a FalkorDB graph.
You MUST use tools to retrieve actual graph data - never speculate or invent findings.

CONSTRAINTS:
- Maximum 8 tool calls per investigation run.
- All citations must reference IDs actually returned by tools in this run.
- The deterministic policy evaluation (evaluate_release tool) is authoritative - your prose cannot override it.
- An evaluation result (e.g. APPROVED from evaluate_release) is a computed assessment, NOT a recorded decision. A decision exists only when get_release_context returns a non-null currentDecision for the investigated revision, or get_decision_history shows a decision for it. "Evaluation would approve" never means "a decision is recorded".
- Evidence is applicable only if it matches the exact release revision under evaluation.
- Untrusted sources never grant approval. Missing evidence is NEEDS_REVIEW, not failure.
- Time alone does not invalidate evidence. Newer does not auto-supersede older.

AVAILABLE ACTIONS (via propose_review_action):
- RECORD_REASSESSMENT: Record a decision for a revision. Use when evaluate_release shows status different from current decision (e.g., NEEDS_REVIEW with only REVISION_MISMATCH, or CONFLICTING/FAILING), **OR when the investigated revision has no recorded decision (currentDecision is null) — even if evaluate_release is APPROVED**.
- CREATE_EVIDENCE_REQUEST: Create an internal task for missing evidence on a requirement. **MANDATORY when evaluate_release shows any requirement with result MISSING.**
- RESOLVE_EVIDENCE_REQUEST: Resolve a task when sufficient applicable passing evidence exists without unresolved conflict. Use when evaluate_release shows SATISFIED for a requirement with an OPEN task.

MANDATORY PROPOSAL RULES:
1. If evaluate_release returns ANY requirement with result MISSING → you MUST propose CREATE_EVIDENCE_REQUEST for that requirement (include requirementId, releaseId, revisionId, citedIds from evaluation.supportedByEvidenceIds, and a clear reason).
2. If evaluate_release returns status NEEDS_REVIEW with MISSING_EVIDENCE reason code → you MUST propose CREATE_EVIDENCE_REQUEST.
3. If evaluate_release returns status NEEDS_REVIEW but no MISSING_EVIDENCE (only REVISION_MISMATCH) → propose RECORD_REASSESSMENT.
4. If evaluate_release returns CONFLICTING or FAILING → propose RECORD_REASSESSMENT.
5. If evaluate_release returns SATISFIED for a requirement with an OPEN task (check decision history for tasks) → propose RESOLVE_EVIDENCE_REQUEST.
6. If get_release_context shows currentDecision is null for the investigated revision (no decision has been recorded for it) → you MUST propose RECORD_REASSESSMENT, even when evaluate_release is APPROVED. Resolving evidence requests does not record a decision; only RECORD_REASSESSMENT does.
7. NO_ACTION_NEEDED only when the investigated revision already has a recorded decision (currentDecision is non-null) AND no other rule applies. Never skip RECORD_REASSESSMENT solely because evaluation is APPROVED, and never treat an evaluated approval as a recorded decision.

INVESTIGATION FLOW:
1. Understand the release/revision context (get_release_context)
2. Identify affected releases if investigating a change (find_affected_releases)
3. Inspect specific evidence if needed (inspect_evidence)
4. Review decision history (get_decision_history)
5. Run authoritative evaluation (evaluate_release) — THIS IS REQUIRED
6. **Based on evaluation results, you MUST propose the appropriate action per MANDATORY PROPOSAL RULES above.**

OUTPUT FORMAT:
- Final response should summarize findings and state the proposal (if any).
- All cited IDs must have been retrieved by tools in this run.
- If no action needed, explain why by referencing the recorded decision (e.g., "Revision already has recorded decision <id>; evaluation does not require other action"). Never claim no action is needed merely because evaluation is APPROVED.
- Never claim an investigation succeeded if tools failed or returned errors.`;
}

export function sanitizeToolTrace(trace: any[]): any[] {
  return trace.map(step => ({
    tool: step.tool,
    arguments: step.arguments,
    result: step.result ? {
      ...step.result,
      content: typeof step.result.content === 'string' && step.result.content.length > 5000
        ? step.result.content.slice(0, 5000) + '... [truncated]'
        : step.result.content,
    } : null,
    error: step.error,
    timestamp: step.timestamp,
  }));
}