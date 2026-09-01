export class ExecutionReplayCache<T> {
  private readonly entries = new Map<string, Promise<T>>();
  constructor(private readonly maxEntries = 500) {}

  run(requestId: string, task: () => Promise<T>): Promise<T> {
    if (!/^[A-Za-z0-9_.:#-]{1,200}$/.test(requestId)) {
      return Promise.reject(new Error("Invalid requestId"));
    }
    const existing = this.entries.get(requestId);
    if (existing) return existing;
    const work = Promise.resolve().then(task);
    this.entries.set(requestId, work);
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (oldest) this.entries.delete(oldest); else break;
    }
    return work;
  }
}
