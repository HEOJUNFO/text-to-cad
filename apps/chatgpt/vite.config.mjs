import { defineConfig } from 'vite';
import { gzipSync } from 'node:zlib';
import react from '@vitejs/plugin-react';
import { drawingAssetFiles, localizeDrawingFontFallback } from '@text-to-cad/ui/drawing-assets';

const drawingFiles = drawingAssetFiles({ exclude: [/\/fonts\/Xiaolai\//] });
function inlineDrawingFonts() {
  const fonts = new Map(drawingFiles.filter(file => /\.(woff2|ttf)$/.test(file.fileName)).map(file => [
    './' + file.fileName.replace(/^excalidraw\//, ''),
    `data:font/${file.fileName.endsWith('.ttf') ? 'ttf' : 'woff2'};base64,${file.source.toString('base64')}`,
  ]));
  return {
    name: 'cad-mcp-inline-drawing-fonts', enforce: 'pre',
    transform(code, id) {
      if (!id.includes('@excalidraw/excalidraw/dist/')) return;
      const localized = localizeDrawingFontFallback(code);
      if (localized === null) return;
      return { code: localized.replace(/"(\.\/fonts\/[^"]+\.(?:woff2|ttf))"/g, (_, path) => JSON.stringify(fonts.get(path) || 'data:font/woff2;base64,')), map: null };
    },
  };
}

// MCP resources have no HTTP asset directory. Keep shared workers unchanged and
// select Vite's inline worker transport at this host's build boundary.
function inlineWorkers() {
  return {
    name: 'cad-mcp-inline-workers', enforce: 'pre',
    transform(code, id) {
      if (!/\.[cm]?jsx?$/.test(id) || !code.includes('new Worker')) return;
      const imports = [];
      const result = code.replace(/new Worker\(\s*new URL\(\s*(["'])([^"']+)\1\s*,\s*import\.meta\.url\s*\)\s*,\s*\{\s*type:\s*(["'])module\3\s*\}\s*\)/g, (_, quote, file) => {
        const name = `__cadInlineWorker${imports.length}`;
        imports.push(`import ${name} from ${JSON.stringify(`${file}?worker&inline`)};`);
        return `new ${name}()`;
      });
      return imports.length ? { code: `${imports.join('\n')}\n${result}`, map: null } : undefined;
    },
  };
}
function inlineDocument() {
  return {
    name: 'cad-mcp-inline-document', enforce: 'post',
    // Vite resolves import/preload placeholders in its own generateBundle hooks.
    // Plugin enforce alone only orders transforms; this hook must run last too.
    generateBundle: { order: 'post', handler(_, bundle) {
      const html = bundle['index.html'];
      if (!html || html.type !== 'asset') throw new Error('MCP app build requires index.html.');
      let document = String(html.source);
      // Workers referenced from another worker are emitted separately by Vite.
      // Turn their URLs into owned blob URLs as well; no localhost fetch escapes.
      for (const [workerName, worker] of Object.entries(bundle)) {
        if (!workerName.endsWith('.js') || worker.type !== 'asset') continue;
        const expression = `URL.createObjectURL(new Blob([${JSON.stringify(String(worker.source))}],{type:'text/javascript'}))`;
        for (const item of Object.values(bundle)) if (item.type === 'chunk') {
          item.code = item.code.replaceAll(JSON.stringify('/' + workerName), expression).replaceAll(JSON.stringify(workerName), expression);
        }
        delete bundle[workerName];
      }
      for (const [name, item] of Object.entries(bundle)) {
        if (item.type === 'chunk' && item.isEntry) {
          // The MCP SDK's stdio reader caps one message at 10 MiB. Compress the
          // shared renderer before base64 framing, then inflate locally without fetch.
          if (/__VITE_[A-Z_]+__/.test(item.code)) throw new Error('MCP app received an unfinished Vite bundle.');
          const compressed = gzipSync(item.code, { level: 9 }).toString('base64');
          const bootstrap = `const bytes=Uint8Array.from(atob(${JSON.stringify(compressed)}),c=>c.charCodeAt(0));
const stream=new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
const url=URL.createObjectURL(await new Response(stream).blob().then(blob=>new Blob([blob],{type:'text/javascript'})));
try{await import(url)}finally{URL.revokeObjectURL(url)}`;
          document = document.replace(/<script\b[^>]*\bsrc="[^"]+"[^>]*><\/script>/, () => `<script type="module">${bootstrap}</script>`);
          delete bundle[name];
        } else if (item.type === 'asset' && name.endsWith('.css')) {
          document = document.replace(/<link\b[^>]*\bhref="[^"]+\.css"[^>]*>/, () => `<style>${String(item.source).replace(/<\/style/gi, '<\\/style')}</style>`);
          delete bundle[name];
        }
      }
      // Fail at build time instead of shipping an iframe that looks up assets on its host.
      const external = Object.keys(bundle).filter(name => name !== 'index.html');
      if (external.length) throw new Error(`MCP app assets must be inlined: ${external.join(', ')}`);
      const notices = drawingFiles.filter(file => file.fileName.includes('/licenses/')).map(file => `${file.fileName}\n${file.source}`).join('\n\n');
      html.source = document + `\n<!-- Bundled font licenses\n${notices.replaceAll('-->', '-- >')}\n-->`;
      const framedBytes = Buffer.byteLength(JSON.stringify({ contents: [{ text: html.source }] }));
      if (framedBytes > 8 * 1024 * 1024) throw new Error(`MCP HTML exceeds the 8 MiB resource budget (${framedBytes} bytes), leaving insufficient room in the 10 MiB stdio frame.`);
    } },
  };
}
export default defineConfig({
  plugins: [inlineWorkers(), inlineDrawingFonts(), react(), inlineDocument()],
  resolve: { dedupe: ['react', 'react-dom', 'three', 'lucide-react'] },
  build: { assetsInlineLimit: Infinity, cssCodeSplit: false, modulePreload: false, rolldownOptions: { output: { codeSplitting: false } } },
  worker: { format: 'es', rolldownOptions: { output: { codeSplitting: false } } },
});
