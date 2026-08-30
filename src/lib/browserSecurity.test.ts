import { describe, expect, it } from "vitest";
import { validateNavigationMessage } from "./browserSecurity";

describe("BrowserAgent message boundary", () => {
  const frame = {} as MessageEventSource;
  it("accepts only the expected frame and origin", () => {
    expect(validateNavigationMessage({ source: frame, origin: "https://lohz.test", data: { type: "NAVIGATE", url: "https://example.com/a" } }, frame, "https://lohz.test"))
      .toEqual({ type: "NAVIGATE", url: "https://example.com/a" });
  });
  it("rejects unknown source, origin, schema, credentials, and active protocols", () => {
    expect(validateNavigationMessage({ source: {} as MessageEventSource, origin: "https://lohz.test", data: { type: "NAVIGATE", url: "https://example.com" } }, frame, "https://lohz.test")).toBeNull();
    expect(validateNavigationMessage({ source: frame, origin: "https://evil.test", data: { type: "NAVIGATE", url: "https://example.com" } }, frame, "https://lohz.test")).toBeNull();
    expect(validateNavigationMessage({ source: frame, origin: "https://lohz.test", data: { type: "CONTROL", url: "https://example.com" } }, frame, "https://lohz.test")).toBeNull();
    expect(validateNavigationMessage({ source: frame, origin: "https://lohz.test", data: { type: "NAVIGATE", url: "https://u:p@example.com" } }, frame, "https://lohz.test")).toBeNull();
    expect(validateNavigationMessage({ source: frame, origin: "https://lohz.test", data: { type: "NAVIGATE", url: "javascript:alert(1)" } }, frame, "https://lohz.test")).toBeNull();
  });
});
