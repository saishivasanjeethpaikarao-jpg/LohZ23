/**
 * SECURITY-ISOLATED LEGACY STUB pending the separate duplicate-system cleanup
 * decision. The prior server had wildcard CORS and no authentication, so this
 * compatibility entry fails closed. Use `npm run agent` for the supported path.
 */
console.error("local-agent.js is disabled. Start the authenticated localhost Windows Agent with: npm run agent");
process.exitCode = 1;
