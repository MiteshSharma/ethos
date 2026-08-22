// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useKanbanBoardSync } from '../useKanbanBoardSync';

// Guards the fix for the SSE-dumps-then-refetches-per-frame bug: the
// `onmessage` handler used to invalidate the board query on EVERY frame, so a
// burst of frames (a bounded cold-connect replay, or several live events in
// quick succession) triggered one full board refetch per frame instead of
// one. A trailing-edge debounce should collapse a burst into a single
// invalidate.

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onmessage: ((ev: MessageEvent) => void) | null = null;
  readonly url: string;

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  close(): void {}

  emit(): void {
    this.onmessage?.({ data: '{}' } as MessageEvent);
  }
}

function Harness({ team }: { team: string | null }) {
  useKanbanBoardSync(team);
  return null;
}

describe('useKanbanBoardSync', () => {
  let container: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;
  let originalEventSource: typeof EventSource;

  beforeEach(() => {
    vi.useFakeTimers();
    originalEventSource = globalThis.EventSource;
    globalThis.EventSource = FakeEventSource as unknown as typeof EventSource;
    FakeEventSource.instances = [];
    queryClient = new QueryClient();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    globalThis.EventSource = originalEventSource;
    vi.useRealTimers();
  });

  function mount(team: string | null): void {
    act(() => {
      root.render(
        createElement(
          QueryClientProvider,
          { client: queryClient },
          createElement(Harness, { team }),
        ),
      );
    });
  }

  it('collapses a burst of frames into a single debounced invalidate', () => {
    mount('team-a');
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    const source = FakeEventSource.instances[0];
    expect(source).toBeDefined();

    act(() => {
      source?.emit();
      source?.emit();
      source?.emit();
    });
    // Debounced — nothing fires yet.
    expect(invalidateSpy).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(invalidateSpy).toHaveBeenCalledTimes(1);
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['kanban', 'board', 'team-a'] });
  });

  it('does not connect when team is null', () => {
    mount(null);
    expect(FakeEventSource.instances).toHaveLength(0);
  });
});
