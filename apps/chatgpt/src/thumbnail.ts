import type { LiveViewBinding } from '@text-to-cad/ui/renderers/glb';
import type { RecentLibrary } from './library';
import { encodeBytes } from './transport';
/** A small preview of the real displayed geometry; never builds or imports another model. */
export function createThumbnailBinding(library: RecentLibrary, documentId?: string, revision?: string | null): LiveViewBinding {
  return { bind(controller) {
    if (!documentId || !revision) return () => {};
    let active = true;
    let frame = 0;
    let previousView = '';
    const schedule = () => { frame = requestAnimationFrame(() => void capture()); };
    const capture = async () => {
      const state = controller.readState();
      if (!active || !state.active) return;
      // Complete geometry can arrive before the opening camera has finished
      // fitting it. Observe the presented view, never a fixed loading delay.
      if (state.loading) { previousView = ''; schedule(); return; }
      const view = JSON.stringify([state.resource, state.revision, state.camera, state.display]);
      if (previousView !== view) { previousView = view; schedule(); return; }
      try {
        const image = await createImageBitmap(await controller.capture());
        if (!active) { image.close(); return; }
        const after = controller.readState();
        if (!after.active) { image.close(); return; }
        if (after.loading || JSON.stringify([after.resource, after.revision, after.camera, after.display]) !== view) {
          image.close(); previousView = ''; schedule(); return;
        }
        const canvas = document.createElement('canvas');
        const scale = Math.min(1, 320 / Math.max(image.width, image.height));
        canvas.width = Math.max(1, Math.round(image.width * scale)); canvas.height = Math.max(1, Math.round(image.height * scale));
        canvas.getContext('2d')!.drawImage(image, 0, 0, canvas.width, canvas.height); image.close();
        const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error('Preview encoding failed.')), 'image/png'));
        if (!active || blob.size > 256 * 1024) return;
        const bytes = await blob.arrayBuffer();
        if (active) await library.saveThumbnail(documentId, revision, `data:image/png;base64,${encodeBytes(new Uint8Array(bytes))}`);
      } catch {
        // A live capture rejects when its document changes mid-encoding. Wait
        // for that replacement; permanent capture failures keep the placeholder.
        if (!active) return;
        const after = controller.readState();
        if (after.active && (after.loading || JSON.stringify([after.resource, after.revision, after.camera, after.display]) !== view)) {
          previousView = ''; schedule();
        }
      }
    };
    schedule();
    return () => { active = false; cancelAnimationFrame(frame); };
  } };
}
