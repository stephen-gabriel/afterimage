import { config, validateConfig } from './config';
import { runIdempotentSeed, checkSeedExists } from './seed/index';
import { closeClient } from './graph/client';

async function main() {
  try {
    validateConfig();
    console.log('Configuration validated');
    console.log('Graph:', config.falkor.graphName);
    console.log('Host:', config.falkor.host);
    console.log('Port:', config.falkor.port);

    console.log('\n--- Checking existing seed ---');
    const existing = await checkSeedExists();
    console.log('Workspace exists:', existing.workspaceExists);
    console.log('Node count:', existing.nodeCount);
    console.log('Relationship count:', existing.relCount);

    console.log('\n--- Running idempotent seed ---');
    const result = await runIdempotentSeed();
    console.log('Already seeded:', result.alreadySeeded);
    console.log('Nodes created:', result.nodesCreated);
    console.log('Relationships created:', result.relationshipsCreated);

    console.log('\n--- Verifying seed ---');
    const after = await checkSeedExists();
    console.log('Workspace exists:', after.workspaceExists);
    console.log('Node count:', after.nodeCount);
    console.log('Relationship count:', after.relCount);

    console.log('\n✅ Seed completed successfully');
    await closeClient();
  } catch (error) {
    console.error('❌ Seed failed:', error);
    process.exit(1);
  }
}

main();