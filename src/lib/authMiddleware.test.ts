import { afterEach, describe, expect, it } from "vitest";
import { authMiddleware, createVerifiedAuthMiddleware, resetAuthStateForTests, verifyToken } from "../../server/authMiddleware";

function invoke(middleware: any, input: { authorization?: string; devUid?: string; body?: unknown } = {}) {
  const req: any = {
    body: input.body ?? {},
    headers: input.authorization ? { authorization: input.authorization } : {},
    header(name: string) { return name.toLowerCase() === "x-lohz-dev-uid" ? input.devUid : this.headers[name.toLowerCase()]; },
  };
  const result: any = { statusCode: 200, body: undefined, next: false };
  const res: any = {
    status(code: number) { result.statusCode = code; return this; },
    json(body: unknown) { result.body = body; return this; },
  };
  middleware(req, res, () => { result.next = true; });
  return new Promise<{ req: any; result: any }>((resolve) => setTimeout(() => resolve({ req, result }), 0));
}

const saved = { ...process.env };
afterEach(() => {
  process.env.NODE_ENV = saved.NODE_ENV;
  process.env.FIREBASE_SERVICE_ACCOUNT_PATH = saved.FIREBASE_SERVICE_ACCOUNT_PATH;
  process.env.LOHZ_ALLOW_INSECURE_DEV_AUTH = saved.LOHZ_ALLOW_INSECURE_DEV_AUTH;
  resetAuthStateForTests();
});

describe("Phase 33 authentication", () => {
  it("fails closed in production when authentication is unavailable", async () => {
    process.env.NODE_ENV = "production";
    process.env.FIREBASE_SERVICE_ACCOUNT_PATH = "./definitely-missing-service-account.json";
    process.env.LOHZ_ALLOW_INSECURE_DEV_AUTH = "1";
    const { result } = await invoke(authMiddleware);
    expect(result.next).toBe(false);
    expect(result.statusCode).toBe(503);
  });
  it("allows the development bypass only when explicitly enabled", async () => {
    process.env.NODE_ENV = "development";
    process.env.FIREBASE_SERVICE_ACCOUNT_PATH = "./definitely-missing-service-account.json";
    process.env.LOHZ_ALLOW_INSECURE_DEV_AUTH = "1";
    const { req, result } = await invoke(authMiddleware, { devUid: "developer-a" });
    expect(result.next).toBe(true);
    expect(req.userId).toBe("developer-a");
  });
  it("requires an explicit valid identity even when the development bypass is enabled", async () => {
    process.env.NODE_ENV = "development";
    process.env.FIREBASE_SERVICE_ACCOUNT_PATH = "./definitely-missing-service-account.json";
    process.env.LOHZ_ALLOW_INSECURE_DEV_AUTH = "1";

    const missing = await invoke(authMiddleware);
    const malformed = await invoke(authMiddleware, { devUid: "../forged" });

    expect(missing.result.next).toBe(false);
    expect(missing.result.statusCode).toBe(401);
    expect(malformed.result.next).toBe(false);
    expect(malformed.result.statusCode).toBe(401);
  });
  it("requires the explicit dev token format for WebSocket authentication", async () => {
    process.env.NODE_ENV = "development";
    process.env.FIREBASE_SERVICE_ACCOUNT_PATH = "./definitely-missing-service-account.json";
    process.env.LOHZ_ALLOW_INSECURE_DEV_AUTH = "1";

    expect(await verifyToken("")).toBeNull();
    expect(await verifyToken("developer-a")).toBeNull();
    expect(await verifyToken("dev:../forged")).toBeNull();
    expect(await verifyToken("dev:developer-a")).toBe("developer-a");
  });
  it("uses the verified UID and ignores a forged body UID", async () => {
    const middleware = createVerifiedAuthMiddleware(async (token) => token === "token-a" ? "user-a" : Promise.reject(new Error("bad")));
    const { req, result } = await invoke(middleware, { authorization: "Bearer token-a", body: { uid: "user-b", userId: "user-b" } });
    expect(result.next).toBe(true);
    expect(req.userId).toBe("user-a");
  });
  it("keeps independently verified users isolated", async () => {
    const middleware = createVerifiedAuthMiddleware(async (token) => `uid-${token}`);
    const [a, b] = await Promise.all([invoke(middleware, { authorization: "Bearer a" }), invoke(middleware, { authorization: "Bearer b" })]);
    expect(a.req.userId).toBe("uid-a");
    expect(b.req.userId).toBe("uid-b");
  });
});
