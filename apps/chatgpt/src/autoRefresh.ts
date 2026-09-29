/** Visible homes follow changes made by other CAD views without scanning a folder. */
export function watchRecentModels(library: { refresh(): Promise<void> }, page: {
  window: EventTarget; document: EventTarget & { visibilityState: string };
} = { window, document }) {
  let active = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: Promise<void> | undefined;
  const refresh = () => {
    clearTimeout(timer);
    if (!active || page.document.visibilityState === 'hidden' || pending) return;
    pending = library.refresh().catch(() => {}).finally(() => {
      pending = undefined;
      if (active && page.document.visibilityState !== 'hidden') timer = setTimeout(refresh, 5000);
    });
  };
  const visible = () => { clearTimeout(timer); refresh(); };
  refresh();
  page.window.addEventListener('focus', visible);
  page.document.addEventListener('visibilitychange', visible);
  return () => {
    active = false; clearTimeout(timer);
    page.window.removeEventListener('focus', visible);
    page.document.removeEventListener('visibilitychange', visible);
  };
}
