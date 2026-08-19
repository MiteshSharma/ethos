// @vitest-environment jsdom
//
// `AvatarPicker` has interactive state (the inline validation error), so it
// needs a real DOM — same exception `PersonalityMark.test.ts` documents for
// its own `avatarUrl` error-state `useState`.

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AvatarPicker } from '../AvatarPicker';

function file(name: string, type: string, bytes: number): File {
  return new File([new Uint8Array(bytes)], name, { type });
}

describe('AvatarPicker', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('fires onSelectCurated with the clicked swatch URL', () => {
    const onSelectCurated = vi.fn();
    act(() => {
      root.render(
        createElement(AvatarPicker, {
          onSelectCurated,
          onFileSelected: vi.fn(),
          showRemove: false,
        }),
      );
    });
    const buttons = container.querySelectorAll('button[aria-label]');
    expect(buttons.length).toBe(16);
    const first = buttons[0] as HTMLButtonElement;
    const expectedUrl = first.querySelector('img')?.getAttribute('src');

    act(() => {
      first.click();
    });

    expect(onSelectCurated).toHaveBeenCalledTimes(1);
    expect(onSelectCurated).toHaveBeenCalledWith(expectedUrl);
  });

  it('fires onSelectCurated with the icon-row swatch URL', () => {
    const onSelectCurated = vi.fn();
    act(() => {
      root.render(
        createElement(AvatarPicker, {
          onSelectCurated,
          onFileSelected: vi.fn(),
          showRemove: false,
        }),
      );
    });
    const boltButton = Array.from(container.querySelectorAll('button[aria-label]')).find(
      (b) => b.getAttribute('aria-label') === 'Bolt',
    ) as HTMLButtonElement;
    expect(boltButton).toBeDefined();

    act(() => {
      boltButton.click();
    });

    expect(onSelectCurated).toHaveBeenCalledTimes(1);
    expect(onSelectCurated).toHaveBeenCalledWith('/avatars/bolt.svg');
  });

  it('renders both the Faces and Icons section labels', () => {
    act(() => {
      root.render(
        createElement(AvatarPicker, {
          onSelectCurated: vi.fn(),
          onFileSelected: vi.fn(),
          showRemove: false,
        }),
      );
    });
    expect(container.textContent).toContain('Faces');
    expect(container.textContent).toContain('Icons');
  });

  it('shows the dimension hint text', () => {
    act(() => {
      root.render(
        createElement(AvatarPicker, {
          onSelectCurated: vi.fn(),
          onFileSelected: vi.fn(),
          showRemove: false,
        }),
      );
    });
    expect(container.textContent).toContain('128×128');
  });

  it('highlights the swatch matching selectedCuratedUrl', () => {
    act(() => {
      root.render(
        createElement(AvatarPicker, {
          selectedCuratedUrl: '/avatars/nova.svg',
          onSelectCurated: vi.fn(),
          onFileSelected: vi.fn(),
          showRemove: false,
        }),
      );
    });
    const pressed = container.querySelector('button[aria-pressed="true"]');
    expect(pressed?.getAttribute('aria-label')).toBe('Nova');
  });

  it('fires onFileSelected for a valid file and shows no error', () => {
    const onFileSelected = vi.fn();
    act(() => {
      root.render(
        createElement(AvatarPicker, {
          onSelectCurated: vi.fn(),
          onFileSelected,
          showRemove: false,
        }),
      );
    });
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const goodFile = file('a.png', 'image/png', 1024);
    Object.defineProperty(input, 'files', { value: [goodFile], configurable: true });

    act(() => {
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });

    expect(onFileSelected).toHaveBeenCalledWith(goodFile);
    expect(container.querySelector('.ant-alert-error')).toBeNull();
  });

  it('rejects an oversized file — no callback, visible inline error', () => {
    const onFileSelected = vi.fn();
    act(() => {
      root.render(
        createElement(AvatarPicker, {
          onSelectCurated: vi.fn(),
          onFileSelected,
          showRemove: false,
        }),
      );
    });
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const bigFile = file('big.png', 'image/png', 5 * 1024 * 1024 + 1);
    Object.defineProperty(input, 'files', { value: [bigFile], configurable: true });

    act(() => {
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });

    expect(onFileSelected).not.toHaveBeenCalled();
    expect(container.querySelector('.ant-alert-error')).not.toBeNull();
    expect(container.textContent).toContain('5MB');
  });

  it('rejects a disallowed MIME type — no callback, visible inline error', () => {
    const onFileSelected = vi.fn();
    act(() => {
      root.render(
        createElement(AvatarPicker, {
          onSelectCurated: vi.fn(),
          onFileSelected,
          showRemove: false,
        }),
      );
    });
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const svgFile = file('a.svg', 'image/svg+xml', 100);
    Object.defineProperty(input, 'files', { value: [svgFile], configurable: true });

    act(() => {
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });

    expect(onFileSelected).not.toHaveBeenCalled();
    expect(container.querySelector('.ant-alert-error')).not.toBeNull();
    expect(container.textContent).toContain('Unsupported file type');
  });

  it('shows the Remove affordance only when showRemove is true', () => {
    act(() => {
      root.render(
        createElement(AvatarPicker, {
          onSelectCurated: vi.fn(),
          onFileSelected: vi.fn(),
          showRemove: false,
        }),
      );
    });
    expect(container.textContent).not.toContain('Remove');

    const onRemove = vi.fn();
    act(() => {
      root.render(
        createElement(AvatarPicker, {
          onSelectCurated: vi.fn(),
          onFileSelected: vi.fn(),
          onRemove,
          showRemove: true,
        }),
      );
    });
    const removeButton = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent === 'Remove',
    );
    expect(removeButton).toBeDefined();

    act(() => {
      removeButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onRemove).toHaveBeenCalledTimes(1);
  });
});
