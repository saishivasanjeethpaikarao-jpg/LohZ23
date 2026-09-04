/**
 * Computer-Use Automation Primitives for Windows Agent:
 * - mouseClick: Moves cursor to (x, y) and performs left/right/double click.
 * - mouseMove: Moves cursor to (x, y).
 * - keyType: Types text into currently focused window.
 * - hotkey: Dispatches shortcut combinations (e.g. "ctrl+s", "alt+tab", "ctrl+shift+p", "win+d").
 */

import { runPowerShell, psB64 } from "../utils/powershell";

export interface MouseClickParams {
  x: number;
  y: number;
  button?: "left" | "right" | "double";
}

export interface MouseMoveParams {
  x: number;
  y: number;
}

export interface KeyTypeParams {
  text: string;
}

export interface HotkeyParams {
  keys: string;
}

const MOUSE_HELPER_SIGNATURE = `
$sig = @'
[DllImport("user32.dll")]
public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, int dwExtraInfo);
'@
Add-Type -MemberDefinition $sig -Name MouseInput -Namespace LohzAutomation -ErrorAction SilentlyContinue
Add-Type -AssemblyName System.Windows.Forms -ErrorAction SilentlyContinue
Add-Type -AssemblyName System.Drawing -ErrorAction SilentlyContinue
`.trim();

/**
 * Moves cursor to (x, y) and performs mouse click.
 */
export async function mouseClick(params: MouseClickParams) {
  const x = Math.round(Math.max(0, Number(params.x) || 0));
  const y = Math.round(Math.max(0, Number(params.y) || 0));
  const button = params.button || "left";

  // MOUSEEVENTF flags:
  // LEFTDOWN = 0x0002, LEFTUP = 0x0004
  // RIGHTDOWN = 0x0008, RIGHTUP = 0x0010
  let clickScript = `
${MOUSE_HELPER_SIGNATURE}
[System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${x}, ${y})
Start-Sleep -Milliseconds 30
`;

  if (button === "right") {
    clickScript += `
[LohzAutomation.MouseInput]::mouse_event(0x0008, 0, 0, 0, 0)
Start-Sleep -Milliseconds 20
[LohzAutomation.MouseInput]::mouse_event(0x0010, 0, 0, 0, 0)
`;
  } else if (button === "double") {
    clickScript += `
[LohzAutomation.MouseInput]::mouse_event(0x0002, 0, 0, 0, 0)
Start-Sleep -Milliseconds 20
[LohzAutomation.MouseInput]::mouse_event(0x0004, 0, 0, 0, 0)
Start-Sleep -Milliseconds 60
[LohzAutomation.MouseInput]::mouse_event(0x0002, 0, 0, 0, 0)
Start-Sleep -Milliseconds 20
[LohzAutomation.MouseInput]::mouse_event(0x0004, 0, 0, 0, 0)
`;
  } else {
    // left click
    clickScript += `
[LohzAutomation.MouseInput]::mouse_event(0x0002, 0, 0, 0, 0)
Start-Sleep -Milliseconds 20
[LohzAutomation.MouseInput]::mouse_event(0x0004, 0, 0, 0, 0)
`;
  }

  clickScript += `\nWrite-Output "OK|${x},${y},${button}"`;

  const result = await runPowerShell(clickScript, 10000);
  if (result.timedOut || result.exitCode !== 0) {
    throw new Error(`mouseClick failed: ${result.stderr || "timeout"}`);
  }

  return {
    message: `Clicked ${button} mouse button at (${x}, ${y}).`,
    data: { x, y, button },
  };
}

/**
 * Moves cursor to (x, y) without clicking.
 */
export async function mouseMove(params: MouseMoveParams) {
  const x = Math.round(Math.max(0, Number(params.x) || 0));
  const y = Math.round(Math.max(0, Number(params.y) || 0));

  const script = `
Add-Type -AssemblyName System.Windows.Forms -ErrorAction SilentlyContinue
Add-Type -AssemblyName System.Drawing -ErrorAction SilentlyContinue
[System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${x}, ${y})
Write-Output "OK|${x},${y}"
`.trim();

  const result = await runPowerShell(script, 8000);
  if (result.timedOut || result.exitCode !== 0) {
    throw new Error(`mouseMove failed: ${result.stderr || "timeout"}`);
  }

  return {
    message: `Moved cursor to (${x}, ${y}).`,
    data: { x, y },
  };
}

