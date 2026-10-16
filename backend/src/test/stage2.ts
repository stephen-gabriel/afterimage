// Stage 2 correctness-engine suite. Runs against an isolated test graph.
process.env.FALKORDB_GRAPH = 'afterimage_stage2_test';

require('./stage2-suite');
