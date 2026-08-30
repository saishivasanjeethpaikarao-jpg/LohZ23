# LOHZ Windows Agent

The LOHZ Windows Agent is a secure, localhost-only agent that provides system-level control capabilities on Windows machines. It runs as a separate process from the main LOHZ server and communicates via authenticated WebSocket connection.

## Architecture Overview

The Windows Agent consists of:

1. **Windows Agent Server** (`windows-agent/server.ts` + `windows-agent/index.ts`)
   - Express.js HTTP server with native WebSocket endpoint
   - Runs on `127.0.0.1:3001` (localhost-only)
   - Token-based authentication
   - Exposes `/tools` (GET) and `/execute` (POST) endpoints
   - WebSocket endpoint at `/ws?token=...` for real-time communication

2. **Tool System**
   - 19 implemented tools organized by category
   - Each tool has explicit risk level (LOW/MEDIUM/HIGH)
   - Parameter validation and timeout enforcement
   - Structured results with success/error states

3. **Main Server Integration**
   - `agentBridge.ts`: WebSocket client to Windows Agent with auto-reconnect
   - `toolRouter.ts`: Routes Gemini tool calls to Windows Agent based on risk
   - Modified `server.ts`: Integrates tool routing and status broadcasting

## Security Model

### Network Security
- Binds exclusively to `127.0.0.1` (localhost-only)
- No external network exposure
- WebSocket and HTTP endpoints only accessible locally

### Authentication
- Token-based Bearer token authentication
- Token sourced from:
  1. `LOHZ_AGENT_TOKEN` environment variable (highest priority)
  2. `.agent-token` file in project root
  3. Auto-generated 256-bit hex token if neither exists
- Constant-time comparison to prevent timing attacks

### Tool Security
- **Risk Levels**: Every tool is classified as LOW, MEDIUM, or HIGH risk
  - LOW: Safe operations (reading system info, getting volume, etc.)
  - MEDIUM: Operations with potential side effects (file writes, app closing)
  - HIGH: Operations requiring explicit user confirmation (not implemented in v1)
- **Parameter Validation**: All tools validate input parameters
- **Path Security**: File operations restricted to safe roots (Desktop, Documents, Downloads, workspace)
- **Application Whitelist**: Only predefined applications can be launched/controlled
- **PowerShell Safety**: All dynamic values encoded as base64 literals, never interpolated
- **Timeout Enforcement**: Every tool execution has a configurable timeout

### Implementation Safety
- No arbitrary command execution
- No deletion/shutdown/registry/mouse-keyboard tools (yet)
- All file operations use `resolveSafePath()` with boundary checks
- Process name validation before PowerShell execution

## Tool Categories

### Applications (`windows-agent/tools/applications.ts`)
- `openApp`: Launch whitelisted applications (notepad, calculator, chrome, etc.)
- `closeApp`: Force-close applications
- `focusApp`: Bring application to foreground
- Uses `where.exe` for PATH lookup and app whitelisting

### File System (`windows-agent/tools/files.ts`)
- `createFile`: Create new text file (fails if exists)
- `readFile`: Read text file (max 200KB)
- `writeFile`: Write/overwrite text file (max 1MB)
- `createFolder`: Create folder recursively
- `renameFile`: Rename file/folder within same directory
- All paths validated against safe roots

### Browser (`windows-agent/tools/browser.ts`)
- `openUrl`: Open http/https URL in default browser
- Protocol and hostname validation

### Windows Management (`windows-agent/tools/windows.ts`)
- `listWindows`: Get all visible windows
- `focusWindow`: Focus window by title or index
- `minimizeWindow`: Minimize window
- `maximizeWindow`: Maximize/restore window
- Uses C# P/Invoke via PowerShell for window operations

### Clipboard (`windows-agent/tools/clipboard.ts`)
- `clipboardRead`: Read clipboard text (max 512KB)
- `clipboardWrite`: Write text to clipboard (max 512KB)
- Uses base64-encoded content in PowerShell

### Screenshot (`windows-agent/tools/screenshot.ts`)
- `takeScreenshot`: Capture entire virtual screen
- Auto-generates timestamped filename
- Saved to `windows-agent/screenshots/`

### System (`windows-agent/tools/system.ts`)
- `getSystemInfo`: Get hostname, OS, CPU, memory info
- `getVolume`: Get master volume level and mute state
- `setVolume`: Set volume level (0-100) or toggle mute
- Uses C# COM interop via PowerShell for audio control

## Risk Levels

All tools are assigned risk levels that determine confirmation requirements:

### LOW Risk Tools
- `openApp`, `focusApp`, `openUrl`, `listWindows`, `focusWindow`
- `minimizeWindow`, `maximizeWindow`, `takeScreenshot`, `clipboardRead`
- `getSystemInfo`, `getVolume`, `setVolume`

### MEDIUM Risk Tools
- `closeApp`, `createFile`, `readFile`, `writeFile`, `createFolder`
- `renameFile`, `clipboardWrite`

### HIGH Risk Tools
- Not implemented in this version (reserved for future dangerous operations)

## Communication Protocol

