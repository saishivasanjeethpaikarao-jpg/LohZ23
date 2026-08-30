/**
 * Application tools: openApp / closeApp / focusApp.
 *
 * Security model:
 * - NO arbitrary executable execution. Only apps present in the resolver whitelist below.
 * - Resolution order: known absolute candidate paths -> PATH lookup via `where.exe`.
 * - closeApp/focusApp only accept names that exist in the whitelist (mapped to process names).
 * - Process names are never interpolated into PowerShell text; they are passed as
 *   base64-decoded data (see utils/powershell.ts).
 */
import { execFile, spawn } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { psDecodeInto, runPowerShellMarker } from "../utils/powershell";

interface AppProfile {
  /** Names the AI/user may say. */
  aliases: string[];
  /** Executable file name for PATH lookup. */
  exeName: string;
  /** Candidate absolute paths (%ENV% expanded). */
  candidates: string[];
  /** Process name(s) for close/focus (no .exe). */
  processNames: string[];
}

const APP_PROFILES: AppProfile[] = [
  {
    aliases: ["notepad", "notepad.exe", "text editor"],
    exeName: "notepad.exe",
    candidates: [path.join(process.env.SystemRoot || "C:\\Windows", "System32", "notepad.exe")],
    processNames: ["notepad"],
  },
  {
    aliases: ["calculator", "calc", "calc.exe"],
    exeName: "calc.exe",
    candidates: [path.join(process.env.SystemRoot || "C:\\Windows", "System32", "calc.exe")],
    processNames: ["Calculator", "CalculatorApp"],
  },
  {
    aliases: ["chrome", "google chrome", "chrome.exe"],
    exeName: "chrome.exe",
    candidates: [
      path.join(os.homedir(), "AppData", "Local", "Google", "Chrome", "Application", "chrome.exe"),
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    ],
    processNames: ["chrome"],
  },
  {
    aliases: ["edge", "microsoft edge", "msedge"],
    exeName: "msedge.exe",
    candidates: [
      "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
      "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    ],
    processNames: ["msedge"],
  },
  {
    aliases: ["vscode", "vs code", "visual studio code", "code"],
    exeName: "Code.exe",
    candidates: [
      path.join(os.homedir(), "AppData", "Local", "Programs", "Microsoft VS Code", "Code.exe"),
      "C:\\Program Files\\Microsoft VS Code\\Code.exe",
      "C:\\Program Files (x86)\\Microsoft VS Code\\Code.exe",
    ],
    processNames: ["Code"],
  },
  {
    aliases: ["firefox", "mozilla firefox"],
    exeName: "firefox.exe",
    candidates: [
      "C:\\Program Files\\Mozilla Firefox\\firefox.exe",
      path.join(os.homedir(), "AppData", "Local", "Mozilla Firefox", "firefox.exe"),
    ],
    processNames: ["firefox"],
  },
  {
    aliases: ["explorer", "file explorer", "file explorer.exe", "windows explorer"],
    exeName: "explorer.exe",
    candidates: [path.join(process.env.SystemRoot || "C:\\Windows", "explorer.exe")],
    processNames: ["explorer"],
  },
  {
    aliases: ["word", "microsoft word", "winword"],
    exeName: "WINWORD.EXE",
    candidates: [
      "C:\\Program Files\\Microsoft Office\\root\\Office16\\WINWORD.EXE",
      "C:\\Program Files (x86)\\Microsoft Office\\root\\Office16\\WINWORD.EXE",
    ],
    processNames: ["WINWORD"],
  },
  {
    aliases: ["excel", "microsoft excel"],
    exeName: "EXCEL.EXE",
    candidates: [
      "C:\\Program Files\\Microsoft Office\\root\\Office16\\EXCEL.EXE",
      "C:\\Program Files (x86)\\Microsoft Office\\root\\Office16\\EXCEL.EXE",
    ],
    processNames: ["EXCEL"],
  },
  {
    aliases: ["powerpoint", "microsoft powerpoint"],
    exeName: "POWERPNT.EXE",
    candidates: [
      "C:\\Program Files\\Microsoft Office\\root\\Office16\\POWERPNT.EXE",
      "C:\\Program Files (x86)\\Microsoft Office\\root\\Office16\\POWERPNT.EXE",
    ],
    processNames: ["POWERPNT"],
  },
  {
    aliases: ["cmd", "command prompt", "cmd.exe"],
    exeName: "cmd.exe",
    candidates: [path.join(process.env.SystemRoot || "C:\\Windows", "System32", "cmd.exe")],
    processNames: ["cmd"],
  },
  {
    aliases: ["powershell", "powershell.exe"],
    exeName: "powershell.exe",
    candidates: [path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe")],
    processNames: ["powershell"],
  },
];

const VALID_PROCESS_NAME = /^[A-Za-z0-9 _.-]{1,48}$/;

function findProfile(name: string): AppProfile | null {
  const lower = (name || "").trim().toLowerCase();
  if (!lower) return null;
  return APP_PROFILES.find((p) => p.aliases.includes(lower)) || null;
}

function lookupOnPath(exeName: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile("where.exe", [exeName], { timeout: 8000, windowsHide: true }, (err, stdout) => {
      if (err) return resolve(null);
      const first = stdout
        .split(/\r?\n/)
        .map((l) => l.trim())
        .find((l) => l.toLowerCase().endsWith(".exe"));
      resolve(first || null);
    });
  });
}

