import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";

describe("legacy proxy isolation", () => {
  it("keeps both same-origin proxy routes terminated with 410 before legacy fetch code", () => {
    const source = fs.readFileSync(path.resolve("server.ts"), "utf8");
    for (const marker of ['app.get("/api/proxy"', 'app.get("/api/web-proxy"']) {
      const start = source.indexOf(marker);
      const nextRoute = source.indexOf("\n  app.", start + marker.length);
      const body = source.slice(start, nextRoute === -1 ? undefined : nextRoute);
      expect(start).toBeGreaterThanOrEqual(0);
      expect(body.indexOf("res.status(410)")).toBeGreaterThanOrEqual(0);
      expect(body.indexOf("return;")).toBeGreaterThan(body.indexOf("res.status(410)"));
      expect(body.indexOf("res.status(410)")).toBeLessThan(body.indexOf("fetch("));
    }
  });
});
