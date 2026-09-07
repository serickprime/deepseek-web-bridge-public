export interface MutexTask<T = unknown> {
  run(): Promise<T>;
}

export class KeyedMutex {
  private readonly chains = new Map<string, Promise<unknown>>();

  async withLock<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const next = previous.then(() => gate);
    this.chains.set(key, next);
    try {
      await previous;
      return await task();
    } finally {
      release();
      if (this.chains.get(key) === next) {
        this.chains.delete(key);
      }
    }
  }
}
