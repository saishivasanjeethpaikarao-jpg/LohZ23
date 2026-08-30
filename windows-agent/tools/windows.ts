/**
 * Window tools: listWindows / focusWindow / minimizeWindow / maximizeWindow.
 *
 * Flow: listWindows returns window entries with an `hwnd` handle. The action
 * tools accept either a `title` substring match or an `index` from that list,
 * resolve the handle themselves, then run a FIXED user32 script (the handle is
 * a validated integer, so it is safe to embed).
 */
import { runPowerShell, runPowerShellMarker } from "../utils/powershell";

export interface WindowInfo {
  index: number;
  pid: number;
  processName: string;
  title: string;
  hwnd: number;
}

const LIST_SCRIPT = `
$sig = '
[DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
'
Add-Type -MemberDefinition $sig -Name Chk -Namespace LohzNative -ErrorAction SilentlyContinue
$items = @()
foreach ($p in (Get-Process | Where-Object { $_.MainWindowTitle -ne [string]::Empty })) {
  if ($p.MainWindowHandle -eq 0) { continue }
  $items += [pscustomobject]@{
    pid = $p.Id
    name = $p.ProcessName
    title = $p.MainWindowTitle
    hwnd = [int64]$p.MainWindowHandle
  }
}
$items | ConvertTo-Json -Compress
Write-Output "OK"
`.trim();

export async function listWindows(): Promise<WindowInfo[]> {
  const result = await runPowerShell(LIST_SCRIPT, 15000);
  if (result.timedOut || result.exitCode !== 0) {
    const e = new Error(`listWindows failed: ${result.stderr || "timeout"}`);
    (e as any).code = "WINDOWS_LIST_FAILED";
    throw e;
  }
  const lines = result.stdout.split(/\r?\n/);
  const jsonLine = lines.find((l) => l.trim().startsWith("[") || l.trim().startsWith("{"));
  if (!jsonLine) return [];
  try {
    const parsed = JSON.parse(jsonLine);
    const arr = Array.isArray(parsed) ? parsed : [parsed];
    return arr
      .filter((w: any) => w && typeof w.hwnd === "number")
      .map((w: any, i: number) => ({
        index: i,
        pid: Number(w.pid),
        processName: String(w.name || ""),
        title: String(w.title || ""),
        hwnd: Number(w.hwnd),
      }));
  } catch {
    return [];
  }
}

/** Resolves the target window handle from title substring or index. */
async function resolveHandle(params: Record<string, any>): Promise<{ hwnd: number; title: string }> {
  const windows = await listWindows();
  if (windows.length === 0) {
    const e = new Error("No visible windows found.");
    (e as any).code = "NO_WINDOWS";
    throw e;
  }
  const title = typeof params.title === "string" ? params.title.trim() : "";
  const index = typeof params.index === "number" ? params.index : null;

  let match: WindowInfo | undefined;
  if (title) {
    const lower = title.toLowerCase();
    match = windows.find((w) => w.title.toLowerCase().includes(lower) || w.processName.toLowerCase().includes(lower));
  } else if (index !== null) {
    match = windows.find((w) => w.index === index);
  } else {
    match = windows[0];
  }
  if (!match) {
    const e = new Error(`No window matches title "${title}" / index ${index}.`);
    (e as any).code = "WINDOW_NOT_FOUND";
    throw e;
  }
  if (!Number.isSafeInteger(match.hwnd) || match.hwnd <= 0) {
    const e = new Error("Resolved window handle is invalid.");
    (e as any).code = "WINDOW_HANDLE_INVALID";
    throw e;
  }
  return { hwnd: match.hwnd, title: match.title };
}

/** Fixed user32 action script. hwnd is a validated positive integer; cmdCode is a fixed constant. */
async function windowAction(hwnd: number, cmdCode: number, foreground: boolean, verb: string) {
  if (!Number.isSafeInteger(hwnd) || hwnd <= 0 || hwnd > Number.MAX_SAFE_INTEGER) {
    const e = new Error("Invalid window handle.");
    (e as any).code = "WINDOW_HANDLE_INVALID";
    throw e;
  }
  if (![3, 6, 9].includes(cmdCode)) {
    const e = new Error("Unsupported window command.");
    (e as any).code = "WINDOW_CMD_INVALID";
    throw e;
  }
  const script = `
$sig = '
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
'
Add-Type -MemberDefinition $sig -Name Win -Namespace LohzNative -ErrorAction SilentlyContinue
$h = [IntPtr]::new(${hwnd})
[LohzNative.Win]::ShowWindow($h, ${cmdCode}) | Out-Null
${foreground ? "[LohzNative.Win]::SetForegroundWindow($h) | Out-Null" : ""}
Write-Output "OK|done"
`.trim();
  const result = await runPowerShellMarker(script, 12000);
  if (!result.ok) {
    const e = new Error(`${verb} failed: ${result.stderr}`);
    (e as any).code = "WINDOW_ACTION_FAILED";
    throw e;
  }
}

export async function focusWindow(params: Record<string, any>) {
  const { hwnd, title } = await resolveHandle(params);
  await windowAction(hwnd, 9, true, "focusWindow");
  return { message: `Focused window "${title}".`, data: { title, hwnd } };
}

export async function minimizeWindow(params: Record<string, any>) {
  const { hwnd, title } = await resolveHandle(params);
  await windowAction(hwnd, 6, false, "minimizeWindow");
  return { message: `Minimized window "${title}".`, data: { title, hwnd } };
}

export async function maximizeWindow(params: Record<string, any>) {
  const { hwnd, title } = await resolveHandle(params);
  await windowAction(hwnd, 3, true, "maximizeWindow");
  return { message: `Maximized window "${title}".`, data: { title, hwnd } };
}
