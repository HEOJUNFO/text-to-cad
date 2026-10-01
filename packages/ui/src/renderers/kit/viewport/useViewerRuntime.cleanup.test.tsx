import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

// A renderer that does nothing: the hook only needs its canvas and somewhere to call.
const renderers: any[] = [];
vi.mock('@text-to-cad/core/common/webglRenderer.js', () => ({
  createCadWebGlRenderer: () => {
    const domElement = document.createElement('canvas');
    const target: any = { domElement, shadowMap: {}, dispose: vi.fn(), getPixelRatio: () => 1 };
    const renderer = new Proxy(target, { get: (t, key) => (key in t ? t[key] : (t[key] = vi.fn())) });
    renderers.push(renderer);
    return renderer;
  },
}));
const buffer = { fail: false };
vi.mock('./viewportBuffer.js', () => ({
  createViewportBuffer: () => {
    if (buffer.fail) throw new Error('buffer failed');
    return { request: vi.fn(), dispose: vi.fn() };
  },
}));
vi.mock('./framePresentation.js', () => ({ createFramePresentation: () => ({ dispose: vi.fn() }) }));
// The failure under test: initialisation throws after the window's resize listener is registered.
const init = { fail: true };
vi.mock('../camera/zoomPivotReanchor.js', async (original) => {
  const actual = await original<typeof import('../camera/zoomPivotReanchor.js')>();
  return {
    ...actual,
    createZoomPivotReanchor: (...args: Parameters<typeof actual.createZoomPivotReanchor>) => {
      if (init.fail) throw new Error('init failed midway');
      return actual.createZoomPivotReanchor(...args);
    },
  };
});

import { useViewerRuntime } from './useViewerRuntime.js';

class FakeResizeObserver {
  static live = new Set<FakeResizeObserver>();
  constructor(_callback: () => void) {}
  observe() { FakeResizeObserver.live.add(this); }
  disconnect() { FakeResizeObserver.live.delete(this); }
}

beforeEach(() => {
  renderers.length = 0;
  init.fail = true;
  buffer.fail = false;
  FakeResizeObserver.live.clear();
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function options(mount: HTMLElement, extra: Record<string, unknown> = {}) {
  const noop = vi.fn();
  return new Proxy({
    mountRef: { current: mount },
    runtimeRef: { current: null },
    previewModeRef: { current: false },
    setError: vi.fn(),
    setViewerReadyTick: vi.fn(),
    getViewerThemeValue: (_theme: unknown, _key: string, fallback: unknown) => fallback,
    getPixelRatioCap: (value: number) => value,
    DEFAULT_LIGHTING: { toneMappingExposure: 1 },
    IDLE_PIXEL_RATIO_CAP: 2,
    INTERACTION_PIXEL_RATIO_CAP: 1,
    onInitializationError: vi.fn(),
    ...extra,
  } as Record<string, unknown>, { get: (target, key: string) => (key in target ? target[key] : noop) });
}

test('a viewer whose initialisation throws midway releases what it had already registered', async () => {
  const added: Array<[string, unknown]> = [];
  const removed: Array<[string, unknown]> = [];
  const add = window.addEventListener.bind(window);
  const remove = window.removeEventListener.bind(window);
  vi.spyOn(window, 'addEventListener').mockImplementation(((type: string, listener: any, opts?: any) => { added.push([type, listener]); add(type, listener, opts); }) as any);
  vi.spyOn(window, 'removeEventListener').mockImplementation(((type: string, listener: any, opts?: any) => { removed.push([type, listener]); remove(type, listener, opts); }) as any);
  const mount = document.createElement('div');
  document.body.appendChild(mount);
  const onInitializationError = vi.fn();
  const hook = renderHook(() => useViewerRuntime({ ...(options(mount) as object), onInitializationError } as any));
  await waitFor(() => expect(onInitializationError).toHaveBeenCalled());
  const resize = added.filter(([type]) => type === 'resize');
  expect(resize).toHaveLength(1);
  expect(FakeResizeObserver.live.size).toBe(1);

  hook.unmount();

  expect(removed).toContainEqual(resize[0]);
  expect(FakeResizeObserver.live.size).toBe(0);
  // And the renderer the failed start created is let go with its canvas.
  expect(renderers).toHaveLength(1);
  expect(renderers[0].dispose).toHaveBeenCalled();
  expect(mount.contains(renderers[0].domElement)).toBe(false);
});

test('a viewer whose runtime ref was cleared under it still releases its listeners, observer and renderer', async () => {
  init.fail = false;
  const added: Array<[string, unknown]> = [];
  const removed: Array<[string, unknown]> = [];
  const add = window.addEventListener.bind(window);
  const remove = window.removeEventListener.bind(window);
  vi.spyOn(window, 'addEventListener').mockImplementation(((type: string, listener: any, opts?: any) => { added.push([type, listener]); add(type, listener, opts); }) as any);
  vi.spyOn(window, 'removeEventListener').mockImplementation(((type: string, listener: any, opts?: any) => { removed.push([type, listener]); remove(type, listener, opts); }) as any);
  const mount = document.createElement('div');
  document.body.appendChild(mount);
  const base = options(mount) as { runtimeRef: { current: any } };
  const hook = renderHook(() => useViewerRuntime(base as any));
  await waitFor(() => expect(base.runtimeRef.current).not.toBeNull());
  const listeners = added.filter(([type]) => type === 'resize' || type === 'keydown');
  expect(listeners.length).toBeGreaterThanOrEqual(2);

  base.runtimeRef.current = null;
  hook.unmount();

  for (const listener of listeners) expect(removed).toContainEqual(listener);
  expect(FakeResizeObserver.live.size).toBe(0);
  expect(renderers[0].dispose).toHaveBeenCalled();
});

test('a renderer whose start throws before it is mounted still lets go of its context and canvas', async () => {
  buffer.fail = true;
  const mount = document.createElement('div');
  document.body.appendChild(mount);
  const onInitializationError = vi.fn();
  const hook = renderHook(() => useViewerRuntime({ ...(options(mount) as object), onInitializationError } as any));
  await waitFor(() => expect(onInitializationError).toHaveBeenCalled());
  hook.unmount();

  expect(renderers).toHaveLength(1);
  expect(renderers[0].dispose).toHaveBeenCalled();
  expect(mount.querySelector('canvas')).toBeNull();
});

