/**
 * Type-safe access to the Phase 23 enrichment fields riding on
 * Memory.metadata. Keeps the underlying MemoryMetadata interface
 * unchanged while giving consumers an authoritative schema.
 */
import type { Memory } from "../memoryTypes";
import type {
  CandidateKind,
  ArchiveReason,
} from "./types";

export interface EnrichedFields {
  kind?: CandidateKind;
  status?: "active" | "archived";
  archivedAt?: number;
  archiveReason?: ArchiveReason;
  supersededBy?: string;
  supersedes?: string;
  fingerprint?: string;
  evidence?: string[];
}

export function readEnrichment(mem: Memory): EnrichedFields {
  const md = mem.metadata as unknown as EnrichedFields;
  return {
    kind: md.kind,
    status: md.status === "archived" ? "archived" : "active",
    archivedAt: md.archivedAt,
    archiveReason: md.archiveReason,
    supersededBy: md.supersededBy,
    supersedes: md.supersedes,
    fingerprint: md.fingerprint,
    evidence: Array.isArray(md.evidence) ? (md.evidence as string[]) : undefined,
  };
}

export function writeEnrichment(mem: Memory, fields: Partial<EnrichedFields>): void {
  const md = mem.metadata as unknown as EnrichedFields;
  if (fields.kind !== undefined) md.kind = fields.kind;
  if (fields.status !== undefined) md.status = fields.status;
  if (fields.archivedAt !== undefined) md.archivedAt = fields.archivedAt;
  if (fields.archiveReason !== undefined) md.archiveReason = fields.archiveReason;
  if (fields.supersededBy !== undefined) md.supersededBy = fields.supersededBy;
  if (fields.supersedes !== undefined) md.supersedes = fields.supersedes;
  if (fields.fingerprint !== undefined) md.fingerprint = fields.fingerprint;
  if (fields.evidence !== undefined) md.evidence = fields.evidence;
}

export function isArchived(mem: Memory): boolean {
  return readEnrichment(mem).status === "archived";
}
