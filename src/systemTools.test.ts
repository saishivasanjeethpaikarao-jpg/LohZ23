import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  run: vi.fn(async (_script: string, _timeout?: number) => ({ ok: true, payload: "0.5000|unmuted", stderr: "", timedOut: false })),
}));

vi.mock("../windows-agent/utils/powershell", () => ({
  psDecodeInto: vi.fn(),
  runPowerShellMarker: mocks.run,
}));

import { getVolume, setVolume } from "../windows-agent/tools/system";

describe("Windows volume command templates", () => {
  beforeEach(() => mocks.run.mockClear());

  it("builds a balanced base64 decode prefix for volume reads", async () => {
    expect(await getVolume()).toMatchObject({ data: { levelPercent: 50, muted: false } });
    const script = String(mocks.run.mock.calls[0][0]);
    expect(script).toMatch(/FromBase64String\('[A-Za-z0-9+/=]+'\)\)/);
    expect(script).toContain("[LohzAudio.Volume]::Report()");
  });

  it("uses the same fixed prefix for level and mute writes", async () => {
    mocks.run.mockResolvedValue({ ok: true, payload: "set", stderr: "", timedOut: false });
    await setVolume({ level: 25 });
    await setVolume({ mute: true });
    expect(String(mocks.run.mock.calls[0][0])).toContain("SetScalar(0.2500f)");
    expect(String(mocks.run.mock.calls[1][0])).toContain("SetMute([bool]$true)");
    for (const [script] of mocks.run.mock.calls) {
      expect(String(script)).toMatch(/FromBase64String\('[A-Za-z0-9+/=]+'\)\)/);
    }
  });
});
