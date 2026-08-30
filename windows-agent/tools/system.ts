/**
 * System tools: getSystemInfo / getVolume / setVolume.
 *
 * getSystemInfo uses Node os module (no shell).
 * getVolume / setVolume use a FIXED C# COM interop script that talks to the
 * Windows Core Audio API. No user input is interpolated; volume values are
 * integers passed in as validated parameters.
 */
import os from "os";
import { psDecodeInto, runPowerShellMarker } from "../utils/powershell";

export async function getSystemInfo() {
  const cpus = os.cpus();
  const data = {
    hostname: os.hostname(),
    platform: os.platform(),
    osRelease: os.release(),
    osType: os.type(),
    arch: os.arch(),
    cpuModel: cpus[0]?.model || "unknown",
    cpuCount: cpus.length,
    totalMemoryBytes: os.totalmem(),
    freeMemoryBytes: os.freemem(),
    uptimeSeconds: Math.round(os.uptime()),
    nodeVersion: process.version,
    agentUptimeSeconds: Math.round(process.uptime()),
    user: os.userInfo().username,
  };
  return { message: "System info collected.", data };
}

const C_SHARP_VOLUME = `
using System;
using System.Runtime.InteropServices;

namespace LohzAudio {
  [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumeratorCom {}

  [Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDeviceEnumerator {
    int EnumAudioEndpoints(int dataFlow, int stateMask, out IntPtr devices);
    int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice device);
    int GetDevice(string id, out IMMDevice device);
    int RegisterEndpointNotificationCallback(IntPtr client);
    int UnregisterEndpointNotificationCallback(IntPtr client);
  }

  [Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDevice {
    int Activate(ref Guid iid, uint clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object iface);
  }

  [Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioEndpointVolume {
    int RegisterControlChangeNotify(IntPtr client);
    int UnregisterControlChangeNotify(IntPtr client);
    int GetChannelCount(out uint channels);
    int SetMasterVolumeLevel(float db, Guid context);
    int SetMasterVolumeLevelScalar(float level, Guid context);
    int GetMasterVolumeLevel(out float db);
    int GetMasterVolumeLevelScalar(out float level);
    int SetChannelVolumeLevel(uint channel, float db, Guid context);
    int SetChannelVolumeLevelScalar(uint channel, float level, Guid context);
    int GetChannelVolumeLevel(uint channel, out float db);
    int GetChannelVolumeLevelScalar(uint channel, out float level);
    int SetMute(bool mute, Guid context);
    int GetMute(out bool mute);
  }

  public static class Volume {
    static object Activate() {
      var en = (IMMDeviceEnumerator)(object)new MMDeviceEnumeratorCom();
      IMMDevice dev;
      en.GetDefaultAudioEndpoint(0, 1, out dev);
      var iid = typeof(IAudioEndpointVolume).GUID;
      object o;
      dev.Activate(ref iid, 23, IntPtr.Zero, out o);
      return o;
    }

    public static string Report() {
      var v = (IAudioEndpointVolume)Activate();
      float level;
      v.GetMasterVolumeLevelScalar(out level);
      bool mute;
      v.GetMute(out mute);
      return level.ToString("F4") + "|" + (mute ? "muted" : "unmuted");
    }

    public static void SetScalar(float level) {
      var v = (IAudioEndpointVolume)Activate();
      v.SetMasterVolumeLevelScalar(level, Guid.Empty);
    }

    public static void SetMute(bool m) {
      var v = (IAudioEndpointVolume)Activate();
      v.SetMute(m, Guid.Empty);
    }
  }
}
`.trim();

const SCRIPT_PREFIX = `
$code = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${Buffer.from(C_SHARP_VOLUME, "utf-8").toString("base64")}')
Add-Type -TypeDefinition $code -Language CSharp
`;

export async function getVolume() {
  const script = `
$code = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${Buffer.from(C_SHARP_VOLUME, "utf-8").toString("base64")}')
Add-Type -TypeDefinition $code -Language CSharp
Write-Output ("OK|" + [LohzAudio.Volume]::Report())
`.trim();

  const result = await runPowerShellMarker(script, 15000);
  if (!result.ok) {
    const e = new Error(`getVolume failed: ${result.stderr || "COM unavailable"}`);
    (e as any).code = "VOLUME_GET_FAILED";
    throw e;
  }
  const [scalarStr, muteStr] = result.payload.split("|");
  const levelScalar = parseFloat(scalarStr);
  if (Number.isNaN(levelScalar)) {
    const e = new Error("Unexpected volume payload from PowerShell.");
    (e as any).code = "VOLUME_PAYLOAD_INVALID";
    throw e;
  }
  const levelPercent = Math.round(levelScalar * 100);
  const muted = muteStr === "muted";
  return {
    message: muted ? `Volume muted.` : `Volume is ${levelPercent}%.`,
    data: { levelPercent, muted },
  };
}

export async function setVolume(params: Record<string, any>) {
  const { level, mute } = params;
  if (level !== undefined && mute !== undefined) {
    const e = new Error("Provide only one of 'level' or 'mute', not both.");
    (e as any).code = "PARAM_CONFLICT";
    throw e;
  }

  if (level !== undefined) {
    const lvl = Number(level);
    if (!Number.isFinite(lvl) || lvl < 0 || lvl > 100) {
      const e = new Error("'level' must be a number 0..100.");
      (e as any).code = "PARAM_INVALID";
      throw e;
    }
    const scalar = lvl / 100;
    const script = `
$code = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${Buffer.from(C_SHARP_VOLUME, "utf-8").toString("base64")}')
Add-Type -TypeDefinition $code -Language CSharp
[LohzAudio.Volume]::SetScalar(${scalar.toFixed(4)}f)
Write-Output "OK|set"
`.trim();
    const result = await runPowerShellMarker(script, 15000);
    if (!result.ok) {
      const e = new Error(`setVolume failed: ${result.stderr}`);
      (e as any).code = "VOLUME_SET_FAILED";
      throw e;
    }
    return { message: `Volume set to ${lvl}%.`, data: { levelPercent: lvl } };
  }

  if (mute !== undefined) {
    const m = Boolean(mute);
    const script = `
$code = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${Buffer.from(C_SHARP_VOLUME, "utf-8").toString("base64")}')
Add-Type -TypeDefinition $code -Language CSharp
[LohzAudio.Volume]::SetMute([bool]$${1 /* dummy to avoid interpolation issues */})
Write-Output "OK|mute"
`.trim();
    // The above has a placeholder issue — rewrite cleanly:
    const cleanScript = `
$code = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${Buffer.from(C_SHARP_VOLUME, "utf-8").toString("base64")}')
Add-Type -TypeDefinition $code -Language CSharp
[LohzAudio.Volume]::SetMute([bool]${m ? "$true" : "$false"})
Write-Output "OK|mute"
`.trim();
    const result = await runPowerShellMarker(cleanScript, 15000);
    if (!result.ok) {
      const e = new Error(`setVolume(mute) failed: ${result.stderr}`);
      (e as any).code = "VOLUME_SET_FAILED";
      throw e;
    }
    return { message: m ? "Volume muted." : "Volume unmuted.", data: { muted: m } };
  }

  const e = new Error("Provide either 'level' (0..100) or 'mute' (boolean).");
  (e as any).code = "PARAM_MISSING";
  throw e;
}

// keep psDecodeInto referenced (used elsewhere in this module family)
export { psDecodeInto };
