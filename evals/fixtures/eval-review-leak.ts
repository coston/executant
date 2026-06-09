type Handler = (data: unknown) => void;

export class EventBus {
  private handlers = new Map<string, Set<Handler>>();
  private recentPayloads = new Map<string, unknown[]>();

  on(event: string, handler: Handler): void {
    if (!this.handlers.has(event)) {
      this.handlers.set(event, new Set());
    }
    this.handlers.get(event)!.add(handler);
  }

  emit(event: string, data: unknown): void {
    // Keep last 1000 payloads for debugging
    if (!this.recentPayloads.has(event)) {
      this.recentPayloads.set(event, []);
    }
    const payloads = this.recentPayloads.get(event)!;
    payloads.push(data);
    // No eviction — just keeps growing

    this.handlers.get(event)?.forEach((h) => h(data));
  }

  off(event: string, handler: Handler): void {
    this.handlers.get(event)?.delete(handler);
  }
}
