// Overlay Presenter — PDF.js-based Beamer presenter with overlay cross-fades,
// working PDF links and crisp pinch-zoom. Runs in Firefox/Safari/Chrome, desktop and iPad.
// PDF.js: use the bundled copy when self-hosted, else the pinned CDN build.
const PDFJS_VERSION = '6.5.438';
const CDN = globalThis.__PDFJS_BASE || `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}/build/`;
const ASSET = (p) => new URL(p, import.meta.url).href;
let localPdfjs = true;
const pdfjsReady = (async () => {
  let lib;
  try { lib = await import('./pdfjs/pdf.min.mjs'); }
  catch { localPdfjs = false; lib = await import(CDN + 'pdf.min.mjs'); }
  lib.GlobalWorkerOptions.workerSrc = localPdfjs ? ASSET('./pdfjs/pdf.worker.min.mjs') : CDN + 'pdf.worker.min.mjs';
  return lib;
})();
pdfjsReady.catch(() => {});

const $ = (id) => document.getElementById(id);
const stage = $('stage'), box = $('box'), curtain = $('curtain'), numEl = $('num');
const startEl = $('start'), menuEl = $('menu'), toastEl = $('toast');

const store = {
  get(k, d) { try { const v = localStorage.getItem('op:' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('op:' + k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
};
const cfg = Object.assign({ fadeIn: 280, fadeFrame: 0, showNum: false }, store.get('cfg', {}));
const MAX_ZOOM = 12;

// ---------- document state ----------
let pdf = null, docKey = '', labels = null, numPages = 0, pageSize = null;
const pages = [];                 // resolved PDFPageProxy by index
const pagePromises = new Map();
const linkCache = new Map();      // idx -> { list, promise }
const linkHistory = [];

// ---------- layout + view ----------
// Slide box is W x H CSS px. A point p in "fit" coordinates appears at s*p + t in the box.
let W = 0, H = 0, fitScale = 1, dpr = 1, gen = 0;
const view = { s: 1, tx: 0, ty: 0 };

let layer = null;        // the visible (top) layer
let fading = null;       // { old, neu, timer }
let target = 0;          // index we are heading to (updated synchronously)
let navToken = 0;
const backdrops = new Map();  // idx -> { gen, promise, canvas }

function getPage(i) {
  let p = pagePromises.get(i);
  if (!p) { p = pdf.getPage(i + 1).then((pg) => (pages[i] = pg)); pagePromises.set(i, p); }
  return p;
}

function newCanvas(cls) {
  const c = document.createElement('canvas');
  c.className = cls;
  c.width = Math.max(1, Math.round(W * dpr));
  c.height = Math.max(1, Math.round(H * dpr));
  c.style.width = W + 'px';
  c.style.height = H + 'px';
  return c;
}
function freeCanvas(c) { if (c) { c.width = 0; c.height = 0; c.remove(); } } // iOS frees canvas memory promptly this way

function layout() {
  const sw = window.innerWidth, sh = window.innerHeight;
  fitScale = Math.min(sw / pageSize.w, sh / pageSize.h);
  W = pageSize.w * fitScale; H = pageSize.h * fitScale;
  dpr = Math.min(window.devicePixelRatio || 1, 3);
  Object.assign(box.style, { width: W + 'px', height: H + 'px', left: (sw - W) / 2 + 'px', top: (sh - H) / 2 + 'px' });
  gen++;
  for (const e of backdrops.values()) if (!e.canvas.isConnected) freeCanvas(e.canvas);
  backdrops.clear();
  sizeInk();
}

// Full-page render at fit size; cached and prefetched so stepping is instant.
function backdrop(i) {
  const e = backdrops.get(i);
  if (e && e.gen === gen) return e.promise;
  const canvas = newCanvas('backdrop');
  const promise = getPage(i)
    .then((pg) => pg.render({ canvas, viewport: pg.getViewport({ scale: fitScale * dpr }) }).promise)
    .then(() => canvas);
  promise.catch(() => {});
  backdrops.set(i, { gen, promise, canvas });
  return promise;
}
function prefetch(i) {
  for (const j of [i + 1, i - 1, i + 2]) if (j >= 0 && j < numPages) { backdrop(j); loadLinks(j); }
  for (const [j, e] of backdrops) {
    if ((j < i - 2 || j > i + 3) && !e.canvas.isConnected) { freeCanvas(e.canvas); backdrops.delete(j); }
  }
}

// ---------- layers ----------
function makeLayer(i, bd) {
  const el = document.createElement('div');
  el.className = 'layer';
  el.appendChild(bd);
  return { idx: i, el, bd, detail: null, ds: null, task: null };
}
function dropLayer(l) {
  if (!l) return;
  if (l.task) { l.task.cancel(); l.task = null; }
  freeCanvas(l.detail); l.detail = null;
  if (backdrops.get(l.idx)?.canvas !== l.bd) freeCanvas(l.bd);
  l.el.remove();
}
function place(l) {
  l.bd.style.transform = `translate(${view.tx}px,${view.ty}px) scale(${view.s})`;
  if (!l.detail) return;
  if (view.s <= 1.0001) { l.detail.style.visibility = 'hidden'; return; }
  const k = view.s / l.ds.s;
  l.detail.style.visibility = '';
  l.detail.style.transform = `translate(${view.tx - k * l.ds.tx}px,${view.ty - k * l.ds.ty}px) scale(${k})`;
}
let placeQueued = false;
function placeAll() {
  if (placeQueued) return;
  placeQueued = true;
  requestAnimationFrame(() => { placeQueued = false; if (layer) place(layer); if (fading) place(fading.old); redrawInk(); });
}
function commitFade() {
  if (!fading) return;
  clearTimeout(fading.timer);
  fading.neu.el.style.transition = 'none';
  fading.neu.el.style.opacity = '1';
  dropLayer(fading.old);
  fading = null;
}

// Sharp render of just the visible region at the current zoom. The canvas is never
// bigger than the screen, so it stays inside iOS canvas-memory limits at any zoom.
let detailTimer = 0;
function scheduleDetail(delay = 120) {
  clearTimeout(detailTimer);
  detailTimer = setTimeout(() => { if (layer) renderDetail(layer); }, delay);
}
async function renderDetail(l) {
  if (l.task) { l.task.cancel(); l.task = null; }
  if (view.s <= 1.0001) { freeCanvas(l.detail); l.detail = null; return; }
  const v = { s: view.s, tx: view.tx, ty: view.ty };
  const pg = await getPage(l.idx);
  const c = newCanvas('detail');
  const task = pg.render({
    canvas: c,
    viewport: pg.getViewport({ scale: fitScale * v.s * dpr }),
    transform: [1, 0, 0, 1, v.tx * dpr, v.ty * dpr],
  });
  l.task = task;
  try { await task.promise; } catch { freeCanvas(c); return; }
  if (l.task !== task) { freeCanvas(c); return; }
  l.task = null;
  freeCanvas(l.detail);
  l.detail = c; l.ds = v;
  l.el.appendChild(c);
  place(l);
}

// ---------- navigation ----------
const sameFrame = (a, b) => (labels ? labels[a] === labels[b] : true);
function resetView() { view.s = 1; view.tx = 0; view.ty = 0; }

async function goTo(i, opts = {}) {
  if (!pdf) return;
  i = Math.max(0, Math.min(numPages - 1, i));
  if (layer && i === layer.idx && !opts.force) { target = i; return; }
  target = i;
  const tok = ++navToken;
  let bd;
  try { bd = await backdrop(i); } catch (e) { if (tok === navToken) toast('Could not render page: ' + e.message); return; }
  if (tok !== navToken) return;
  commitFade();
  const old = layer;
  const prev = opts.cut ? null : old;
  const same = prev && sameFrame(prev.idx, i);
  if (!same) resetView();
  const nl = makeLayer(i, bd);
  place(nl);
  if (view.s > 1.0001) {            // keep zoom sharp across overlay steps
    await renderDetail(nl);
    if (tok !== navToken) { nl.el.remove(); return; }
    commitFade();
  }
  const dur = prev ? (same ? cfg.fadeIn : cfg.fadeFrame) : 0;
  box.appendChild(nl.el);
  if (old && dur > 0) {
    nl.el.style.opacity = '0';
    nl.el.getBoundingClientRect();  // flush so the transition starts from 0
    nl.el.style.transition = `opacity ${dur}ms ease-in-out`;
    nl.el.style.opacity = '1';
    fading = { old, neu: nl, timer: setTimeout(commitFade, dur + 40) };
  } else if (old) dropLayer(old);
  layer = nl;
  redrawInk();
  if (old) placeAll();
  loadLinks(i);
  prefetch(i);
  store.set('pos:' + docKey, i);
  updateNum();
}
const next = () => goTo(target + 1);
const prev = () => goTo(target - 1);
function frameStart(i) { while (labels && i > 0 && labels[i - 1] === labels[i]) i--; return i; }
function frameEnd(i) { while (labels && i < numPages - 1 && labels[i + 1] === labels[i]) i++; return i; }
const nextFrame = () => goTo(frameEnd(target) + 1);
const prevFrame = () => goTo(frameStart(target) - 1);
function back() { if (linkHistory.length) goTo(linkHistory.pop()); }
function goLabel(str) {
  str = String(str).trim();
  if (!str) return;
  let i = labels ? labels.indexOf(str) : -1;
  if (i < 0 && /^\d+$/.test(str)) i = +str - 1;
  if (i >= 0 && i < numPages) { linkHistory.push(target); goTo(i); } else toast('No frame ' + str);
}
function updateNum() {
  numEl.style.display = cfg.showNum && pdf ? 'block' : 'none';
  if (!cfg.showNum || !pdf) return;
  const a = frameStart(target), b = frameEnd(target);
  const lab = labels ? labels[target] : String(target + 1);
  numEl.textContent = b > a ? `${lab} · ${target - a + 1}/${b - a + 1}` : lab;
}

// ---------- zoom + pan ----------
function clampView() {
  view.s = Math.min(MAX_ZOOM, Math.max(1, view.s));
  view.tx = Math.min(0, Math.max(W - view.s * W, view.tx));
  view.ty = Math.min(0, Math.max(H - view.s * H, view.ty));
}
function boxPoint(x, y) { const r = box.getBoundingClientRect(); return { x: x - r.left, y: y - r.top }; }
function zoomAt(factor, cx, cy) {
  const px = (cx - view.tx) / view.s, py = (cy - view.ty) / view.s;
  view.s = Math.min(MAX_ZOOM, Math.max(1, view.s * factor));
  view.tx = cx - view.s * px; view.ty = cy - view.s * py;
  clampView(); placeAll(); scheduleDetail();
}
function resetZoom() { resetView(); placeAll(); scheduleDetail(0); }

// ---------- links ----------
function loadLinks(i) {
  if (linkCache.has(i)) return linkCache.get(i).promise;
  const entry = { list: null };
  entry.promise = getPage(i)
    .then((pg) => pg.getAnnotations({ intent: 'display' }))
    .then((anns) => (entry.list = anns
      .filter((a) => a.subtype === 'Link' && a.rect)
      .map((a) => ({ rect: a.rect, url: a.url || a.unsafeUrl || null, dest: a.dest ?? null, action: a.action || null }))))
    .catch(() => (entry.list = []));
  linkCache.set(i, entry);
  return entry.promise;
}
function hitLink(cx, cy, slopPx = 0) {
  if (!layer) return null;
  const list = linkCache.get(layer.idx)?.list;
  const pg = pages[layer.idx];
  if (!list || !list.length || !pg) return null;
  const b = boxPoint(cx, cy);
  const px = (b.x - view.tx) / view.s, py = (b.y - view.ty) / view.s;
  if (px < 0 || py < 0 || px > W || py > H) return null;
  const [x, y] = pg.getViewport({ scale: fitScale }).convertToPdfPoint(px, py);
  const slop = slopPx / (fitScale * view.s);
  let best = null, bestArea = Infinity;
  for (const k of list) {
    const [x1, y1, x2, y2] = k.rect;
    if (x >= Math.min(x1, x2) - slop && x <= Math.max(x1, x2) + slop && y >= Math.min(y1, y2) - slop && y <= Math.max(y1, y2) + slop) {
      const area = Math.abs((x2 - x1) * (y2 - y1));
      if (area < bestArea) { best = k; bestArea = area; }
    }
  }
  return best;
}
function openExternal(url) {
  const a = document.createElement('a');
  a.href = url; a.target = '_blank'; a.rel = 'noopener';
  document.body.appendChild(a); a.click(); a.remove();
}
async function follow(k) {
  if (k.url) { openExternal(k.url); return; }
  if (k.action) {
    const acts = { NextPage: next, PrevPage: prev, FirstPage: () => goTo(0), LastPage: () => goTo(numPages - 1), GoBack: back };
    acts[k.action]?.();
    return;
  }
  let d = k.dest;
  try {
    if (typeof d === 'string') d = await pdf.getDestination(d);
    if (!Array.isArray(d)) return;
    const ref = d[0];
    const idx = typeof ref === 'number' ? ref : await pdf.getPageIndex(ref);
    linkHistory.push(target);
    goTo(idx);
  } catch (e) { toast('Link target not found'); }
}

// ---------- pointer input (touch, pen, mouse) ----------
const ptrs = new Map();
let g = null;
let pressTimer = 0, lastLongPress = 0;
function cancelPress() { clearTimeout(pressTimer); }

stage.addEventListener('pointerdown', (e) => {
  if (!pdf || (e.pointerType === 'mouse' && e.button !== 0)) return;
  recoverStale(e);
  if (ink.active) return;                                     // ignore palm/fingers while writing
  if (e.pointerType === 'pen' || (ink.drawMode && e.pointerType === 'mouse')) { startInk(e); return; }
  if (e.pointerType === 'touch' && performance.now() - ink.lastPen < 350) return;  // palm just after the pencil lifts
  try { stage.setPointerCapture(e.pointerId); } catch { /* ignore */ }
  ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
  commitFade();
  if (ptrs.size === 1) {
    g = { kind: 'one', id: e.pointerId, x0: e.clientX, y0: e.clientY, t0: performance.now(), v0: { ...view }, moved: false, panning: false, type: e.pointerType };
    cancelPress();
    pressTimer = setTimeout(() => { if (g && g.kind === 'one' && !g.moved) { g.long = true; lastLongPress = Date.now(); openMenu(); } }, 650);
  } else if (ptrs.size === 2) startPinch();
  else { g = { kind: 'multi' }; cancelPress(); }
});

function startPinch() {
  cancelPress();
  const [a, b] = [...ptrs.values()];
  const m = boxPoint((a.x + b.x) / 2, (a.y + b.y) / 2);
  g = { kind: 'pinch', d0: Math.hypot(a.x - b.x, a.y - b.y) || 1, s0: view.s, px: (m.x - view.tx) / view.s, py: (m.y - view.ty) / view.s };
}

stage.addEventListener('pointermove', (e) => {
  if (ink.active && e.pointerId === ink.active.id) { moveInk(e); return; }
  const p = ptrs.get(e.pointerId);
  if (!p) { hover(e); return; }
  p.x = e.clientX; p.y = e.clientY;
  if (!g) return;
  if (g.kind === 'pinch' && ptrs.size >= 2) {
    const [a, b] = [...ptrs.values()];
    const m = boxPoint((a.x + b.x) / 2, (a.y + b.y) / 2);
    view.s = Math.min(MAX_ZOOM, Math.max(1, g.s0 * Math.hypot(a.x - b.x, a.y - b.y) / g.d0));
    view.tx = m.x - view.s * g.px; view.ty = m.y - view.s * g.py;
    clampView(); placeAll();
  } else if (g.kind === 'one' && e.pointerId === g.id) {
    const dx = e.clientX - g.x0, dy = e.clientY - g.y0;
    if (!g.moved && Math.hypot(dx, dy) > 8) { g.moved = true; cancelPress(); if (view.s > 1.0001) g.panning = true; }
    if (g.panning) { view.tx = g.v0.tx + dx; view.ty = g.v0.ty + dy; clampView(); placeAll(); }
  }
});

function endPointer(e) {
  if (ink.active && e.pointerId === ink.active.id) { endInk(); return; }
  if (!ptrs.has(e.pointerId)) return;
  ptrs.delete(e.pointerId);
  cancelPress();
  if (!g) return;
  if (g.kind === 'pinch' || g.kind === 'multi') {
    if (ptrs.size === 1) {        // one finger left: continue as a pan, never as a tap
      const [id, q] = [...ptrs][0];
      g = { kind: 'one', id, x0: q.x, y0: q.y, t0: performance.now(), v0: { ...view }, moved: true, panning: view.s > 1.0001, type: 'touch' };
    } else if (ptrs.size === 0) g = null;
    scheduleDetail();
    return;
  }
  if (g.kind === 'one' && e.pointerId === g.id) {
    const dx = e.clientX - g.x0, dy = e.clientY - g.y0, dt = performance.now() - g.t0;
    if (g.long) { /* menu already opened */ }
    else if (!g.moved && e.type === 'pointerup' && dt < 600) tap(e.clientX, e.clientY, g.type);
    else if (g.moved && !g.panning && g.type !== 'mouse' && Math.abs(dx) > 40 && Math.abs(dx) > 1.5 * Math.abs(dy) && dt < 800) (dx < 0 ? next() : prev());
    g = null;
    scheduleDetail();
  }
}
stage.addEventListener('pointerup', endPointer);
stage.addEventListener('pointercancel', endPointer);

// iPadOS can swallow a lift (pointerup) — e.g. when it cancels touches around the Pencil or the
// lift lands outside the stage. A lost lift would leave a finger or pen "down" forever, which
// blocks taps and long-press. These guards notice and clear such stale state.
function recoverStale(e) {
  // A primary touch means no other finger is on the screen, so any tracked finger is stale.
  if (e.pointerType === 'touch' && e.isPrimary && ptrs.size) { ptrs.clear(); g = null; cancelPress(); }
  if (ink.active) {
    const penIdle = performance.now() - ink.lastPen > 1500;
    if (e.pointerType !== 'touch' || (e.isPrimary && penIdle)) endInk();
  }
}
function lostLift(e) {
  if (stage.contains(e.target)) return;            // the stage's own handlers deal with it
  if (ink.active && e.pointerId === ink.active.id) endInk();
  else if (ptrs.has(e.pointerId)) { ptrs.delete(e.pointerId); cancelPress(); if (!ptrs.size) g = null; }
}
window.addEventListener('pointerup', lostLift, true);
window.addEventListener('pointercancel', lostLift, true);
stage.addEventListener('lostpointercapture', (e) => {
  setTimeout(() => {                                // let a normal pointerup run first
    if (ink.active && e.pointerId === ink.active.id) endInk();
    else if (ptrs.has(e.pointerId)) { ptrs.delete(e.pointerId); if (!ptrs.size) g = null; }
  }, 0);
});
function resetInput() { ptrs.clear(); g = null; cancelPress(); if (ink.active) endInk(); }
window.addEventListener('blur', resetInput);
document.addEventListener('visibilitychange', () => { if (document.hidden) resetInput(); });

function tap(x, y, type) {
  const k = hitLink(x, y, type === 'mouse' ? 0 : 8);
  if (k) { follow(k); return; }
  if (x < window.innerWidth * 0.25) prev(); else next();
}
function hover(e) {
  if (e.pointerType !== 'mouse' || !pdf) return;
  stage.style.cursor = ink.drawMode ? 'crosshair' : hitLink(e.clientX, e.clientY) ? 'pointer' : (view.s > 1.0001 ? 'grab' : '');
}
stage.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  if (Date.now() - lastLongPress > 1000 && pdf) prev();   // right-click = previous
});

// Trackpad pinch (Firefox/Chrome send ctrl+wheel) and two-finger pan when zoomed.
stage.addEventListener('wheel', (e) => {
  if (!pdf) return;
  e.preventDefault();
  commitFade();
  const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? window.innerHeight : 1;
  const dx = e.deltaX * unit, dy = e.deltaY * unit;
  const b = boxPoint(e.clientX, e.clientY);
  if (e.ctrlKey || e.metaKey) zoomAt(Math.exp(-dy * 0.01), b.x, b.y);
  else if (view.s > 1.0001) { view.tx -= dx; view.ty -= dy; clampView(); placeAll(); scheduleDetail(); }
}, { passive: false });

// Safari (macOS trackpad) gesture events; on iOS touches are handled by pointer events above.
let gs0 = 1;
document.addEventListener('gesturestart', (e) => { e.preventDefault(); gs0 = view.s; }, { passive: false });
document.addEventListener('gesturechange', (e) => {
  e.preventDefault();
  if (ptrs.size || !pdf) return;
  const b = boxPoint(e.clientX, e.clientY);
  zoomAt((gs0 * e.scale) / view.s, b.x, b.y);
}, { passive: false });
document.addEventListener('gestureend', (e) => e.preventDefault(), { passive: false });
document.addEventListener('touchmove', (e) => { if (!e.target.closest('.card')) e.preventDefault(); }, { passive: false });

// ---------- keyboard ----------
let numBuf = '';
document.addEventListener('keydown', (e) => {
  if (e.target.closest && e.target.closest('input, textarea, select')) return;
  const k = e.key;
  if (!menuEl.hidden) { if (k === 'Escape' || k === 'm') { closeMenu(); e.preventDefault(); } return; }
  if (!pdf) { if (k === 'o') pickFile(); return; }
  if ((e.metaKey || e.ctrlKey) && k === 'z') { undoInk(); e.preventDefault(); return; }
  if (e.metaKey || e.ctrlKey) return;            // leave browser shortcuts alone
  let handled = true;
  if (/^[0-9]$/.test(k)) { numBuf += k; toast('Go to frame ' + numBuf + ' — Enter'); }
  else if (k === 'Enter' && numBuf) { goLabel(numBuf); numBuf = ''; }
  else if (k === 'ArrowLeft' && e.altKey) back();
  else if (['ArrowRight', 'ArrowDown', 'PageDown', ' ', 'Enter', 'n'].includes(k)) (e.shiftKey ? nextFrame() : next());
  else if (['ArrowLeft', 'ArrowUp', 'PageUp', 'Backspace', 'p'].includes(k)) (e.shiftKey ? prevFrame() : prev());
  else if (k === ']') nextFrame();
  else if (k === '[') prevFrame();
  else if (k === 'Home') goTo(0);
  else if (k === 'End') goTo(numPages - 1);
  else if (k === 'f') toggleFullscreen();
  else if (k === 'Escape') { if (numBuf) numBuf = ''; else resetZoom(); }
  else if (k === '+' || k === '=') zoomAt(1.25, W / 2, H / 2);
  else if (k === '-' || k === '_') zoomAt(0.8, W / 2, H / 2);
  else if (k === 'b' || k === '.') toggleCurtain('black');
  else if (k === 'w' || k === ',') toggleCurtain('white');
  else if (k === 'm' || k === 'h' || k === '?') openMenu();
  else if (k === 'o') pickFile();
  else if (k === 'd') setDrawMode(!ink.drawMode);
  else if (k === 'e') { setTool('eraser'); setDrawMode(true); }
  else if (k === 'u') undoInk();
  else if (k === 'i') { cfg.showNum = !cfg.showNum; store.set('cfg', cfg); updateNum(); }
  else handled = false;
  if (!/^[0-9]$/.test(k) && k !== 'Shift') numBuf = '';
  if (handled) e.preventDefault();
});

function toggleCurtain(c) { curtain.className = curtain.className === c ? '' : c; }
curtain.addEventListener('pointerdown', () => { curtain.className = ''; });
function toggleFullscreen() {
  const d = document, el = d.documentElement;
  try {
    if (d.fullscreenElement || d.webkitFullscreenElement) (d.exitFullscreen || d.webkitExitFullscreen).call(d);
    else {
      const r = (el.requestFullscreen || el.webkitRequestFullscreen)?.call(el);
      if (r && r.catch) r.catch(() => toast('Fullscreen is not available here'));
      if (!el.requestFullscreen && !el.webkitRequestFullscreen) toast('Fullscreen is not available here');
    }
  } catch { toast('Fullscreen is not available here'); }
}

// ---------- menu ----------
function openMenu() {
  for (const id of ['fadeIn', 'fadeFrame']) { $(id).value = cfg[id]; $('o-' + id).textContent = cfg[id] ? cfg[id] + ' ms' : 'off'; }
  $('showNum').checked = cfg.showNum;
  menuEl.hidden = false;
}
function closeMenu() { menuEl.hidden = true; }
menuEl.addEventListener('click', (e) => {
  if (e.target === menuEl) { closeMenu(); return; }
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (!act) return;
  if (act === 'close') closeMenu();
  else if (act === 'open') { closeMenu(); pickFile(); }
  else if (act === 'fs') { toggleFullscreen(); closeMenu(); }
  else if (act === 'fit') { resetZoom(); closeMenu(); }
  else if (act === 'back') { back(); closeMenu(); }
  else if (act === 'annotate') { closeMenu(); setDrawMode(true); }
  else if (act === 'export') { closeMenu(); exportAnnotated(); }
  else if (act === 'clearall') { clearInk(true); closeMenu(); }
});
for (const id of ['fadeIn', 'fadeFrame']) {
  $(id).addEventListener('input', () => {
    cfg[id] = +$(id).value; store.set('cfg', cfg);
    $('o-' + id).textContent = cfg[id] ? cfg[id] + ' ms' : 'off';
  });
}
$('showNum').addEventListener('change', () => { cfg.showNum = $('showNum').checked; store.set('cfg', cfg); updateNum(); });
$('goform').addEventListener('submit', (e) => { e.preventDefault(); goLabel($('goto').value); $('goto').value = ''; closeMenu(); });

let toastTimer = 0;
function toast(msg, ms = 1600) {
  toastEl.textContent = msg; toastEl.classList.add('on');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => toastEl.classList.remove('on'), ms);
}

// ---------- ink (Apple Pencil / mouse annotations) ----------
// Strokes live in PDF user-space units, so they stay put at any zoom or screen size.
// A stroke drawn on overlay step k of a frame shows on steps k, k+1, … of that frame.
const TOOLS = {
  red: { color: '#e0242b', w: 2.6, a: 1 },
  blue: { color: '#1f5fe0', w: 2.6, a: 1 },
  black: { color: '#111111', w: 2.6, a: 1 },
  hl: { color: '#ffd400', w: 16, a: 0.38 },
};
// Widths above are CSS px on a slide shown 1200 px wide; strokes keep that width relative
// to the slide whatever the zoom or screen, so ink written zoomed-in matches the rest.
const strokeWidth = (t) => t.w * pageSize.w / 1200;
const ink = { strokes: [], undo: [], active: null, drawMode: false, lastPen: 0, tool: store.get('tool', 'red') };
const inkCanvas = $('ink'), inkCtx = inkCanvas.getContext('2d'), toolsEl = $('tools');
let origBytes = null, docName = 'slides.pdf';

function sizeInk() {
  inkCanvas.width = Math.max(1, Math.round(W * dpr)); inkCanvas.height = Math.max(1, Math.round(H * dpr));
  inkCanvas.style.width = W + 'px'; inkCanvas.style.height = H + 'px';
}
const shownOn = (s, i) => s.frame === frameStart(i) && s.page <= i;
function strokePath(ctx, p) {           // smoothed: quadratic curves through midpoints
  ctx.moveTo(p[0], p[1]);
  if (p.length <= 2) { ctx.lineTo(p[0] + 0.01, p[1]); return; }
  let k = 2;
  for (; k < p.length - 2; k += 2) ctx.quadraticCurveTo(p[k], p[k + 1], (p[k] + p[k + 2]) / 2, (p[k + 1] + p[k + 3]) / 2);
  ctx.lineTo(p[p.length - 2], p[p.length - 1]);
}
function drawStroke(ctx, s) {
  ctx.globalAlpha = s.a; ctx.strokeStyle = s.color; ctx.lineWidth = s.w;
  ctx.beginPath(); strokePath(ctx, s.pts); ctx.stroke();
}
let inkQueued = false;
function queueInk() { if (!inkQueued) { inkQueued = true; requestAnimationFrame(() => { inkQueued = false; redrawInk(); }); } }
function redrawInk() {
  inkCtx.setTransform(1, 0, 0, 1, 0, 0);
  inkCtx.clearRect(0, 0, inkCanvas.width, inkCanvas.height);
  if (!pdf || !layer || !pages[layer.idx]) return;
  const i = layer.idx;
  inkCtx.setTransform(dpr * view.s, 0, 0, dpr * view.s, dpr * view.tx, dpr * view.ty);
  inkCtx.transform(...pages[i].getViewport({ scale: fitScale }).transform);
  inkCtx.lineCap = 'round'; inkCtx.lineJoin = 'round';
  for (const s of ink.strokes) if (shownOn(s, i)) drawStroke(inkCtx, s);
  if (ink.active && ink.active.stroke) drawStroke(inkCtx, ink.active.stroke);
  inkCtx.globalAlpha = 1;
}
function toPdf(cx, cy) {
  const b = boxPoint(cx, cy);
  return pages[layer.idx].getViewport({ scale: fitScale }).convertToPdfPoint((b.x - view.tx) / view.s, (b.y - view.ty) / view.s);
}
const unitsPerPx = () => 1 / (fitScale * view.s);   // PDF units per CSS pixel on screen

function startInk(e) {
  if (!layer || !pages[layer.idx]) return;
  try { stage.setPointerCapture(e.pointerId); } catch { /* synthetic */ }
  commitFade();
  if (e.pointerType === 'pen') ink.lastPen = performance.now();
  showTools(true);
  const [x, y] = toPdf(e.clientX, e.clientY);
  if (ink.tool === 'eraser') { ink.active = { id: e.pointerId, removed: [] }; eraseAt(x, y); }
  else {
    const t = TOOLS[ink.tool] || TOOLS.red;
    ink.active = { id: e.pointerId, stroke: { page: layer.idx, frame: frameStart(layer.idx), color: t.color, w: strokeWidth(t), a: t.a, pts: [x, y] } };
  }
  queueInk();
}
function moveInk(e) {
  const evs = (e.getCoalescedEvents && e.getCoalescedEvents().length) ? e.getCoalescedEvents() : [e];
  const a = ink.active, minD = 0.6 * unitsPerPx();
  for (const ev of evs) {
    const [x, y] = toPdf(ev.clientX, ev.clientY);
    if (a.stroke) {
      const p = a.stroke.pts, n = p.length;
      if (Math.hypot(x - p[n - 2], y - p[n - 1]) >= minD) p.push(x, y);
    } else eraseAt(x, y);
  }
  if (e.pointerType === 'pen') ink.lastPen = performance.now();
  queueInk();
}
function endInk() {
  const a = ink.active; ink.active = null;
  if (a.stroke) { ink.strokes.push(a.stroke); ink.undo.push({ add: [a.stroke] }); }
  else if (a.removed.length) ink.undo.push({ removed: a.removed });
  if (ink.undo.length > 300) ink.undo.shift();
  ink.lastPen = performance.now();
  saveInk(); queueInk();
}
function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy;
  const t = L ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / L)) : 0;
  return Math.hypot(px - ax - t * dx, py - ay - t * dy);
}
function eraseAt(x, y) {
  const r = 10 * unitsPerPx(), i = layer.idx;
  ink.strokes = ink.strokes.filter((s) => {
    if (!shownOn(s, i)) return true;
    const p = s.pts, lim = r + s.w / 2;
    let hit = p.length === 2 && Math.hypot(x - p[0], y - p[1]) <= lim;
    for (let k = 0; !hit && k < p.length - 2; k += 2) hit = segDist(x, y, p[k], p[k + 1], p[k + 2], p[k + 3]) <= lim;
    if (hit) ink.active.removed.push(s);
    return !hit;
  });
}
function undoInk() {
  const u = ink.undo.pop();
  if (!u) { toast('Nothing to undo'); return; }
  if (u.add) ink.strokes = ink.strokes.filter((s) => !u.add.includes(s));
  if (u.removed) ink.strokes.push(...u.removed);
  saveInk(); queueInk();
}
function clearInk(all) {
  const i = layer ? layer.idx : 0;
  const removed = ink.strokes.filter((s) => all || shownOn(s, i));
  if (!removed.length) { toast(all ? 'No annotations' : 'No ink on this slide'); return; }
  ink.strokes = ink.strokes.filter((s) => !removed.includes(s));
  ink.undo.push({ removed });
  saveInk(); queueInk();
  toast(all ? 'All annotations cleared — undo restores them' : 'Slide cleared — undo restores it');
}
let inkSaveTimer = 0;
function saveInk() {
  clearTimeout(inkSaveTimer);
  const key = 'ink:' + docKey, data = ink.strokes;
  inkSaveTimer = setTimeout(() => idb.put(key, data), 400);
}
async function loadInk() {
  const saved = await idb.get('ink:' + docKey);
  ink.strokes = Array.isArray(saved) ? saved.filter((s) => s.page < numPages) : [];
  ink.undo = [];
  if (ink.strokes.length) toast(`${ink.strokes.length} saved annotation${ink.strokes.length > 1 ? 's' : ''} restored`);
}

