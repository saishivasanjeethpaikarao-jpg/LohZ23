import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const readSource = (relativePath: string): string =>
  readFileSync(new URL(relativePath, import.meta.url), "utf8");

describe("browser authentication boundary", () => {
  it("keeps BrowserAgent traffic behind authenticated same-origin APIs", () => {
    const source = readSource("./components/BrowserAgent.tsx");

    expect(source).toContain("const token = await getIdToken()");
    expect(source).toContain('fetch("/api/agent/status", { headers })');
    expect(source).toMatch(/fetch\(`\/api\/youtube-search[^\n]+\{ headers \}\)/);
    expect(source).not.toContain("localhost:3001");
  });

  it("adds authentication to every credential administration operation", () => {
    const source = readSource("./components/Settings.tsx");

    expect(source).toContain("const token = await getIdToken()");
    expect(source).toContain('fetch("/api/credentials/status", { headers })');
    expect(source).toMatch(/method: "POST", headers: \{ "Content-Type": "application\/json", \.\.\.authHeaders \}/);
    expect(source).toMatch(/method: "DELETE", headers: authHeaders/);
    expect(source).toContain("body: JSON.stringify({ value: state.apiKey })");
  });
});