/**
 * Types text into the currently focused window using Windows Forms SendKeys.
 */
export async function keyType(params: KeyTypeParams) {
  if (typeof params.text !== "string") {
    throw new Error("text parameter must be a string");
  }

  const b64 = psB64(params.text);
  const script = `
$raw = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String(${b64}))
Add-Type -AssemblyName System.Windows.Forms -ErrorAction SilentlyContinue
# Escape special SendKeys characters: +, ^, %, ~, (, ), {, }
$escaped = $raw -replace '([+^%~(){}\\[\\]])', '{$1}'
[System.Windows.Forms.SendKeys]::SendWait($escaped)
Write-Output "OK|typed"
`.trim();

  const result = await runPowerShell(script, 12000);
  if (result.timedOut || result.exitCode !== 0) {
    throw new Error(`keyType failed: ${result.stderr || "timeout"}`);
  }

  return {
    message: `Typed ${params.text.length} characters into focused window.`,
    data: { length: params.text.length },
  };
}

/**
 * Dispatches standard hotkey shortcuts (e.g. "ctrl+s", "alt+tab", "ctrl+shift+p", "win+d", "enter", "esc").
 */
export async function hotkey(params: HotkeyParams) {
  const rawKey = (params.keys || "").trim().toLowerCase();
  if (!rawKey) {
    throw new Error("keys parameter required");
  }

  // Handle desktop toggle
  if (rawKey === "win+d" || rawKey === "win") {
    const script = `
$shell = New-Object -ComObject Shell.Application
$shell.ToggleDesktop()
Write-Output "OK|toggle_desktop"
`.trim();
    const result = await runPowerShell(script, 8000);
    return {
      message: `Executed desktop toggle (${rawKey}).`,
      data: { keys: rawKey },
    };
  }

  // Parse combo
  const parts = rawKey.split(/[\+\-]/).map((s) => s.trim());
  let prefix = "";
  let targetKey = "";

  for (const part of parts) {
    if (part === "ctrl" || part === "control") prefix += "^";
    else if (part === "alt") prefix += "%";
    else if (part === "shift") prefix += "+";
    else targetKey = part;
  }

  const specialMap: Record<string, string> = {
    enter: "{ENTER}",
    return: "{ENTER}",
    esc: "{ESC}",
    escape: "{ESC}",
    tab: "{TAB}",
    space: " ",
    backspace: "{BACKSPACE}",
    delete: "{DELETE}",
    del: "{DELETE}",
    up: "{UP}",
    down: "{DOWN}",
    left: "{LEFT}",
    right: "{RIGHT}",
    home: "{HOME}",
    end: "{END}",
    pageup: "{PGUP}",
    pagedown: "{PGDN}",
    f1: "{F1}",
    f2: "{F2}",
    f3: "{F3}",
    f4: "{F4}",
    f5: "{F5}",
    f6: "{F6}",
    f7: "{F7}",
    f8: "{F8}",
    f9: "{F9}",
    f10: "{F10}",
    f11: "{F11}",
    f12: "{F12}",
  };

  const finalKey = specialMap[targetKey] || targetKey;
  const sendKeySequence = `${prefix}${finalKey}`;
  const b64 = psB64(sendKeySequence);

  const script = `
$key = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String(${b64}))
Add-Type -AssemblyName System.Windows.Forms -ErrorAction SilentlyContinue
[System.Windows.Forms.SendKeys]::SendWait($key)
Write-Output "OK|$key"
`.trim();

  const result = await runPowerShell(script, 8000);
  if (result.timedOut || result.exitCode !== 0) {
    throw new Error(`hotkey '${rawKey}' failed: ${result.stderr || "timeout"}`);
  }

  return {
    message: `Dispatched hotkey shortcut: ${rawKey} (${sendKeySequence}).`,
    data: { keys: rawKey, sequence: sendKeySequence },
  };
}
