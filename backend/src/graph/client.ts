import { FalkorDB } from 'falkordb';
import { config } from '../config';

let clientPromise: Promise<FalkorDB> | null = null;
let graphPromise: Promise<any> | null = null;

export async function getClient(): Promise<FalkorDB> {
  if (!clientPromise) {
    clientPromise = FalkorDB.connect({
      host: config.falkor.host,
      port: config.falkor.port,
    });
  }
  return clientPromise;
}

export async function getGraph(): Promise<any> {
  if (!graphPromise) {
    const client = await getClient();
    graphPromise = Promise.resolve(client.selectGraph(config.falkor.graphName));
  }
  return graphPromise;
}

export async function closeClient(): Promise<void> {
  if (clientPromise) {
    const client = await clientPromise;
    await client.close();
    clientPromise = null;
    graphPromise = null;
  }
}

export async function healthCheck(): Promise<{ database: boolean; details: string }> {
  try {
    const client = await getClient();
    const result = await client.info();
    return { database: true, details: `FalkorDB info: ${JSON.stringify(result).slice(0, 200)}` };
  } catch (error) {
    return { database: false, details: `Connection failed: ${error instanceof Error ? error.message : 'unknown'}` };
  }
}

export async function runCypher(
  query: string,
  params?: Record<string, any>,
  timeoutMs?: number
): Promise<any> {
  const graph = await getGraph();
  const options: { params?: Record<string, any>; TIMEOUT?: number } = {};
  if (params) {
    options.params = params;
  }
  const timeout = timeoutMs ?? config.queryTimeoutMs;
  if (timeout > 0) {
    options.TIMEOUT = timeout;
  }
  return graph.query(query, Object.keys(options).length > 0 ? options : undefined);
}