import type { LiveViewBinding } from '@text-to-cad/ui/renderers/glb';
import type { RecentLibrary } from './library';
import { encodeBytes } from './transport';
/** A small preview of the real displayed geometry; never builds or imports another model. */
export function createThumbnailBinding(library: RecentLibrary, recentId?: string, revision?: string | null): LiveViewBinding {
  return { bind(controller) {
    if (!recentId || !revision) return () => {};
    let active = true;
    let frame = 0;
    const capture = async () => {
      const state = controller.readState();
      if (!active || !state.active) return;
      if (state.loading) { frame = requestAnimationFrame(() => void capture()); return; }
      try {
        const image = await createImageBitmap(await controller.capture());
        if (!active) { image.close(); return; }
        const canvas = document.createElement('canvas');
        const scale = Math.min(1, 320 / Math.max(image.width, image.height));
        canvas.width = Math.max(1, Math.round(image.width * scale)); canvas.height = Math.max(1, Math.round(image.height * scale));
        canvas.getContext('2d')!.drawImage(image, 0, 0, canvas.width, canvas.height); image.close();
        const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error('Preview encoding failed.')), 'image/png'));
        if (!active || blob.size > 256 * 1024) return;
        const bytes = await blob.arrayBuffer();
        if (active) await library.saveThumbnail(recentId, revision, `data:image/png;base64,${encodeBytes(new Uint8Array(bytes))}`);
      } catch { /* Preview failure leaves the model view and placeholder usable. */ }
    };
    frame = requestAnimationFrame(() => void capture());
    return () => { active = false; cancelAnimationFrame(frame); };
  } };
}
