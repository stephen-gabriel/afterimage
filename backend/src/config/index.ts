import * as dotenv from 'dotenv';
import * as path from 'path';
const envPath = path.resolve(__dirname, '../../../.env');
console.log('Loading .env from:', envPath);
dotenv.config({ path: envPath });
console.log('OPENROUTER_API_KEY loaded:', process.env.OPENROUTER_API_KEY ? 'yes' : 'no');

export const config = {
  falkor: {
    host: process.env.FALKORDB_HOST || 'localhost',
    port: parseInt(process.env.FALKORDB_PORT || '6379', 10),
    graphName: process.env.FALKORDB_GRAPH || 'afterimage_workspace',
  },
  workspace: {
    id: process.env.WORKSPACE_ID || 'default',
  },
  queryTimeoutMs: parseInt(process.env.QUERY_TIMEOUT_MS || '10000', 10),
  model: {
    provider: 'openrouter',
    model: process.env.OPENROUTER_MODEL || 'nvidia/nemotron-3-super-120b-a12b:free',
    apiKey: process.env.OPENROUTER_API_KEY,
  },
  server: {
    port: parseInt(process.env.PORT || '3001', 10),
  },
} as const;

export function validateConfig(): void {
  if (!config.model.apiKey || config.model.apiKey === 'your_openrouter_key_here') {
    throw new Error('OPENROUTER_API_KEY not configured in .env');
  }
}