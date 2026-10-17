// Isolation wrapper: set the environment BEFORE the suite (and everything it
// imports) is loaded. TypeScript hoists static imports, so env assignment must
// live in this entry file with the suite pulled in via require().
process.env.FALKORDB_GRAPH = 'afterimage_reassessment_test';
process.env.AFTERIMAGE_TEST_MODEL_DOUBLE = '1';
delete process.env.AFTERIMAGE_TEST_DOUBLE_STUBBORN;

// eslint-disable-next-line @typescript-eslint/no-var-requires
require('./reassessment-suite');
