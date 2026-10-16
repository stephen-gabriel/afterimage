import { runCypher } from '../graph/client';
import { FIXED_WORKSPACE_ID } from '../seed/fixtures';
import { evaluateReleaseRevision } from '../evaluation/policy';
import { getRevisionContext, findAffectedReleases, getDecisionHistory } from '../query';
import { createProposal } from './proposals';
import { nowISO } from '../domain/ids';

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, any>;
}

export interface ToolResult {
  tool_call_id: string;
  name: string;
  content: string;
  error?: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, any>;
    required: string[];
  };
}

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'get_release_context',
    description: 'Retrieve full context for a release revision including dependencies, requirements, evidence with applicability reasons, and current decision. Use this to understand the current state of a release.',
    parameters: {
      type: 'object',
      properties: {
        revisionId: { type: 'string', description: 'Release revision ID to inspect' },
      },
      required: ['revisionId'],
    },
  },
  {
    name: 'find_affected_releases',
    description: 'Find releases affected by a dependency, requirement, or evidence change. Returns affected release IDs and revision IDs.',
    parameters: {
      type: 'object',
      properties: {
        entityId: { type: 'string', description: 'ID of the dependency, requirement, or evidence entity' },
      },
      required: ['entityId'],
    },
  },
  {
    name: 'inspect_evidence',
    description: 'Inspect a specific evidence record by ID. Returns evidence details, source, outcome, and applicability to revisions.',
    parameters: {
      type: 'object',
      properties: {
        evidenceId: { type: 'string', description: 'Evidence ID to inspect' },
      },
      required: ['evidenceId'],
    },
  },
  {
    name: 'get_decision_history',
    description: 'Get the decision history for a release, including all decisions, their status, reason codes, supporting evidence, and supersession links.',
    parameters: {
      type: 'object',
      properties: {
        releaseId: { type: 'string', description: 'Release ID to get history for' },
      },
      required: ['releaseId'],
    },
  },
  {
    name: 'evaluate_release',
    description: 'Run the deterministic policy evaluation for a release revision. Returns requirement evaluations, overall status, reason codes, and supporting evidence IDs. This is the authoritative evaluation - model prose cannot override it.',
    parameters: {
      type: 'object',
      properties: {
        revisionId: { type: 'string', description: 'Release revision ID to evaluate' },
      },
      required: ['revisionId'],
    },
  },
  {
    name: 'propose_review_action',
    description: 'Propose a review action based on investigation findings. The model uses this to formally submit a proposal after gathering evidence. Actions: RECORD_REASSESSMENT (request re-evaluation), CREATE_EVIDENCE_REQUEST (create internal task for missing evidence), RESOLVE_EVIDENCE_REQUEST (resolve task when evidence is sufficient).',
    parameters: {
      type: 'object',
      properties: {
        actionType: { type: 'string', enum: ['RECORD_REASSESSMENT', 'CREATE_EVIDENCE_REQUEST', 'RESOLVE_EVIDENCE_REQUEST'], description: 'Type of proposal' },
        releaseId: { type: 'string', description: 'Release ID the proposal applies to' },
        revisionId: { type: 'string', description: 'Release revision ID' },
        requirementId: { type: 'string', description: 'Requirement ID (for evidence requests)' },
        citedIds: { type: 'array', items: { type: 'string' }, description: 'Evidence/decision IDs cited as basis for proposal' },
        reason: { type: 'string', description: 'Human-readable reason for the proposal' },
      },
      required: ['actionType', 'releaseId', 'revisionId', 'citedIds', 'reason'],
    },
  },
];

function validateWorkspaceScope(entityId: string, entityType: string): Promise<boolean> {
  return runCypher(
    `MATCH (n {id: $id, workspaceId: $wsId}) WHERE n.type = $type RETURN n.id as id`,
    { id: entityId, wsId: FIXED_WORKSPACE_ID, type: entityType }
  ).then(r => r.data.length > 0);
}

async function checkRevisionInWorkspace(revisionId: string): Promise<boolean> {
  const result = await runCypher(
    `MATCH (rev:ReleaseRevision {id: $revisionId, workspaceId: $wsId}) RETURN rev.id as id`,
    { revisionId, wsId: FIXED_WORKSPACE_ID }
  );
  return result.data.length > 0;
}