// toolbar
function setTool(t) {
  ink.tool = t; store.set('tool', t);
  for (const b of toolsEl.querySelectorAll('[data-tool]')) b.classList.toggle('on', b.dataset.tool === t);
}
function showTools(on) { toolsEl.hidden = !on; }
function setDrawMode(on) {
  ink.drawMode = on;
  if (on) showTools(true);
  stage.style.cursor = on ? 'crosshair' : '';
  toolsEl.classList.toggle('drawing', on);
}
toolsEl.addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  if (b.dataset.tool) setTool(b.dataset.tool);
  else if (b.dataset.ink === 'undo') undoInk();
  else if (b.dataset.ink === 'clear') clearInk(false);
  else if (b.dataset.ink === 'mouse') setDrawMode(!ink.drawMode);
  else if (b.dataset.ink === 'hide') { setDrawMode(false); showTools(false); }
});
setTool(ink.tool);

// Apple Pencil taps on buttons don't always produce a click event in iPad Safari, so a pen
// tap on a control is turned into a click here (and any native click that follows is dropped).
let penClick = { el: null, t: 0 };
const PRESSABLE = 'button, label.btn, label.chk, [data-act], [data-save], [data-tool], [data-ink]';
document.addEventListener('pointerup', (e) => {
  if (e.pointerType !== 'pen') return;
  const el = e.target.closest && e.target.closest(PRESSABLE);
  if (!el || stage.contains(el)) return;
  penClick = { el, t: performance.now() };
  el.click();
}, true);
document.addEventListener('click', (e) => {
  if (!e.isTrusted || !penClick.el || performance.now() - penClick.t > 700) return;
  const el = e.target.closest && e.target.closest(PRESSABLE);
  if (el === penClick.el) { e.stopImmediatePropagation(); e.preventDefault(); penClick.el = null; }
}, true);

