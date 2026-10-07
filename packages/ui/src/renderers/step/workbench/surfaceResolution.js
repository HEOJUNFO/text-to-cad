import { SurfaceResolutionError } from "@text-to-cad/core/client";
export { SurfaceResolutionError };

export function resolveSurfaceComponents(descriptor, requested, { signal, client, onReady, onFailed, tessellation } = {}) {
  if (!client?.resolveSurfaceComponents) throw new TypeError("Surface resolution requires a CAD workspace service");
  return client.resolveSurfaceComponents(descriptor, requested, {
    signal, ...(onReady ? { onReady } : {}), ...(onFailed ? { onFailed } : {}),
    ...(tessellation != null ? { tessellation } : {}),
  });
}
