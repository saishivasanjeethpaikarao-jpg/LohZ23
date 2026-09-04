import { describe, it, expect, vi } from "vitest";
import * as powershellUtils from "../../../windows-agent/utils/powershell";
import { mouseClick, mouseMove, keyType, hotkey } from "../../../windows-agent/tools/automation";

describe("Automation Primitives", () => {
  describe("mouseClick", () => {
    it("calls powershell with coordinates and left button", async () => {
      const spy = vi.spyOn(powershellUtils, "runPowerShell").mockResolvedValue({
        ok: true,
        exitCode: 0,
        stdout: "OK|100,200,left",
        stderr: "",
        timedOut: false,
      });

      const res = await mouseClick({ x: 100, y: 200, button: "left" });
      expect(res.data.x).toBe(100);
      expect(res.data.y).toBe(200);
      expect(res.data.button).toBe("left");
      expect(spy).toHaveBeenCalled();
      spy.mockRestore();
    });
  });

  describe("mouseMove", () => {
    it("moves cursor to designated coordinates", async () => {
      const spy = vi.spyOn(powershellUtils, "runPowerShell").mockResolvedValue({
        ok: true,
        exitCode: 0,
        stdout: "OK|500,400",
        stderr: "",
        timedOut: false,
      });

      const res = await mouseMove({ x: 500, y: 400 });
      expect(res.data.x).toBe(500);
      expect(res.data.y).toBe(400);
      expect(spy).toHaveBeenCalled();
      spy.mockRestore();
    });
  });

  describe("keyType", () => {
    it("types text via base64 safely", async () => {
      const spy = vi.spyOn(powershellUtils, "runPowerShell").mockResolvedValue({
        ok: true,
        exitCode: 0,
        stdout: "OK|typed",
        stderr: "",
        timedOut: false,
      });

      const res = await keyType({ text: "Hello LOHZ!" });
      expect(res.data.length).toBe(11);
      expect(spy).toHaveBeenCalled();
      spy.mockRestore();
    });
  });

  describe("hotkey", () => {
    it("maps ctrl+s to ^s", async () => {
      const spy = vi.spyOn(powershellUtils, "runPowerShell").mockResolvedValue({
        ok: true,
        exitCode: 0,
        stdout: "OK|^s",
        stderr: "",
        timedOut: false,
      });

      const res = await hotkey({ keys: "ctrl+s" });
      expect(res.data.sequence).toBe("^s");
      spy.mockRestore();
    });

    it("handles win+d desktop toggle", async () => {
      const spy = vi.spyOn(powershellUtils, "runPowerShell").mockResolvedValue({
        ok: true,
        exitCode: 0,
        stdout: "OK|toggle_desktop",
        stderr: "",
        timedOut: false,
      });

      const res = await hotkey({ keys: "win+d" });
      expect(res.data.keys).toBe("win+d");
      spy.mockRestore();
    });
  });
});
