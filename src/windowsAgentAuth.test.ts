import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import fs from "fs";
import { bearerAuth, resolveToken, safeEqual, tokenFilePath } from "../windows-agent/auth";

function fakeRes() {
  return {
    statusCode: 0,
    body: null as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
  };
}

describe("Windows Agent authentication", () => {
  // Dev-server / agent runs can leave a real token behind — always start clean.
  function scrubTokenState(): void {
    delete process.env.LOHZ_AGENT_TOKEN;
    if (fs.existsSync(tokenFilePath())) {
      fs.rmSync(tokenFilePath());
    }
  }

  beforeEach(scrubTokenState);
  afterEach(scrubTokenState);

  it("generates and persists a 256-bit token on first run", () => {
    const { token, source } = resolveToken();
    expect(source).toBe("generated");
    expect(token.length).toBe(64);
    expect(fs.existsSync(tokenFilePath())).toBe(true);
    const reread = resolveToken();
    expect(reread.source).toBe("file");
    expect(reread.token).toBe(token);
  });

  it("prefers a sufficiently long env token", () => {
    process.env.LOHZ_AGENT_TOKEN = "x".repeat(40);
    const { token, source } = resolveToken();
    expect(source).toBe("env");
    expect(token).toBe("x".repeat(40));
  });

  it("rejects short or missing env tokens", () => {
    process.env.LOHZ_AGENT_TOKEN = "short";
    const first = resolveToken();
    expect(first.source === "file" || first.source === "generated").toBe(true);

    delete process.env.LOHZ_AGENT_TOKEN;
    if (fs.existsSync(tokenFilePath())) fs.rmSync(tokenFilePath());
    const second = resolveToken();
    expect(second.token.length).toBe(64);
  });

  it("compares tokens in constant time without length leaks", () => {
    expect(safeEqual("abcdef", "abcdef")).toBe(true);
    expect(safeEqual("abcdef", "abcdeg")).toBe(false);
    expect(safeEqual("abc", "abcdef")).toBe(false);
  });

  it("bearerAuth rejects missing, malformed, and wrong tokens", () => {
    process.env.LOHZ_AGENT_TOKEN = "t".repeat(40);
    const expected = resolveToken().token;
    const middleware = bearerAuth(expected);

    const next = vi.fn();

    let res = fakeRes();
    middleware({ headers: {} }, res, next);
    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();

    res = fakeRes();
    middleware({ headers: { authorization: "Basic abc" } }, res, next);
    expect(res.statusCode).toBe(401);

    res = fakeRes();
    middleware({ headers: { authorization: `Bearer ${"w".repeat(64)}` } }, res, next);
    expect(res.statusCode).toBe(403);
    expect(next).not.toHaveBeenCalled();

    res = fakeRes();
    middleware({ headers: { authorization: `Bearer ${expected}` } }, res, next);
    expect(res.statusCode).toBe(0);
    expect(next).toHaveBeenCalledTimes(1);
  });
});
