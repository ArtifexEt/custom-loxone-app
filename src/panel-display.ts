export function canKeepScreenAwake(): boolean {
  return typeof navigator.wakeLock?.request === 'function';
}

export class PanelScreenWakeLock {
  private generation = 0;
  private requested = false;
  private sentinel: WakeLockSentinel | null = null;

  constructor(private readonly reportUnavailable: (unavailable: boolean) => void) {}

  sync(enabled: boolean): void {
    if (!enabled || document.hidden || !canKeepScreenAwake()) {
      this.generation += 1;
      this.requested = false;
      const sentinel = this.sentinel;
      this.sentinel = null;
      if (sentinel && !sentinel.released) {
        void sentinel.release().catch(() => undefined);
      }
      this.reportUnavailable(false);
      return;
    }
    if (!this.requested) {
      this.requested = true;
      void this.acquire(this.generation);
    }
  }

  private async acquire(generation: number): Promise<void> {
    try {
      const sentinel = await navigator.wakeLock.request('screen');
      if (generation !== this.generation || document.hidden) {
        await sentinel.release();
        return;
      }
      this.sentinel = sentinel;
      this.reportUnavailable(false);
      sentinel.addEventListener('release', () => {
        if (this.sentinel === sentinel) {
          this.sentinel = null;
          this.reportUnavailable(!document.hidden);
        }
      }, { once: true });
    } catch {
      if (generation === this.generation && !document.hidden) {
        this.reportUnavailable(true);
      }
    }
  }
}