async function checkReleaseInWorkspace(releaseId: string): Promise<boolean> {
  const result = await runCypher(
    `MATCH (r:Release {id: $releaseId, workspaceId: $wsId}) RETURN r.id as id`,
    { releaseId, wsId: FIXED_WORKSPACE_ID }
  );
  return result.data.length > 0;
}

async function checkRequirementInWorkspace(requirementId: string): Promise<boolean> {
  const result = await runCypher(
    `MATCH (req:Requirement {id: $requirementId, workspaceId: $wsId}) RETURN req.id as id`,
    { requirementId, wsId: FIXED_WORKSPACE_ID }
  );
  return result.data.length > 0;
}

async function checkEvidenceInWorkspace(evidenceId: string): Promise<boolean> {
  const result = await runCypher(
    `MATCH (ev:Evidence {id: $evidenceId, workspaceId: $wsId}) RETURN ev.id as id`,
    { evidenceId, wsId: FIXED_WORKSPACE_ID }
  );
  return result.data.length > 0;
}

export interface ExecuteToolContext {
  runId: string;
  expectedRevision: number;
}

export async function executeTool(call: ToolCall, ctx?: ExecuteToolContext): Promise<ToolResult> {
  const { id, name, arguments: args } = call;

  try {
    switch (name) {
      case 'get_release_context': {
        const { revisionId } = args;
        if (!revisionId || typeof revisionId !== 'string') {
          return { tool_call_id: id, name, content: '', error: 'revisionId is required and must be a string' };
        }
        if (!(await checkRevisionInWorkspace(revisionId))) {
          return { tool_call_id: id, name, content: '', error: 'Revision not found or not in workspace' };
        }
        const context = await getRevisionContext(revisionId);
        return {
          tool_call_id: id,
          name,
          content: JSON.stringify(context, null, 2),
        };
      }

      case 'find_affected_releases': {
        const { entityId } = args;
        if (!entityId || typeof entityId !== 'string') {
          return { tool_call_id: id, name, content: '', error: 'entityId is required and must be a string' };
        }
        const impact = await findAffectedReleases(entityId);
        return {
          tool_call_id: id,
          name,
          content: JSON.stringify(impact, null, 2),
        };
      }

      case 'inspect_evidence': {
        const { evidenceId } = args;
        if (!evidenceId || typeof evidenceId !== 'string') {
          return { tool_call_id: id, name, content: '', error: 'evidenceId is required and must be a string' };
        }
        if (!(await checkEvidenceInWorkspace(evidenceId))) {
          return { tool_call_id: id, name, content: '', error: 'Evidence not found or not in workspace' };
        }
        const result = await runCypher(
          `MATCH (ev:Evidence {id: $evidenceId, workspaceId: $wsId})
           OPTIONAL MATCH (ev)-[:FROM_SOURCE]->(src:Source)
           OPTIONAL MATCH (ev)-[:SATISFIES_CHECK]->(req:Requirement)
           OPTIONAL MATCH (ev)-[:FOR_REVISION]->(rev:ReleaseRevision)
           OPTIONAL MATCH (ev)-[:SUPERSEDES]->(sup:Evidence)
           OPTIONAL MATCH (old:Evidence)-[:SUPERSEDES]->(ev)
           RETURN ev, src, req, rev, sup, old`,
          { evidenceId, wsId: FIXED_WORKSPACE_ID }
        );
        return {
          tool_call_id: id,
          name,
          content: JSON.stringify(result.data[0] || null, null, 2),
        };
      }

      case 'get_decision_history': {
        const { releaseId } = args;
        if (!releaseId || typeof releaseId !== 'string') {
          return { tool_call_id: id, name, content: '', error: 'releaseId is required and must be a string' };
        }
        if (!(await checkReleaseInWorkspace(releaseId))) {
          return { tool_call_id: id, name, content: '', error: 'Release not found or not in workspace' };
        }
        const history = await getDecisionHistory(releaseId);
        return {
          tool_call_id: id,
          name,
          content: JSON.stringify(history, null, 2),
        };
      }

      case 'evaluate_release': {
        const { revisionId } = args;
        if (!revisionId || typeof revisionId !== 'string') {
          return { tool_call_id: id, name, content: '', error: 'revisionId is required and must be a string' };
        }
        if (!(await checkRevisionInWorkspace(revisionId))) {
          return { tool_call_id: id, name, content: '', error: 'Revision not found or not in workspace' };
        }
        const evaluation = await evaluateReleaseRevision(revisionId);
        return {
          tool_call_id: id,
          name,
          content: JSON.stringify(evaluation, null, 2),
        };
      }

      case 'propose_review_action': {
        const { actionType, releaseId, revisionId, requirementId, citedIds, reason } = args;
        
        if (!actionType || !['RECORD_REASSESSMENT', 'CREATE_EVIDENCE_REQUEST', 'RESOLVE_EVIDENCE_REQUEST'].includes(actionType)) {
          return { tool_call_id: id, name, content: '', error: 'actionType must be RECORD_REASSESSMENT, CREATE_EVIDENCE_REQUEST, or RESOLVE_EVIDENCE_REQUEST' };
        }
        if (!releaseId || typeof releaseId !== 'string') {
          return { tool_call_id: id, name, content: '', error: 'releaseId is required' };
        }
        if (!revisionId || typeof revisionId !== 'string') {
          return { tool_call_id: id, name, content: '', error: 'revisionId is required' };
        }
        if (!citedIds || !Array.isArray(citedIds) || citedIds.length === 0) {
          return { tool_call_id: id, name, content: '', error: 'citedIds must be a non-empty array' };
        }
        if (!reason || typeof reason !== 'string') {
          return { tool_call_id: id, name, content: '', error: 'reason is required' };
        }
        if (actionType !== 'RECORD_REASSESSMENT' && (!requirementId || typeof requirementId !== 'string')) {
          return { tool_call_id: id, name, content: '', error: 'requirementId is required for evidence requests' };
        }
        if (actionType === 'RESOLVE_EVIDENCE_REQUEST' && (!requirementId || typeof requirementId !== 'string')) {
          return { tool_call_id: id, name, content: '', error: 'requirementId is required for RESOLVE_EVIDENCE_REQUEST' };
        }

        if (!(await checkReleaseInWorkspace(releaseId))) {
          return { tool_call_id: id, name, content: '', error: 'Release not found or not in workspace' };
        }
        if (!(await checkRevisionInWorkspace(revisionId))) {
          return { tool_call_id: id, name, content: '', error: 'Revision not found or not in workspace' };
        }
        if (requirementId && !(await checkRequirementInWorkspace(requirementId))) {
          return { tool_call_id: id, name, content: '', error: 'Requirement not found or not in workspace' };
        }

        for (const citedId of citedIds) {
          const isValid = await checkEvidenceInWorkspace(citedId) || 
            await runCypher(`MATCH (d:Decision {id: $id, workspaceId: $wsId}) RETURN d.id as id`, { id: citedId, wsId: FIXED_WORKSPACE_ID }).then(r => r.data.length > 0);
          if (!isValid) {
            return { tool_call_id: id, name, content: '', error: `Cited ID ${citedId} not found in workspace as evidence or decision` };
          }
        }

        if (!ctx?.runId) {
          return { tool_call_id: id, name, content: '', error: 'propose_review_action requires an active run context' };
        }

        const proposalId = await createProposal(
          ctx.runId,
          actionType,
          releaseId,
          revisionId,
          requirementId,
          citedIds,
          reason,
          ctx.expectedRevision
        );

        await runCypher(
          `MATCH (run:AgentRun {id: $runId, workspaceId: $wsId}), (p:Proposal {id: $proposalId, workspaceId: $wsId})
           CREATE (run)-[:PROPOSED]->(p)`,
          { runId: ctx.runId, proposalId, wsId: FIXED_WORKSPACE_ID }
        );

        return {
          tool_call_id: id,
          name,
          content: JSON.stringify({
            proposalId,
            actionType,
            releaseId,
            revisionId,
            requirementId: requirementId || null,
            citedIds,
            reason,
            status: 'PENDING',
            createdAt: nowISO(),
          }, null, 2),
        };
      }

      default:
        return { tool_call_id: id, name, content: '', error: `Unknown tool: ${name}` };
    }
  } catch (error) {
    return {
      tool_call_id: id,
      name,
      content: '',
      error: error instanceof Error ? error.message : 'Tool execution failed',
    };
  }
}

export function getToolDefinitions(): ToolDefinition[] {
  return TOOL_DEFINITIONS;
}