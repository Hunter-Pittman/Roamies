// Only app-shipped packages receive these host bindings. A third-party manifest cannot grant itself a binding.
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
const packaged = new URL('./bundled-plugins/orca/', import.meta.url), development = new URL('./dist/bundled-plugins/orca/', import.meta.url);
export const bundledPlugins = () => [{
  key: 'orca', source: fileURLToPath(existsSync(new URL('server.mjs', packaged)) ? packaged : development), server: 'orca', entrypoint: 'server.mjs',
  executables: { node: process.execPath },
  timeout: 120000,
  // These exact operations preserve existing read-only Orca status when Allow File Edits & Commands is off.
  readTools: ['orca_status', 'orca_workspaces', 'orca_tasks', 'supervisors', 'watch_orca_task', 'control_supervisor', 'interruption_rules'],
  hostServices: { supervisors: ['create', 'launch', 'message', 'action', 'setInterruptions', 'snapshot', 'get', 'open'] },
  actionHostOperations: { supervisors: ['launch', 'message'] },
  operations: { status: true, workspaces: true, runs: true, tasks: true, observe: true, evidence: true, launchSupervisor: false, messageSupervisor: false },
  // CLI location and OS configuration directories are needed for runtime discovery, not session identity.
  // APPDATA is mandatory for Windows Orca's metadata path. All other ORCA_* vars stay stripped.
  environment: Object.fromEntries(['ORCA_CLI_COMMAND', 'ORCA_DEV_REPO_ROOT', 'LOCALAPPDATA', 'APPDATA', 'XDG_CONFIG_HOME', 'XDG_RUNTIME_DIR', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME'].filter((k) => process.env[k]).map((k) => [k, process.env[k]])),
}];
