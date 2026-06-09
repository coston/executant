/** Maps event names to their payload types. */
export type EventMap = Record<string, unknown>;

export interface TypedEmitter<Events extends EventMap> {
  on<K extends keyof Events>(
    event: K,
    handler: (payload: Events[K]) => void,
  ): void;
  off<K extends keyof Events>(
    event: K,
    handler: (payload: Events[K]) => void,
  ): void;
  emit<K extends keyof Events>(event: K, payload: Events[K]): void;
  once<K extends keyof Events>(
    event: K,
    handler: (payload: Events[K]) => void,
  ): void;
}
