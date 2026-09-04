/**
 * Screenshot tool: takeScreenshot.
 * Captures the virtual screen, saves to windows-agent/screenshots/shot-YYYYMMDD-HHMMSS.png.
 * Path is generated server-side (no user input), and the value embedded into PS
 * is a base64 literal — never raw user-supplied text.
 */
import fs from "fs";
import path from "path";
import { runPowerShell } from "../utils/powershell";
import { runtimeDataRoot } from "../../src/lib/runtimePaths";

function safeFileName(name: string): boolean {
  return /^shot-\d{8}-\d{6}\.png$/.test(name);
}

function generateScreenshotPath(): { absPath: string; relPath: string } {
  const dir = process.env.LOHZ_DATA_DIR ? runtimeDataRoot("windows-agent", "screenshots") : path.join(process.cwd(), "windows-agent", "screenshots");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const now = new Date();
  const pad = (n: number) => n.toString().padStart(2, "0");
  const fileName = `shot-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.png`;
  if (!safeFileName(fileName)) {
    throw new Error("Generated screenshot filename failed safety check.");
  }
  return { absPath: path.join(dir, fileName), relPath: fileName };
}

export async function takeScreenshot() {
  const { absPath, relPath } = generateScreenshotPath();
  const b64 = Buffer.from(absPath, "utf-8").toString("base64");


  const scriptFinal = `
$resolved = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${b64}'))
Add-Type -AssemblyName System.Windows.Forms -ErrorAction SilentlyContinue
Add-Type -AssemblyName System.Drawing -ErrorAction SilentlyContinue
$bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
$bmp = New-Object System.Drawing.Bitmap($bounds.Width, $bounds.Height)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($bounds.X, $bounds.Y, 0, 0, $bmp.Size)
$bmp.Save($resolved, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
Write-Output ("OK|" + $bounds.Width + "x" + $bounds.Height)
`.trim();

  const result = await runPowerShell(scriptFinal, 20000);
  if (result.timedOut || result.exitCode !== 0) {
    const e = new Error(`takeScreenshot failed: ${result.stderr || "timeout"}`);
    (e as any).code = "SCREENSHOT_FAILED";
    throw e;
  }
  let stat;
  try {
    stat = fs.statSync(absPath);
  } catch {
    const e = new Error("Screenshot file was not created.");
    (e as any).code = "SCREENSHOT_FILE_MISSING";
    throw e;
  }
  const parts = (result.stdout.split(/\r?\n/)[0] || "").split("|");
  const dims = parts[1] || "";
  return {
    message: `Captured screen (${dims}, ${stat.size} bytes) to ${absPath}.`,
    data: { path: absPath, relPath, dimensions: dims, sizeBytes: stat.size },
  };
}
