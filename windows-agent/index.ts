/**
 * Windows Agent entry point.
 * Run with: npm run agent
 */
import { startAgentServer, ensureWorkspaceDirs as ensureAgentDirs, AGENT_PORT } from "./server";
import { ensureWorkspaceDirs as ensureValidationDirs } from "./utils/validation";

function main() {
  // Ensure agent-specific dirs (logs, screenshots)
  const agentDirs = ensureAgentDirs();
  // Ensure validation dirs (workspace, screenshots)
  ensureValidationDirs();
  // eslint-disable-next-line no-console
  console.log(`[LOHZ Windows Agent] Workspace ready.`);
  // eslint-disable-next-line no-console
  console.log(`[LOHZ Windows Agent]   logs:      ${agentDirs.logsDir}`);
  // eslint-disable-next-line no-console
  console.log(`[LOHZ Windows Agent]   screenshots: ${agentDirs.shotsDir}`);
  // eslint-disable-next-line no-console
  console.log(`[LOHZ Windows Agent]   port:      ${AGENT_PORT}`);
  const handle = startAgentServer();

  function shutdown(signal: string) {
    // eslint-disable-next-line no-console
    console.log(`\n[LOHZ Windows Agent] Received ${signal}, shutting down...`);
    handle.broadcastStatus({ ...handle.status, online: false });
    handle.wss.clients.forEach((c) => c.close());
    handle.wss.close();
    handle.server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000).unref();
  }

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main();
