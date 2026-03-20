export interface ProgressEvent {
  step: string;
  status: 'running' | 'completed' | 'cached' | 'done';
  label: string;
}

export type ProgressCallback = (event: ProgressEvent) => void;

const callbacks = new Map<string, ProgressCallback>();

export const ProgressEmitter = {
  register(sessionId: string, cb: ProgressCallback): void {
    callbacks.set(sessionId, cb);
  },

  unregister(sessionId: string): void {
    callbacks.delete(sessionId);
  },

  emit(sessionId: string, event: ProgressEvent): void {
    callbacks.get(sessionId)?.(event);
  },

  has(sessionId: string): boolean {
    return callbacks.has(sessionId);
  },
};
