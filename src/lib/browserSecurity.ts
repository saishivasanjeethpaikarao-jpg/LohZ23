export interface NavigationMessage { type: "NAVIGATE"; url: string; }

export function validateNavigationMessage(
  event: Pick<MessageEvent, "source" | "origin" | "data">,
  expectedSource: MessageEventSource | null,
  expectedOrigin: string
): NavigationMessage | null {
  if (!expectedSource || event.source !== expectedSource || event.origin !== expectedOrigin) return null;
  if (!event.data || typeof event.data !== "object" || event.data.type !== "NAVIGATE" || typeof event.data.url !== "string") return null;
  if (event.data.url.length > 2048) return null;
  try {
    const target = new URL(event.data.url);
    if (!["http:", "https:"].includes(target.protocol) || target.username || target.password) return null;
    return { type: "NAVIGATE", url: target.href };
  } catch { return null; }
}
