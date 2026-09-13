/* Cloudflare Worker entry point. Thin on purpose: all behaviour lives in app.js / core.js,
   which the test suite drives directly. This file only wires the Worker runtime to them and
   owns the one thing Node cannot load the same way -- the resvg WASM module. */
import { initWasm, Resvg } from '@resvg/resvg-wasm';
import resvgWasm from '@resvg/resvg-wasm/index_bg.wasm';
import { handleRequest, runAlerts } from './app.js';

// resvg has no system fonts. The font is fetched once per isolate from Google Fonts' own
// repository (the request carries no Iron Hub data), and a chart still renders -- without
// labels -- if that fetch ever fails, because the numbers are repeated in the embed text.
const FONT_URL = 'https://raw.githubusercontent.com/google/fonts/main/ofl/ibmplexmono/IBMPlexMono-Regular.ttf';
let wasmReady = null, fontBytes = null;

async function renderPng(svg) {
  if (!wasmReady) wasmReady = initWasm(resvgWasm);
  await wasmReady;
  if (!fontBytes) {
    try {
      const r = await fetch(FONT_URL);
      if (r.ok) fontBytes = new Uint8Array(await r.arrayBuffer());
    } catch (e) { /* render without labels */ }
  }
  const resvg = new Resvg(svg, {
    fitTo: { mode: 'width', value: 900 },
    font: fontBytes ? { fontBuffers: [fontBytes], defaultFontFamily: 'IBM Plex Mono', loadSystemFonts: false } : { loadSystemFonts: false },
  });
  return resvg.render().asPng();
}

const deps = { fetch: (u, i) => fetch(u, i), now: () => Date.now(), renderPng };

export default {
  fetch(request, env, ctx) {
    return handleRequest(request, env, ctx, deps);
  },
  scheduled(event, env, ctx) {
    ctx.waitUntil(runAlerts(env, deps).catch((e) => console.error('alerts failed:', e && e.message)));
  },
};
