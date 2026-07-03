export type PaneDividerDragListener = (active: boolean) => void;

let active = false;
const listeners = new Set<PaneDividerDragListener>();

function notify(): void {
  for (const listener of [...listeners]) {
    listener(active);
  }
}

export function beginPaneDividerDrag(): void {
  if (active) {
    return;
  }
  active = true;
  notify();
}

export function endPaneDividerDrag(): void {
  if (!active) {
    return;
  }
  active = false;
  notify();
}

export function isPaneDividerDragActive(): boolean {
  return active;
}

export function subscribePaneDividerDrag(
  listener: PaneDividerDragListener
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function resetPaneDividerDragForTests(): void {
  active = false;
  listeners.clear();
}
