import { validateMCPConfig } from './packages/mcp/src/schema.ts';
const r = validateMCPConfig({ servers: [] });
console.log('validate ok:', r.ok, r.error || '');
