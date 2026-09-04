/**
 * Contextual Clipboard Sentinel:
 * Detects patterns in copied text and suggests proactive, 1-click assistant actions.
 */

export interface ClipboardActionChip {
  id: string;
  type: "git_repo" | "error_stack" | "json_data" | "youtube_url" | "hex_color" | "general_url";
  title: string;
  subtitle: string;
  actionText: string;
  execute: () => void | Promise<void>;
}

export function classifyClipboardContent(
  text: string,
  callbacks: {
    onDebugError: (err: string) => void;
    onOpenUrl: (url: string) => void;
    onSetAtmosphere: (color: string) => void;
    onExecuteCommand: (cmd: string) => void;
  }
): ClipboardActionChip | null {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > 50000) return null;

  // 1. Git Repository URL
  const gitMatch = trimmed.match(/^https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(?:\.git)?\/?$/i);
  if (gitMatch) {
    const repoName = gitMatch[2].replace(/\.git$/i, "");
    return {
      id: `git-${repoName}`,
      type: "git_repo",
      title: `GitHub Repo: ${repoName}`,
      subtitle: "Open or clone this repository",
      actionText: "Open in VS Code",
      execute: () => {
        callbacks.onExecuteCommand(`open vs code`);
        callbacks.onOpenUrl(trimmed);
      },
    };
  }

  // 2. YouTube Video URL
  const ytMatch = trimmed.match(/^(?:https?:\/\/)?(?:www\.)?(?:youtube\.com\/watch\?v=|youtu\.be\/)([A-Za-z0-9_-]{11})/i);
  if (ytMatch) {
    return {
      id: `yt-${ytMatch[1]}`,
      type: "youtube_url",
      title: "YouTube Video Detected",
      subtitle: trimmed.slice(0, 42) + "...",
      actionText: "Project Video",
      execute: () => {
        callbacks.onOpenUrl(trimmed);
      },
    };
  }

  // 3. Stack Trace / Error message
  const errorMatch = trimmed.match(/^(?:(?:Unhandled|Uncaught|Fatal\s+)?(?:[A-Za-z0-9_]+)?Error|TypeError|ReferenceError|SyntaxError|RangeError|Traceback|\w+Exception)\s*:/im)
    || (trimmed.includes("at ") && (trimmed.includes(".ts:") || trimmed.includes(".js:") || trimmed.includes(".py:")));
  if (errorMatch) {
    const firstLine = trimmed.split(/\r?\n/)[0].slice(0, 60);
    return {
      id: `error-${Date.now()}`,
      type: "error_stack",
      title: "Runtime Error Detected",
      subtitle: firstLine,
      actionText: "Debug with LOHZ",
      execute: () => {
        callbacks.onDebugError(trimmed);
      },
    };
  }

  // 4. Hex Color
  const colorMatch = trimmed.match(/^#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})$/);
  if (colorMatch) {
    return {
      id: `color-${colorMatch[1]}`,
      type: "hex_color",
      title: `Hex Color ${trimmed}`,
      subtitle: "Set companion atmosphere hue",
      actionText: "Apply Atmosphere",
      execute: () => {
        callbacks.onSetAtmosphere(trimmed);
      },
    };
  }

  // 5. JSON Object / Array
  if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
    try {
      const parsed = JSON.parse(trimmed);
      const isArr = Array.isArray(parsed);
      const count = isArr ? parsed.length : Object.keys(parsed).length;
      return {
        id: `json-${Date.now()}`,
        type: "json_data",
        title: `Valid JSON (${isArr ? `${count} items` : `${count} keys`})`,
        subtitle: "Formatted JSON payload on clipboard",
        actionText: "Inspect Data",
        execute: () => {
          callbacks.onExecuteCommand(`summarize this JSON data: ${trimmed.slice(0, 500)}`);
        },
      };
    } catch { /* not valid JSON */ }
  }

  // 6. Generic URL
  if (/^https?:\/\/[^\s"'<>]+$/i.test(trimmed)) {
    return {
      id: `url-${Date.now()}`,
      type: "general_url",
      title: "Web Link Copied",
      subtitle: trimmed.slice(0, 42) + (trimmed.length > 42 ? "..." : ""),
      actionText: "Open in Browser",
      execute: () => {
        callbacks.onOpenUrl(trimmed);
      },
    };
  }

  return null;
}
