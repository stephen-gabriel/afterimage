import { runCypher } from '../graph/client';
import { createSeedData, FIXED_WORKSPACE_ID } from './fixtures';

export async function seedDatabase(): Promise<{ nodesCreated: number; relationshipsCreated: number }> {
  const { nodes, relationships } = createSeedData();

  let nodesCreated = 0;
  let relationshipsCreated = 0;

  for (const node of nodes) {
    const labels = node.type;
    const props = { ...node };
    delete props.type;

    const propStr = Object.entries(props)
      .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
      .join(', ');

    const query = `MERGE (n:${labels} {id: $id}) SET n += $props RETURN n`;
    await runCypher(query, { id: node.id, props });
    nodesCreated++;
  }

  for (const rel of relationships) {
    const query = `
      MATCH (a {id: $sourceId}), (b {id: $targetId})
      MERGE (a)-[r:${rel.type} {id: $relId}]->(b)
      SET r += $props
      RETURN r
    `;
    await runCypher(query, {
      sourceId: rel.sourceId,
      targetId: rel.targetId,
      relId: rel.id,
      props: rel.properties || {},
    });
    relationshipsCreated++;
  }

  return { nodesCreated, relationshipsCreated };
}

export async function checkSeedExists(): Promise<{ workspaceExists: boolean; nodeCount: number; relCount: number }> {
  const wsResult = await runCypher(`MATCH (n:Workspace {id: $id}) RETURN n`, { id: FIXED_WORKSPACE_ID });
  const nodeResult = await runCypher(`MATCH (n) WHERE n.workspaceId = $wsId RETURN count(n) as count`, { wsId: FIXED_WORKSPACE_ID });
  const relResult = await runCypher(`MATCH (a)-[r]->(b) WHERE a.workspaceId = $wsId RETURN count(r) as count`, { wsId: FIXED_WORKSPACE_ID });

  return {
    workspaceExists: wsResult.data.length > 0,
    nodeCount: nodeResult.data[0]?.count || 0,
    relCount: relResult.data[0]?.count || 0,
  };
}

export async function runIdempotentSeed(): Promise<{ nodesCreated: number; relationshipsCreated: number; alreadySeeded: boolean }> {
  const existing = await checkSeedExists();
  if (existing.workspaceExists) {
    return { nodesCreated: 0, relationshipsCreated: 0, alreadySeeded: true };
  }
  const result = await seedDatabase();
  return { ...result, alreadySeeded: false };
}