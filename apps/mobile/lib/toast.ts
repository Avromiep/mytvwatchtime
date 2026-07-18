/**
 * Lightweight toast singleton — same imperative pattern as lib/dialog.ts.
 * Rendered once by <ToastHost /> near the app root; callable from anywhere.
 */
export interface ToastEntry {
  id: number;
  message: string;
}

let current: ToastEntry | null = null;
let seq = 0;
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((l) => l());
}

export function showToast(message: string) {
  current = { id: ++seq, message };
  emit();
}

export function dismissToast() {
  if (!current) return;
  current = null;
  emit();
}

export function getToast(): ToastEntry | null {
  return current;
}

export function subscribeToast(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
