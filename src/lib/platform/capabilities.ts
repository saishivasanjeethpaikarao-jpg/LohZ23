export type PlatformId = NodeJS.Platform;
export type CapabilityKind = "available" | "unavailable" | "platform_specific";
export interface PlatformCapability {
  capabilityId: string;
  label: string;
  available: boolean;
  kind: CapabilityKind;
  reason?: string;
}

export function getPlatformCapabilities(platform: PlatformId = process.platform): PlatformCapability[] {
  const windows = platform === "win32";
  const desktopCapture = windows || platform === "darwin" || platform === "linux";
  return [
    { capabilityId: "windows_agent", label: "Windows Agent", available: windows, kind: windows ? "available" : "platform_specific", reason: windows ? undefined : "Windows-only capability" },
    { capabilityId: "screen_capture", label: "Screen Capture", available: desktopCapture, kind: desktopCapture ? "platform_specific" : "unavailable", reason: desktopCapture ? "Requires OS permission" : "Unsupported platform" },
    { capabilityId: "microphone", label: "Microphone", available: true, kind: "platform_specific", reason: "Requires OS permission" },
    { capabilityId: "local_persistence", label: "Local Persistence", available: true, kind: "available" },
  ];
}