### HTTP Endpoints (on Windows Agent)
- `GET /tools`: Returns list of available tools with metadata
- `POST /execute`: Execute a tool
  ```json
  {
    "name": "toolName",
    "params": { /* tool-specific parameters */ }
  }
  ```
  Returns:
  ```json
  {
    "success": boolean,
    "tool": string,
    "message": string,
    "data": Record<string, any>,
    "error": { code: string, details?: string } | null
  }
  ```

### WebSocket Messages
The Windows Agent server broadcasts status updates:
```json
{
  "type": "agent_status",
  "status": {
    "online": boolean,
    "connecting": boolean,
    "connectedClients": number,
    "toolsRegistered": number,
    "lastError": string | null,
    "host": string,
    "port": number
  }
}
```

Client-to-agent messages:
```json
{
  "type": "execute",
  "requestId": "unique-id",
  "name": "toolName",
  "params": { /* tool parameters */ }
}
```

Agent-to-client responses:
```json
{
  "type": "result",
  "requestId": "unique-id",
  "result": {
    /* same as HTTP POST /execute response */
  }
}
```

### Main Server to Windows Agent
The `agentBridge.ts` handles:
- Automatic WebSocket connection with exponential backoff reconnect
- HTTP fallback when WebSocket is unavailable
- Request/response mapping with timeouts
- Status monitoring and broadcasting to connected clients

### Gemini Tool Routing
The `toolRouter.ts`:
1. Receives tool calls from Gemini via the main server's WebSocket
2. Validates parameters using tool registry
3. Determines risk level
4. For HIGH-risk tools: returns `requiresConfirmation: true`
5. For LOW/MEDIUM risk: forwards to Windows Agent via agentBridge
6. Returns structured result to Gemini

## Installation & Usage

### Prerequisites
- Windows 10 or 11
- Node.js 18+ (for development)
- Git (for cloning repository)

### Development Setup
1. Clone the repository
2. Install dependencies: `npm install`
3. Set up Gemini API key in environment (for main server)
4. Start the Windows Agent: `npm run agent`
5. Start the main server: `npm run dev`
6. Access the UI at `http://localhost:3000`

### Production Deployment
For production use, the Windows Agent can be run as a background service:
```bash
# Install as Windows Service (requires admin)
nssm install LOHZWindowsAgent "C:\path\to\node.exe" "C:\path\to\lohz23\windows-agent\index.ts"

# Or run manually in background
start /B "" node windows-agent/index.ts
```

## Configuration

### Environment Variables
- `LOHZ_AGENT_TOKEN`: Authentication token (optional, auto-generated if not set)
- `LOHZ_AGENT_HOST`: Binding host (default: `127.0.0.1`)
- `LOHZ_AGENT_PORT`: Binding port (default: `3001`)

### File Locations
- Logs: `windows-agent/logs/agent-YYYY-MM-DD.log`
- Screenshots: `windows-agent/screenshots/shot-YYYYMMDD-HHMMSS.png`
- Token file: `.agent-token` (project root)

## Extending the Agent

### Adding New Tools
1. Create implementation file in `windows-agent/tools/` (e.g., `newtool.ts`)
2. Export function matching `ToolExecutor` signature
3. Import and add to `windows-agent/tools/index.ts` barrel export
4. Add `ToolDefinition` to `windows-agent/toolRegistry.ts`
5. Define parameter schema, validation, risk level, and timeout
6. Rebuild: `npm run lint` (to check types)

### Modifying Safe Roots
Edit `windows-agent/utils/validation.ts`:
- Modify `SAFE_ROOTS` array to add/remove allowed directories
- Update `resolveSafePath()` boundary checking if needed

### Changing Authentication
Edit `windows-agent/auth.ts`:
- Modify `resolveToken()` function for different token sources
- Update token generation logic if needed

## Troubleshooting

### Common Issues
1. **Agent fails to start**: Check that port 3001 is available and not blocked by firewall
2. **Authentication failures**: Verify `.agent-token` file or `LOHZ_AGENT_TOKEN` env var
3. **Tool execution fails**: Check windows-agent logs for detailed error messages
4. **WebSocket connection issues**: Ensure both main server and agent are running
5. **File operation denied**: Verify path is within allowed safe roots

### Logs
The Windows Agent writes structured JSONL logs to:
`windows-agent/logs/agent-YYYY-MM-DD.log`

Each line is a JSON object with:
- `tool`: Tool name
- `params`: Parameter names (values redacted for security)
- `risk`: Tool risk level
- `success`: Boolean success flag
- `durationMs`: Execution time in milliseconds
- `errorCode`: Error code if failed
- `message`: Result or error message

## Future Enhancements

### Planned Features
1. **HIGH-risk tool confirmation**: UI prompts for dangerous operations
2. **Extended tool set**: Registry manipulation, service control, etc.
3. **Enhanced logging**: Structured logging with levels and output formats
4. **Configuration file**: JSON-based configuration for advanced users
5. **Service installation**: Automated Windows service setup script
6. **Performance monitoring**: Resource usage tracking and reporting

### Security Improvements
1. **Audit trail**: Cryptographic signing of tool execution logs
2. **Integration with Windows Defender ATP**: For enterprise security monitoring
3. **Just-in-time access**: Temporary elevation for specific operations
4. **Network isolation**: Optional Hyper-V containerization for high-security scenarios

## License
MIT License - see LICENSE file for details.