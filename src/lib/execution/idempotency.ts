export interface IdempotencyRecord {
  uid: string;
  key: string;
  requestId: string;
  planId: string;
  stepId: string;
  status: "reserved" | "completed" | "failed";
  resultDigest?: string;
  createdAt: number;
  updatedAt: number;
}

export interface IdempotencyStore {
  get(uid: string, key: string): Promise<IdempotencyRecord | null>;
  put(record: IdempotencyRecord): Promise<boolean>;
  delete(uid: string, key: string): Promise<boolean>;
}
