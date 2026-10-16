export const RELATIONSHIP_PHRASES: Record<string, string> = {
  HAS_REVISION: 'has revision',
  CURRENT_REVISION: 'currently uses revision',
  DEPENDS_ON: 'depends on',
  REQUIRES: 'requires',
  FOR_VERSION: 'applies to version',
  FOR_REVISION: 'was recorded for revision',
  SATISFIES_CHECK: 'is evidence for requirement',
  FROM_SOURCE: 'came from source',
  SUPERSEDES: 'supersedes',
  WITHDRAWS: 'withdraws',
  ASSESSES: 'assesses revision',
  SUPPORTED_BY: 'was supported by',
  EVALUATES: 'evaluated requirement',
  REPLACES: 'replaces decision',
  CHANGES: 'changed',
  FOR_REQUIREMENT: 'is for requirement',
  INSPECTED: 'inspected',
  PROPOSED: 'proposed',
  BASED_ON: 'is based on decision',
};

export function getRelationshipPhrase(type: string): string {
  return RELATIONSHIP_PHRASES[type] ?? type.toLowerCase().replace(/_/g, ' ');
}

export function buildPathSentence(
  sourceLabel: string,
  relationshipType: string,
  targetLabel: string,
  historical: boolean = false
): string {
  const phrase = getRelationshipPhrase(relationshipType);
  const prefix = historical ? 'Historical: ' : '';
  return `${prefix}\`${sourceLabel}\` ${phrase} \`${targetLabel}\``;
}

export function getNodeTypeLabel(type: string): string {
  const labels: Record<string, string> = {
    Release: 'Release',
    Revision: 'Revision',
    DependencyVersion: 'Dependency',
    Requirement: 'Requirement',
    Evidence: 'Evidence',
    Source: 'Source',
    Decision: 'Decision',
    AgentRun: 'Investigation',
    Proposal: 'Proposal',
    ReviewTask: 'Evidence Request',
  };
  return labels[type] ?? type;
}