import type { PlanStep } from "../planner/types";
import type { Observation } from "../observation/types";
import type { WorldAssertionInput, WorldEntity, WorldValue } from "./types";

function pathEntity(value: unknown, type: "file" | "folder"): WorldEntity | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const label = value.trim().slice(0, 160);
  return { id: `${type}:${label.toLowerCase()}`, label, type };
}

/** Pure adapter. It never promotes a non-verified observation. */
export function verifiedObservationToAssertion(
  uid: string,
  step: PlanStep,
  observation: Observation,
): WorldAssertionInput | null {
  if (observation.uid !== uid || observation.status !== "verified") return null;
  const tool = step.requiredTool ?? "";
  let entity: WorldEntity | null = null;
  let relation = "STATUS";
  let value: WorldValue = null;
  let scope: WorldAssertionInput["scope"] = "environment";

  if (tool === "openApp" || tool === "closeApp" || tool === "focusApp") {
    const name = String(step.arguments?.name ?? step.arguments?.appName ?? "application").slice(0, 160);
    entity = { id: `application:${name.toLowerCase()}`, label: name, type: "application" };
    value = tool === "closeApp" ? "CLOSED" : tool === "focusApp" ? "FOCUSED" : "OPEN";
  } else if (tool === "setVolume") {
    entity = { id: "device:audio", label: "Audio output", type: "device" };
    relation = "OUTPUT_VOLUME";
    const raw = step.arguments?.level ?? step.arguments?.volume;
    value = typeof raw === "number" ? raw : String(raw ?? observation.observedState).slice(0, 500);
  } else if (["createFile", "writeFile", "readFile"].includes(tool)) {
    entity = pathEntity(step.arguments?.path, "file");
    relation = tool === "readFile" ? "READABLE" : "EXISTS";
    value = true;
    scope = "project";
  } else if (tool === "createFolder") {
    entity = pathEntity(step.arguments?.path, "folder");
    relation = "EXISTS";
    value = true;
    scope = "project";
  } else if (tool === "renameFile") {
    const original = String(step.arguments?.path ?? "");
    const name = String(step.arguments?.newName ?? "");
    const split = Math.max(original.lastIndexOf("/"), original.lastIndexOf("\\"));
    entity = pathEntity(`${split >= 0 ? original.slice(0, split + 1) : ""}${name}`, "file");
    relation = "EXISTS";
    value = true;
    scope = "project";
  } else if (tool === "takeScreenshot") {
    entity = { id: "session:screenshot", label: "Screenshot", type: "session" };
    relation = "CAPTURED";
    value = true;
    scope = "session";
  } else if (tool === "clipboardWrite") {
    entity = { id: "device:clipboard", label: "Clipboard", type: "device" };
    value = "UPDATED"; // Clipboard contents are deliberately not retained.
  } else if (tool === "getSystemInfo") {
    entity = { id: "device:system", label: "System", type: "device" };
    value = "OBSERVED";
  } else {
    return null;
  }

  if (!entity) return null;
  return {
    uid, entity, relation, value, scope,
    verification: "VERIFIED",
    confidence: observation.confidence,
    observedAt: observation.timestamp,
    source: { kind: "verified_observation", id: observation.id, evidence: observation.evidence },
  };
}