// ---------- export: strokes become vector paths in the original PDF ----------
function loadScript(src) {
  return new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => { s.remove(); rej(new Error('load failed')); }; document.head.appendChild(s); });
}
async function loadPdfLib() {
  if (window.PDFLib) return window.PDFLib;
  try { await loadScript(ASSET('./vendor/pdf-lib.min.js')); }
  catch { await loadScript('https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/dist/pdf-lib.min.js'); }
  return window.PDFLib;
}
function svgPathOf(p) {            // same smoothing as on screen; y negated for drawSvgPath's flip
  const f = (v) => +v.toFixed(3);
  let d = `M${f(p[0])} ${f(-p[1])}`;
  if (p.length <= 2) return d + ` L${f(p[0] + 0.01)} ${f(-p[1])}`;
  let k = 2;
  for (; k < p.length - 2; k += 2) d += ` Q${f(p[k])} ${f(-p[k + 1])} ${f((p[k] + p[k + 2]) / 2)} ${f(-(p[k + 1] + p[k + 3]) / 2)}`;
  return d + ` L${f(p[p.length - 2])} ${f(-p[p.length - 1])}`;
}
async function buildAnnotatedPdf() {
  const { PDFDocument, rgb, LineCapStyle } = await loadPdfLib();
  const doc = await PDFDocument.load(origBytes.slice(), { updateMetadata: false });
  const out = doc.getPages();
  for (let i = 0; i < out.length && i < numPages; i++) {
    for (const s of ink.strokes) {
      if (!shownOn(s, i)) continue;
      const n = parseInt(s.color.slice(1), 16);
      out[i].drawSvgPath(svgPathOf(s.pts), {
        x: 0, y: 0, borderWidth: s.w, borderOpacity: s.a, borderLineCap: LineCapStyle.Round,
        borderColor: rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255),
      });
    }
  }
  return doc.save();
}
let readyBlob = null, readyName = '';
async function exportAnnotated() {
  if (!pdf) return;
  if (!ink.strokes.length) { toast('No annotations to save yet'); return; }
  toast('Preparing annotated PDF…', 15000);
  try {
    const bytes = await buildAnnotatedPdf();
    readyBlob = new Blob([bytes], { type: 'application/pdf' });
    readyName = docName.replace(/\.pdf$/i, '') + ' (annotated).pdf';
    toast('', 1);
    $('savename').textContent = readyName;
    $('saveready').hidden = false;
  } catch (e) { toast('Could not build the PDF: ' + e.message, 4000); }
}
async function deliverReady() {   // runs from a tap, so share/download is allowed
  const blob = readyBlob, name = readyName;
  $('saveready').hidden = true;
  if (!blob) return;
  if (window.claude && window.claude.use) {                 // when opened as a claude.ai page
    try {
      const d = await window.claude.use('downloads');
      if (d) { await d.save({ filename: name, data: blob }); toast('Saved'); return; }
    } catch (e) { if (e && e.code === 'declined') { toast('Not saved'); return; } }
  }
  const file = new File([blob], name, { type: 'application/pdf' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {      // iPad: share sheet → Save to Files
    try { await navigator.share({ files: [file] }); return; }
    catch (e) { if (e.name === 'AbortError') return; }
  }
  const url = URL.createObjectURL(blob), a = document.createElement('a');
  a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
  toast('Downloaded ' + name, 2500);
}
$('saveready').addEventListener('click', (e) => {
  const act = e.target.closest('[data-save]')?.dataset.save;
  if (act === 'go') deliverReady();
  else if (act === 'cancel' || e.target === $('saveready')) $('saveready').hidden = true;
});

// ---------- opening files ----------
const idb = {
  open() {
    return new Promise((res, rej) => {
      const r = indexedDB.open('overlay-presenter', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('files');
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
  },
  async put(k, v) {
    try {
      const db = await this.open();
      await new Promise((res, rej) => { const tx = db.transaction('files', 'readwrite'); tx.objectStore('files').put(v, k); tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
    } catch { /* no IndexedDB here */ }
  },
  async get(k) {
    try {
      const db = await this.open();
      return await new Promise((res, rej) => { const r = db.transaction('files').objectStore('files').get(k); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    } catch { return null; }
  },
};

function pickFile() { $('file').click(); }
$('file').addEventListener('change', (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) openFile(f); });
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => {
  e.preventDefault();
  const f = [...(e.dataTransfer?.files || [])].find((x) => x.type === 'application/pdf' || /\.pdf$/i.test(x.name));
  if (f) openFile(f);
});
async function openFile(f) {
  const buf = await f.arrayBuffer();
  idb.put('last', { name: f.name, buf: buf.slice(0) });
  await openData(new Uint8Array(buf), f.name);
}
function closeDoc() {
  commitFade(); dropLayer(layer); layer = null;
  for (const e of backdrops.values()) freeCanvas(e.canvas);
  backdrops.clear(); pagePromises.clear(); pages.length = 0; linkCache.clear(); linkHistory.length = 0;
  ink.strokes = []; ink.undo = []; ink.active = null;
  resetView();
}
async function openData(data, name) {
  try {
    origBytes = data.slice(); docName = name;
    if (pdf) { const old = pdf; pdf = null; closeDoc(); old.destroy(); }
    const pdfjsLib = await pdfjsReady;  // also settles localPdfjs
    const opts = { data, enableXfa: false };
    if (localPdfjs) { opts.standardFontDataUrl = ASSET('./pdfjs/standard_fonts/'); opts.wasmUrl = ASSET('./pdfjs/wasm/'); }
    pdf = await pdfjsLib.getDocument(opts).promise;
    numPages = pdf.numPages;
    labels = await pdf.getPageLabels().catch(() => null);
    const vp = (await getPage(0)).getViewport({ scale: 1 });
    pageSize = { w: vp.width, h: vp.height };
    docKey = name + ':' + numPages;
    await loadInk();
    layout();
    startEl.hidden = true; closeMenu();
    const saved = Math.min(numPages - 1, Math.max(0, store.get('pos:' + docKey, 0)));
    await goTo(saved, { cut: true, force: true });
    if (saved > 0) toast(`Resumed at frame ${labels ? labels[saved] : saved + 1}`);
  } catch (e) {
    pdf = null;
    startEl.hidden = false;
    toast('Could not open PDF: ' + e.message, 4000);
  }
}

// ---------- resize / display changes ----------
let rzTimer = 0;
function onResize() { clearTimeout(rzTimer); rzTimer = setTimeout(relayout, 120); }
function relayout() {
  if (!pdf || !pageSize) return;
  commitFade(); layout(); resetView();
  goTo(target, { cut: true, force: true });
}
window.addEventListener('resize', onResize);
window.visualViewport?.addEventListener('resize', onResize);
(function watchDpr() {
  try { matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`).addEventListener('change', () => { onResize(); watchDpr(); }, { once: true }); } catch { /* old browser */ }
})();

// ---------- start ----------
(async () => {
  const last = await idb.get('last');
  if (last && last.buf) {
    const b = $('resume');
    b.querySelector('span').textContent = 'Resume “' + last.name + '”';
    b.hidden = false;
    b.addEventListener('click', () => openData(new Uint8Array(last.buf.slice(0)), last.name));
  }
})();

// Hook for automated tests.
window.__op = { get state() { return { target, layer: layer && layer.idx, fading: !!fading, view: { ...view }, W, H, numPages, labels, detail: !!(layer && layer.detail), strokes: ink.strokes.length }; }, ink, buildAnnotatedPdf, linkCache, pages, goTo, fitScale: () => fitScale, openData };
