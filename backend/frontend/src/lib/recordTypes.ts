const PREFIX_TYPES: Array<[string, string]> = [
  ['ev_', 'Evidence'],
  ['dec_', 'Decision'],
  ['rev_', 'Revision'],
  ['dep_', 'DependencyVersion'],
  ['req_', 'Requirement'],
  ['src_', 'Source'],
  ['evt_', 'Event'],
  ['tsk_', 'ReviewTask'],
  ['run_', 'AgentRun'],
  ['prop_', 'Proposal'],
  ['rel_', 'Release'],
];

export function inferRecordType(id: string): string {
  if (!id) return 'Record';
  for (const [prefix, type] of PREFIX_TYPES) {
    if (id.startsWith(prefix)) return type;
  }
  return 'Record';
}

export function uniqueIds(ids: string[]): string[] {
  return Array.from(new Set(ids.filter(Boolean)));
}
