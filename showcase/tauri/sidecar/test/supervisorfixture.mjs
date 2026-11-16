// Domain tests attach the same plugin-owned tool definitions used by the MCP server.
import { createSupervisors as createHost } from '../supervisors.mjs';
import { createOrcaTools } from '../bundled-plugins/orca/tools.mjs';
export { parseSupervisorRequest } from '../supervisors.mjs';
export function createSupervisors(options) { const host = createHost(options); host.tools = createOrcaTools({ orca: options.orca, host }).map(t => ({ ...t, execute: async (...args) => JSON.stringify(await t.execute(...args)) })); return host; }
