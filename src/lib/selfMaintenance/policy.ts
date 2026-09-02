import type { AutonomyLevel, MaintenanceRisk } from "./types";

const PROTECTED = /(^|\/)(?:auth|credential|secret|safety|security|firestore\.rules|package\.json|scripts\/|windows-agent\/toolRegistry|src\/lib\/selfCoding\/)/i;
export function classifyRisk(paths: string[]): MaintenanceRisk { if (paths.some((file) => PROTECTED.test(file.replace(/\\/g, "/")))) return "CRITICAL"; if (paths.length > 8) return "HIGH"; if (paths.some((file) => /server|persistence|desktop/i.test(file))) return "MEDIUM"; return "LOW"; }
export function autonomyAllows(level: AutonomyLevel, risk: MaintenanceRisk): boolean { return level >= 2 && risk === "LOW" && level >= 5; }
export const AUTONOMY_DEFAULT: AutonomyLevel = 2;
