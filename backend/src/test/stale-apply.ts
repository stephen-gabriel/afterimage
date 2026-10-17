// Stale-sibling apply regression suite. Runs against an isolated graph with the
// deterministic TEST MODEL double — never the live model, never a shared graph.
// TS hoists static imports above other statements, so the env must be set here
// and the suite pulled in via require() afterwards (same pattern as stage2.ts).
process.env.FALKORDB_GRAPH = 'afterimage_stale_apply_test';
process.env.AFTERIMAGE_TEST_MODEL_DOUBLE = '1';

require('./stale-apply-suite');
