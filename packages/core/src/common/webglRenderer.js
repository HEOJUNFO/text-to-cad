export function cadWebGlRendererAttributes({
  stencil = true,
  alpha = true,
  antialias = true,
  powerPreference = "high-performance",
  preserveDrawingBuffer = false,
  logarithmicDepthBuffer = true
} = {}) {
  return {
    stencil,
    alpha,
    antialias,
    powerPreference,
    preserveDrawingBuffer,
    logarithmicDepthBuffer
  };
}

export function fallbackCadWebGlRendererAttributes(options = {}) {
  return {
    ...cadWebGlRendererAttributes(options),
    antialias: false,
    powerPreference: "default",
    logarithmicDepthBuffer: false
  };
}

function createCanvas() {
  return typeof document === "undefined" ? undefined : document.createElement("canvas");
}

// A renderer whose constructor threw has no `dispose()` to call: the canvas it was given is
// the only handle left on whatever context it managed to create before failing. Ask the canvas
// for that context (the same one comes back) and lose it, so the failed attempt does not hold
// a GPU context until garbage collection.
function releaseFailedAttempt(canvas) {
  try {
    const context = canvas?.getContext?.("webgl2") || canvas?.getContext?.("webgl");
    context?.getExtension?.("WEBGL_lose_context")?.loseContext?.();
  } catch {
    // Nothing to release, or the context is already gone.
  }
}

export function createCadWebGlRenderer(THREE, {
  allowFallback = false,
  isRecoverableError = () => true,
  createCanvas: makeCanvas = createCanvas,
  ...options
} = {}) {
  // The canvas is ours, not three's, so a failed first attempt can still be released.
  const firstCanvas = makeCanvas();
  try {
    return new THREE.WebGLRenderer({
      ...cadWebGlRendererAttributes(options),
      ...(firstCanvas ? { canvas: firstCanvas } : {})
    });
  } catch (error) {
    releaseFailedAttempt(firstCanvas);
    if (!allowFallback || !isRecoverableError(error)) {
      throw error;
    }
    const fallbackCanvas = makeCanvas();
    return new THREE.WebGLRenderer({
      ...fallbackCadWebGlRendererAttributes(options),
      ...(fallbackCanvas ? { canvas: fallbackCanvas } : {})
    });
  }
}