export interface ResolvedApp {
  exePath: string;
  profile: AppProfile;
}

export async function resolveApp(name: string): Promise<ResolvedApp | null> {
  const profile = findProfile(name);
  if (!profile) return null;
  for (const candidate of profile.candidates) {
    try {
      if (fs.existsSync(candidate)) {
        return { exePath: candidate, profile };
      }
    } catch {}
  }
  const onPath = await lookupOnPath(profile.exeName);
  if (onPath) return { exePath: onPath, profile };
  return null;
}

/** Returns the whitelist of recognizable app names (for error messages). */
export function knownAppNames(): string[] {
  return APP_PROFILES.map((p) => p.aliases[0]);
}

function appNotFound(name: string): Error {
  const e = new Error(
    `Application "${name}" is not in the known-app list. Known apps: ${knownAppNames().join(", ")}.`
  );
  (e as any).code = "APP_NOT_FOUND";
  return e;
}

export async function openApp(params: Record<string, any>) {
  const name = String(params.name || "");
  const resolved = await resolveApp(name);
  if (!resolved) throw appNotFound(name);
  try {
    const child = spawn(resolved.exePath, [], {
      detached: true,
      stdio: "ignore",
      windowsHide: false,
    });
    child.unref();
  } catch (err: any) {
    const e = new Error(`Failed to launch "${name}" from ${resolved.exePath}: ${err.message}`);
    (e as any).code = "APP_LAUNCH_FAILED";
    throw e;
  }
  return {
    message: `Launched ${resolved.profile.aliases[0]} (${resolved.exePath}).`,
    data: { app: resolved.profile.aliases[0], exePath: resolved.exePath },
  };
}

export async function closeApp(params: Record<string, any>) {
  const name = String(params.name || "");
  const profile = findProfile(name);
  if (!profile) throw appNotFound(name);

  const names = profile.processNames.filter((n) => VALID_PROCESS_NAME.test(n)).join(",");
  if (!names) {
    const e = new Error("No closable process name for this app.");
    (e as any).code = "APP_PROCESS_NAME_INVALID";
    throw e;
  }

  const script = `
${psDecodeInto("namesCsv", `'${Buffer.from(names, "utf-8").toString("base64")}'`)}
$targets = $namesCsv -split ','
$closed = 0
foreach ($t in $targets) {
  if ([string]::IsNullOrWhiteSpace($t)) { continue }
  $procs = Get-Process -Name $t -ErrorAction SilentlyContinue
  foreach ($p in $procs) { try { Stop-Process -Id $p.Id -Force -ErrorAction Stop; $closed++ } catch {} }
}
Write-Output ("OK|" + $closed)
`.trim();

  const result = await runPowerShellMarker(script, 15000);
  if (!result.ok) {
    const e = new Error(`closeApp PowerShell failure: ${result.stderr}`);
    (e as any).code = "APP_CLOSE_FAILED";
    throw e;
  }
  const closed = parseInt(result.payload || "0", 10);
  if (closed === 0) {
    return { message: `${profile.aliases[0]} was not running (nothing to close).`, data: { closed: 0 } };
  }
  return { message: `Closed ${closed} ${profile.aliases[0]} process(es).`, data: { closed } };
}

export async function focusApp(params: Record<string, any>) {
  const name = String(params.name || "");
  const profile = findProfile(name);
  if (!profile) throw appNotFound(name);

  const names = profile.processNames.filter((n) => VALID_PROCESS_NAME.test(n)).join(",");
  const script = `
${psDecodeInto("namesCsv", `'${Buffer.from(names, "utf-8").toString("base64")}'`)}
$sig = '
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
'
Add-Type -MemberDefinition $sig -Name Win -Namespace LohzNative -ErrorAction SilentlyContinue
$targets = $namesCsv -split ','
$handle = [IntPtr]::Zero
foreach ($t in $targets) {
  if ([string]::IsNullOrWhiteSpace($t)) { continue }
  $proc = Get-Process -Name $t -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
  if ($proc) { $handle = $proc.MainWindowHandle; break }
}
if ($handle -eq [IntPtr]::Zero) { Write-Output "ERR|NO_WINDOW" } else {
  [LohzNative.Win]::ShowWindow($handle, 9) | Out-Null
  [LohzNative.Win]::SetForegroundWindow($handle) | Out-Null
  Write-Output "OK|focused"
}
`.trim();

  const result = await runPowerShellMarker(script, 15000);
  if (!result.ok) {
    const e = new Error(`focusApp failed: ${result.stderr || "no window found"}`);
    (e as any).code = "APP_FOCUS_FAILED";
    throw e;
  }
  return {
    message: `Focused the ${profile.aliases[0]} window.`,
    data: { app: profile.aliases[0] },
  };
}
