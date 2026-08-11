import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { loadConfig } from './config.js';

const config = loadConfig();
const app = createApp(config);

console.log(
  `[ocp-api] listening on http://${config.host}:${config.port} (auth ${config.authDisabled ? 'disabled' : 'enabled'}, connector=docker-exec, phase=5-10)`
);
console.log(`[ocp-api] monorepoRoot=${config.monorepoRoot}`);
console.log(`[ocp-api] enclaveRoot=${config.enclaveRoot}`);
console.log(`[ocp-api] auditPath=${config.auditPath}`);
if (!config.authDisabled) {
  console.log(`[ocp-api] default login user=${config.adminUsername} (set CONTROL_PLANE_PASSWORD to override)`);
}

serve({
  fetch: app.fetch,
  hostname: config.host,
  port: config.port,
});
