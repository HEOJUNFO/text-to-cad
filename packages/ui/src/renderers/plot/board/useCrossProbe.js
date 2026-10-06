import { useEffect, useMemo, useRef } from "react";
import { mirrorPageX, visiblePageRect } from "@text-to-cad/core/lib/plot2d/index.js";
import { BOARD_TOOL } from "./useBoardInspector.js";

/**
 * Cross-probing: a board and its schematic, open in two views, select together. What a person (or
 * the agent) selects in one is told to the others through the host's `crossProbe` port, and what
 * the other tells this one is selected here — a part, a pin, a net, in the board references both
 * speak — and brought into view when it is off screen. A selection only: nothing is edited, and
 * nothing is kept. A view in Measure is left alone (its measurement in hand is not taken away);
 * what names nothing here (a board's point, a schematic's power symbol) is left out, and a message
 * naming nothing here leaves the selection as it was. Two views are one project when their files
 * are one path but for `.kicad_pcb` and `.kicad_sch`.
 */

/** The KiCad project a board or a schematic belongs to: its absolute path without the extension, or null. */
export function kicadProject(path) {
  const match = /^(.*)\.kicad_(pcb|sch)$/u.exec(String(path || ""));
  return match ? match[1] : null;
}

const union = (boxes) => boxes.reduce((box, next) => [Math.min(box[0], next[0]), Math.min(box[1], next[1]), Math.max(box[2], next[2]), Math.max(box[3], next[3])]);

/**
 * @param {object} options
 * @param {import("../../../host/types.js").CrossProbePort|undefined} options.port  The host's.
 * @param {string} options.path  The file's absolute path.
 * @param {ReturnType<typeof import("./useBoardInspector.js").useBoardInspector>} options.inspector
 * @param {{ transformRef: { current: object|null }, setView: (transform: object) => void }} options.view
 * @param {{ current: HTMLCanvasElement|null }} options.canvasRef
 * @param {object|null} options.layout  The plot's layout (a bottom view mirrors about its sheet).
 * @param {boolean} options.mirrored  The board seen from the bottom.
 */
export function useCrossProbe({ port, path, inspector, view, canvasRef, layout, mirrored }) {
  const project = port && inspector.available ? kicadProject(path) : null;
  const id = useMemo(() => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`, []);
  // The selection this view last told (null until its index is in: what it opens with is not news),
  // and the one a probe set, which is not told back.
  const told = useRef(null);
  const heard = useRef(null);
  const key = JSON.stringify(inspector.selection);
  useEffect(() => {
    if (!project) { told.current = null; return; }
    if (told.current === null || told.current === key) { told.current = key; return; }
    told.current = key;
    const fromProbe = heard.current === key;
    heard.current = null;
    if (!fromProbe) port.publish({ project, from: id, selectors: [...inspector.selection] });
  }, [port, project, id, key, inspector.selection]);

  const current = useRef(null);
  current.current = { inspector, view, canvasRef, layout, mirrored };
  useEffect(() => {
    if (!project) return undefined;
    /** Centre what `selectors` name when any of it is off screen; the zoom stays. */
    const reveal = (selectors) => {
      const { inspector: shown, view: pane, canvasRef: canvas, layout: plot, mirrored: below } = current.current;
      const transform = pane.transformRef.current;
      const width = canvas.current?.clientWidth || 0;
      const height = canvas.current?.clientHeight || 0;
      const boxes = selectors.map((selector) => shown.index.extent(shown.index.resolve(selector))).filter(Boolean);
      if (!transform || !(width > 0 && height > 0) || !boxes.length) return;
      let [x0, y0, x1, y1] = union(boxes);
      if (below && plot) [x0, x1] = [mirrorPageX(plot, 0, x1), mirrorPageX(plot, 0, x0)];
      const [vx0, vy0, vx1, vy1] = visiblePageRect(transform, width, height);
      if (x0 >= vx0 && y0 >= vy0 && x1 <= vx1 && y1 <= vy1) return;
      pane.setView({ ...transform, offsetX: width / 2 - ((x0 + x1) / 2) * transform.scale, offsetY: height / 2 - ((y0 + y1) / 2) * transform.scale });
    };
    return port.subscribe((message) => {
      const shown = current.current.inspector;
      if (message?.project !== project || message.from === id || !shown.available || shown.tool === BOARD_TOOL.MEASURE) return;
      const named = Array.isArray(message.selectors) ? message.selectors : [];
      const selectors = [...new Set(named.map((selector) => shown.index.resolve(selector)?.selector).filter(Boolean))];
      if (named.length && !selectors.length) return;
      heard.current = JSON.stringify(selectors);
      if (!selectors.length) { shown.clear(); return; }
      shown.select(selectors);
      reveal(selectors);
    });
  }, [port, project, id]);
}
