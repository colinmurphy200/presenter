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
const cfg = Object.assign({ fadeIn: 280, fadeFrame: 0, showNum: false, blankStyle: 'lined' }, store.get('cfg', {}));
const MAX_ZOOM = 12;

// ---------- document state ----------
let pdf = null, docKey = '', labels = null, numPages = 0, pageSize = null, pdfCount = 0;
const pages = [];                 // resolved PDFPageProxy by PDF page index
const pagePromises = new Map();
const linkCache = new Map();      // PDF page index -> { list, promise }
const linkHistory = [];           // slots to return to after following a link

// The deck as shown: PDF pages in order, with any inserted blank pages after the page they follow.
// A slot is { p } for PDF page p, or { b: id, style, after } for an inserted blank page.
let seq = [], pdfSlots = [], blanks = {};   // blanks: PDF index -> [blank slots, in order]
const slotKey = (sl) => (sl.b ? 'b' + sl.b : 'p' + sl.p);
function rebuildSeq() {
  seq = [];
  for (let p = 0; p < pdfCount; p++) { seq.push(pdfSlots[p]); for (const bl of blanks[p] || []) seq.push(bl); }
  numPages = seq.length;
  if (layer && seq.includes(layer.slot)) { layer.idx = seq.indexOf(layer.slot); target = layer.idx; }
}
const seqIndexOfPdf = (p) => seq.indexOf(pdfSlots[p]);

// ---------- layout + view ----------
// Slide box is W x H CSS px. A point p in "fit" coordinates appears at s*p + t in the box.
let W = 0, H = 0, fitScale = 1, dpr = 1, gen = 0;
const view = { s: 1, tx: 0, ty: 0 };

let layer = null;        // the visible (top) layer
let fading = null;       // { old, neu, timer }
let target = 0;          // index we are heading to (updated synchronously)
let navToken = 0;
const backdrops = new Map();  // idx -> { gen, promise, canvas }

function getPage(i) {        // i = PDF page index
  let p = pagePromises.get(i);
  if (!p) { p = pdf.getPage(i + 1).then((pg) => (pages[i] = pg)); pagePromises.set(i, p); }
  return p;
}

// ---------- blank pages: ruling, drawn in page units (origin bottom-left, y up) ----------
function rulingOf(style) {
  const w = pageSize.w, h = pageSize.h, lw = (w / 1200) * 1.1, out = [];
  if (style === 'lined') {
    const gap = h / 16;
    for (let y = h - gap * 1.6; y > gap * 0.5; y -= gap) out.push([0, y, w, y, '#b9cde6', lw]);
    out.push([w * 0.08, 0, w * 0.08, h, '#e6a3a3', lw]);
  } else if (style === 'grid') {
    const c = h / 24;
    for (let x = c; x < w - 1e-6; x += c) out.push([x, 0, x, h, '#d3dae3', lw]);
    for (let y = h - c; y > 1e-6; y -= c) out.push([0, y, w, y, '#d3dae3', lw]);
  }
  return out;
}
const blankTransform = () => [fitScale, 0, 0, -fitScale, 0, H];   // page units -> fit CSS px
function drawBlank(canvas, style, v) {
  const ctx = canvas.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.setTransform(dpr * v.s, 0, 0, dpr * v.s, dpr * v.tx, dpr * v.ty);
  ctx.transform(...blankTransform());
  for (const [x1, y1, x2, y2, c, lw] of rulingOf(style)) {
    ctx.strokeStyle = c; ctx.lineWidth = lw; ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
  }
}
// page units <-> fit CSS px for any slot
function slotTransform(sl) { return sl.b ? blankTransform() : pages[sl.p].getViewport({ scale: fitScale }).transform; }
function slotReady(sl) { return !!(sl && (sl.b || pages[sl.p])); }
function fitToPage(sl, px, py) {
  if (sl.b) return [px / fitScale, (H - py) / fitScale];
  return pages[sl.p].getViewport({ scale: fitScale }).convertToPdfPoint(px, py);
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
  const sl = seq[i], key = slotKey(sl);
  const e = backdrops.get(key);
  if (e && e.gen === gen) return e.promise;
  const canvas = newCanvas('backdrop');
  let promise;
  if (sl.b) { drawBlank(canvas, sl.style, { s: 1, tx: 0, ty: 0 }); promise = Promise.resolve(canvas); }
  else {
    promise = getPage(sl.p)
      .then((pg) => pg.render({ canvas, viewport: pg.getViewport({ scale: fitScale * dpr }) }).promise)
      .then(() => canvas);
  }
  promise.catch(() => {});
  backdrops.set(key, { gen, promise, canvas });
  return promise;
}
function prefetch(i) {
  for (const j of [i + 1, i - 1, i + 2]) if (j >= 0 && j < numPages) { backdrop(j); loadLinks(j); }
  const keep = new Set();
  for (let j = i - 2; j <= i + 3; j++) if (seq[j]) keep.add(slotKey(seq[j]));
  for (const [k, e] of backdrops) {
    if (!keep.has(k) && !e.canvas.isConnected) { freeCanvas(e.canvas); backdrops.delete(k); }
  }
}

// ---------- layers ----------
function makeLayer(i, bd) {
  const el = document.createElement('div');
  el.className = 'layer';
  el.appendChild(bd);
  return { idx: i, slot: seq[i], el, bd, detail: null, ds: null, task: null };
}
function dropLayer(l) {
  if (!l) return;
  if (l.task) { l.task.cancel(); l.task = null; }
  freeCanvas(l.detail); l.detail = null;
  if (backdrops.get(slotKey(l.slot))?.canvas !== l.bd) freeCanvas(l.bd);
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
  if (l.slot.b) {                                   // blank page: draw the ruling directly
    const c = newCanvas('detail');
    drawBlank(c, l.slot.style, v);
    freeCanvas(l.detail);
    l.detail = c; l.ds = v; l.el.appendChild(c); place(l);
    return;
  }
  const pg = await getPage(l.slot.p);
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
// Two shown pages are steps of one frame when they are PDF pages with the same Beamer label
// (without labels, every PDF page fades into the next). Blank pages are never part of a frame.
function sameFrame(a, b) {
  const x = seq[a], y = seq[b];
  if (!x || !y || x.b || y.b) return false;
  return labels ? labels[x.p] === labels[y.p] : true;
}
const sameLabel = (a, b) => !!(labels && seq[a] && seq[b] && !seq[a].b && !seq[b].b && labels[seq[a].p] === labels[seq[b].p]);
function pdfFrameStart(p) { while (labels && p > 0 && labels[p - 1] === labels[p]) p--; return p; }
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
  ink.sel = [];
  redrawInk();
  if (old) placeAll();
  loadLinks(i);
  prefetch(i);
  store.set('pos:' + docKey, slotKey(seq[i]));
  updateTools();
  updateNum();
}
const next = () => goTo(target + 1);
const prev = () => goTo(target - 1);
function frameStart(i) { while (i > 0 && sameLabel(i - 1, i)) i--; return i; }
function frameEnd(i) { while (i < numPages - 1 && sameLabel(i + 1, i)) i++; return i; }
const nextFrame = () => goTo(frameEnd(target) + 1);
const prevFrame = () => goTo(frameStart(target) - 1);
function back() {
  while (linkHistory.length) { const i = seq.indexOf(linkHistory.pop()); if (i >= 0) { goTo(i); return; } }
}
function goLabel(str) {
  str = String(str).trim();
  if (!str) return;
  let p = labels ? labels.indexOf(str) : -1;
  if (p < 0 && /^\d+$/.test(str)) p = +str - 1;
  if (p >= 0 && p < pdfCount) { linkHistory.push(seq[target]); goTo(seqIndexOfPdf(p)); } else toast('No frame ' + str);
}
function updateNum() {
  numEl.style.display = cfg.showNum && pdf ? 'block' : 'none';
  if (!cfg.showNum || !pdf) return;
  const a = frameStart(target), b = frameEnd(target), sl = seq[target];
  const pl = (p) => (labels ? labels[p] : String(p + 1));
  const lab = sl.b ? `${pl(sl.after)} · blank ${blanks[sl.after].indexOf(sl) + 1}` : pl(sl.p);
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
function loadLinks(j) {        // j = shown-page index
  const sl = seq[j];
  if (!sl || sl.b) return Promise.resolve([]);
  const i = sl.p;
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
  if (layer.slot.b) return null;
  const list = linkCache.get(layer.slot.p)?.list;
  const pg = pages[layer.slot.p];
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
    linkHistory.push(seq[target]);
    goTo(seqIndexOfPdf(idx));
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
  if (!stripEl.hidden && !ink.active) { closeStrip(); return; }
  if (ink.active) return;                                     // ignore palm/fingers while writing
  if (ink.sel.length && ptrs.size === 0 && inSelection(e.clientX, e.clientY)) { startMove(e); return; }
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
document.addEventListener('touchmove', (e) => { if (!e.target.closest('.card, .strip')) e.preventDefault(); }, { passive: false });

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
  else if ((k === 'Delete' || k === 'Backspace') && ink.sel.length) deleteSelection();
  else if (['ArrowLeft', 'ArrowUp', 'PageUp', 'Backspace', 'p'].includes(k)) (e.shiftKey ? prevFrame() : prev());
  else if (k === ']') nextFrame();
  else if (k === '[') prevFrame();
  else if (k === 'Home') goTo(0);
  else if (k === 'End') goTo(numPages - 1);
  else if (k === 'f') toggleFullscreen();
  else if (k === 'Escape' && !stripEl.hidden) closeStrip();
  else if (k === 'Escape') { if (numBuf) numBuf = ''; else if (ink.sel.length) clearSelection(); else resetZoom(); }
  else if (k === 'l') { setTool('lasso'); setDrawMode(true); }
  else if (k === 't') toggleStrip();
  else if (k === '+' || k === '=') zoomAt(1.25, W / 2, H / 2);
  else if (k === '-' || k === '_') zoomAt(0.8, W / 2, H / 2);
  else if (k === 'b' || k === '.') toggleCurtain('black');
  else if (k === 'w' || k === ',') toggleCurtain('white');
  else if (k === 'm' || k === 'h' || k === '?') openMenu();
  else if (k === 'o') pickFile();
  else if (k === 'd') setDrawMode(!ink.drawMode);
  else if (k === 'e') { setTool('eraser'); setDrawMode(true); }
  else if (k === 'u') undoInk();
  else if (k === 'a') insertBlank();
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
  for (const b of document.querySelectorAll('[data-style]')) b.classList.toggle('on', b.dataset.style === cfg.blankStyle);
  updateTools();
  menuEl.hidden = false;
}
function closeMenu() { menuEl.hidden = true; }
menuEl.addEventListener('click', (e) => {
  if (e.target === menuEl) { closeMenu(); return; }
  const st = e.target.closest('[data-style]')?.dataset.style;
  if (st) { setBlankStyle(st); return; }
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
  else if (act === 'blank') { closeMenu(); insertBlank(); }
  else if (act === 'strip') openStrip();
  else if (act === 'delblank') { closeMenu(); deleteCurrentBlank(); }
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
const ink = { strokes: [], undo: [], active: null, sel: [], drawMode: false, lastPen: 0, tool: store.get('tool', 'red') };
const inkCanvas = $('ink'), inkCtx = inkCanvas.getContext('2d'), toolsEl = $('tools');
let origBytes = null, docName = 'slides.pdf';

function sizeInk() {
  inkCanvas.width = Math.max(1, Math.round(W * dpr)); inkCanvas.height = Math.max(1, Math.round(H * dpr));
  inkCanvas.style.width = W + 'px'; inkCanvas.style.height = H + 'px';
}
// Ink on a PDF page belongs to its frame and shows from the step it was written on;
// ink on a blank page belongs to that blank page.
function shownOn(s, i) {
  const sl = seq[i];
  if (!sl) return false;
  if (sl.b) return s.blank === sl.b;
  return !s.blank && s.frame === pdfFrameStart(sl.p) && s.page <= sl.p;
}
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
  if (!pdf || !layer || !slotReady(layer.slot)) return;
  const i = layer.idx;
  inkCtx.setTransform(dpr * view.s, 0, 0, dpr * view.s, dpr * view.tx, dpr * view.ty);
  inkCtx.transform(...slotTransform(layer.slot));
  inkCtx.lineCap = 'round'; inkCtx.lineJoin = 'round';
  const sel = new Set(ink.sel), u = unitsPerPx();
  for (const s of ink.strokes) {
    if (!shownOn(s, i)) continue;
    if (sel.has(s)) {                                 // blue halo under selected strokes
      inkCtx.globalAlpha = 0.35; inkCtx.strokeStyle = '#4f8cff'; inkCtx.lineWidth = s.w + 7 * u;
      inkCtx.beginPath(); strokePath(inkCtx, s.pts); inkCtx.stroke();
    }
    drawStroke(inkCtx, s);
  }
  if (ink.active && ink.active.stroke) drawStroke(inkCtx, ink.active.stroke);
  inkCtx.globalAlpha = 1;
  inkCtx.strokeStyle = '#2f6fe8'; inkCtx.lineWidth = 1.5 * u; inkCtx.setLineDash([6 * u, 4 * u]);
  if (ink.sel.length) { const [x1, y1, x2, y2] = selBox(); inkCtx.strokeRect(x1, y1, x2 - x1, y2 - y1); }
  const lp = ink.active && ink.active.lasso;
  if (lp && lp.length >= 4) {
    inkCtx.beginPath(); inkCtx.moveTo(lp[0], lp[1]);
    for (let k = 2; k < lp.length; k += 2) inkCtx.lineTo(lp[k], lp[k + 1]);
    inkCtx.closePath(); inkCtx.stroke();
  }
  inkCtx.setLineDash([]);
}
// ---------- lasso selection ----------
function selBox() {          // bounding box of the selection in page units, padded on screen
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (const s of ink.sel) {
    const p = s.pts, r = s.w / 2;
    for (let k = 0; k < p.length; k += 2) {
      x1 = Math.min(x1, p[k] - r); x2 = Math.max(x2, p[k] + r);
      y1 = Math.min(y1, p[k + 1] - r); y2 = Math.max(y2, p[k + 1] + r);
    }
  }
  const pad = 8 * unitsPerPx();
  return [x1 - pad, y1 - pad, x2 + pad, y2 + pad];
}
function inSelection(cx, cy) {
  if (!ink.sel.length || !layer || !slotReady(layer.slot)) return false;
  const [x, y] = toPdf(cx, cy), [x1, y1, x2, y2] = selBox();
  return x >= x1 && x <= x2 && y >= y1 && y <= y2;
}
function insidePoly(x, y, poly) {
  let inside = false;
  for (let a = 0, b = poly.length - 2; a < poly.length; b = a, a += 2) {
    const xa = poly[a], ya = poly[a + 1], xb = poly[b], yb = poly[b + 1];
    if ((ya > y) !== (yb > y) && x < ((xb - xa) * (y - ya)) / (yb - ya) + xa) inside = !inside;
  }
  return inside;
}
function finishLasso(poly) {
  ink.sel = [];
  if (poly.length >= 6) {
    for (const s of ink.strokes) {
      if (!shownOn(s, layer.idx)) continue;
      let n = 0; const p = s.pts;
      for (let k = 0; k < p.length; k += 2) if (insidePoly(p[k], p[k + 1], poly)) n++;
      if (n * 2 >= p.length / 2) ink.sel.push(s);       // at least half of its points inside the loop
    }
  }
}
function clearSelection() { if (ink.sel.length) { ink.sel = []; queueInk(); } }
function startMove(e) {
  try { stage.setPointerCapture(e.pointerId); } catch { /* synthetic */ }
  commitFade();
  const [x, y] = toPdf(e.clientX, e.clientY);
  ink.active = { id: e.pointerId, move: { x0: x, y0: y, dx: 0, dy: 0 } };
}
function deleteSelection() {
  const removed = ink.sel.filter((s) => ink.strokes.includes(s));
  ink.strokes = ink.strokes.filter((s) => !removed.includes(s));
  ink.sel = [];
  if (removed.length) ink.undo.push({ removed });
  saveInk(); queueInk();
  toast('Selection deleted — undo restores it');
}
function toPdf(cx, cy) {
  const b = boxPoint(cx, cy);
  return fitToPage(layer.slot, (b.x - view.tx) / view.s, (b.y - view.ty) / view.s);
}
const unitsPerPx = () => 1 / (fitScale * view.s);   // PDF units per CSS pixel on screen

function startInk(e) {
  if (!layer || !slotReady(layer.slot)) return;
  try { stage.setPointerCapture(e.pointerId); } catch { /* synthetic */ }
  commitFade();
  if (e.pointerType === 'pen') ink.lastPen = performance.now();
  showTools(true);
  const [x, y] = toPdf(e.clientX, e.clientY);
  if (ink.tool === 'lasso') { ink.sel = []; ink.active = { id: e.pointerId, lasso: [x, y] }; }
  else if (ink.tool === 'eraser') { ink.active = { id: e.pointerId, removed: [] }; eraseAt(x, y); }
  else {
    const t = TOOLS[ink.tool] || TOOLS.red;
    const sl = layer.slot, where = sl.b ? { blank: sl.b } : { page: sl.p, frame: pdfFrameStart(sl.p) };
    ink.active = { id: e.pointerId, stroke: { ...where, color: t.color, w: strokeWidth(t), a: t.a, pts: [x, y] } };
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
    } else if (a.lasso) a.lasso.push(x, y);
    else if (a.move) {
      const m = a.move, dx = x - m.x0 - m.dx, dy = y - m.y0 - m.dy;
      for (const s of ink.sel) for (let k = 0; k < s.pts.length; k += 2) { s.pts[k] += dx; s.pts[k + 1] += dy; }
      m.dx += dx; m.dy += dy;
    } else eraseAt(x, y);
  }
  if (e.pointerType === 'pen') ink.lastPen = performance.now();
  queueInk();
}
function endInk() {
  const a = ink.active; ink.active = null;
  if (a.stroke) { ink.strokes.push(a.stroke); ink.undo.push({ add: [a.stroke] }); }
  else if (a.lasso) finishLasso(a.lasso);
  else if (a.move) { if (a.move.dx || a.move.dy) ink.undo.push({ moved: [...ink.sel], dx: a.move.dx, dy: a.move.dy }); }
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
  ink.sel = [];
  if (u.moved) for (const s of u.moved) for (let k = 0; k < s.pts.length; k += 2) { s.pts[k] -= u.dx; s.pts[k + 1] -= u.dy; }
  if (u.add) ink.strokes = ink.strokes.filter((s) => !u.add.includes(s));
  if (u.removed) ink.strokes.push(...u.removed);
  if (u.addBlank) { removeBlank(u.addBlank, false); toast('Blank page removed'); }
  if (u.delBlank) {
    const bl = u.delBlank, list = blanks[bl.after] || (blanks[bl.after] = []);
    list.splice(Math.min(u.pos, list.length), 0, bl);
    if (u.strokesOnPage) ink.strokes.push(...u.strokesOnPage);
    rebuildSeq(); saveBlanks();
    goTo(seq.indexOf(bl), { cut: true });
  }
  if (u.blanks) { blanks = u.blanks; rebuildSeq(); saveBlanks(); updateTools(); }
  saveInk(); queueInk();
}
function clearInk(all) {
  const i = layer ? layer.idx : 0;
  const removed = ink.strokes.filter((s) => all || shownOn(s, i));
  const hadBlanks = all && Object.keys(blanks).length > 0;
  if (!removed.length && !hadBlanks) { toast(all ? 'No annotations' : 'No ink on this slide'); return; }
  ink.strokes = ink.strokes.filter((s) => !removed.includes(s));
  const entry = { removed };
  if (hadBlanks) {
    entry.blanks = blanks; blanks = {};
    const cur = layer && layer.slot;
    rebuildSeq(); saveBlanks();
    if (cur && cur.b) goTo(seqIndexOfPdf(cur.after), { cut: true, force: true });
  }
  ink.undo.push(entry);
  saveInk(); queueInk(); updateTools();
  toast(all ? 'All ink and blank pages cleared — undo restores them' : 'Slide cleared — undo restores it');
}

// ---------- inserting and removing blank pages ----------
let blankCounter = 0;
function insertBlank(style = cfg.blankStyle) {
  if (!pdf || !layer) return;
  const cur = layer.slot, after = cur.b ? cur.after : cur.p;
  const list = blanks[after] || (blanks[after] = []);
  const bl = { b: Date.now().toString(36) + (blankCounter++).toString(36), style, after };
  list.splice(cur.b ? list.indexOf(cur) + 1 : 0, 0, bl);
  rebuildSeq(); saveBlanks();
  ink.undo.push({ addBlank: bl });
  goTo(seq.indexOf(bl), { cut: true });
}
function removeBlank(bl, record = true) {
  const list = blanks[bl.after], pos = list ? list.indexOf(bl) : -1;
  if (pos < 0) return;
  const wasShowing = layer && layer.slot === bl, i = seq.indexOf(bl);
  list.splice(pos, 1);
  if (!list.length) delete blanks[bl.after];
  const strokes = ink.strokes.filter((s) => s.blank === bl.b);
  ink.strokes = ink.strokes.filter((s) => s.blank !== bl.b);
  if (record) ink.undo.push({ delBlank: bl, pos, strokesOnPage: strokes });
  rebuildSeq(); saveBlanks(); saveInk();
  if (wasShowing) goTo(Math.max(0, i - 1), { cut: true, force: true });
  updateTools();
}
function deleteCurrentBlank() {
  if (!layer || !layer.slot.b) return;
  removeBlank(layer.slot);
  toast('Blank page deleted — undo restores it');
}
function setBlankStyle(style) {
  cfg.blankStyle = style; store.set('cfg', cfg);
  for (const b of document.querySelectorAll('[data-style]')) b.classList.toggle('on', b.dataset.style === style);
  if (layer && layer.slot.b && layer.slot.style !== style) {   // restyle the blank page on screen
    layer.slot.style = style; saveBlanks();
    backdrops.delete(slotKey(layer.slot));
    goTo(layer.idx, { cut: true, force: true });
  }
}
function updateTools() {
  const onBlank = !!(layer && layer.slot && layer.slot.b);
  const del = toolsEl && toolsEl.querySelector('[data-ink=delblank]');
  if (del) del.hidden = !onBlank;
  const mdel = document.querySelector('[data-act=delblank]');
  if (mdel) mdel.hidden = !onBlank;
}
let blankSaveTimer = 0;
function saveBlanks() {
  clearTimeout(blankSaveTimer);
  const key = 'blanks:' + docKey;
  const data = Object.values(blanks).flat().map(({ b, style, after }) => ({ b, style, after }));
  blankSaveTimer = setTimeout(() => idb.put(key, data), 300);
}
async function loadBlanks() {
  blanks = {};
  const saved = await idb.get('blanks:' + docKey);
  if (Array.isArray(saved)) for (const bl of saved) if (bl.after < pdfCount) (blanks[bl.after] || (blanks[bl.after] = [])).push({ ...bl });
}
let inkSaveTimer = 0;
function saveInk() {
  clearTimeout(inkSaveTimer);
  const key = 'ink:' + docKey, data = ink.strokes;
  inkSaveTimer = setTimeout(() => idb.put(key, data), 400);
}
async function loadInk() {
  const saved = await idb.get('ink:' + docKey);
  const ids = new Set(Object.values(blanks).flat().map((bl) => bl.b));
  ink.strokes = Array.isArray(saved) ? saved.filter((s) => (s.blank ? ids.has(s.blank) : s.page < pdfCount)) : [];
  ink.undo = [];
  if (ink.strokes.length) toast(`${ink.strokes.length} saved annotation${ink.strokes.length > 1 ? 's' : ''} restored`);
}

// toolbar
function setTool(t) {
  if (t !== 'lasso') clearSelection();
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
  else if (b.dataset.ink === 'clear') { if (ink.sel.length) deleteSelection(); else clearInk(false); }
  else if (b.dataset.ink === 'mouse') setDrawMode(!ink.drawMode);
  else if (b.dataset.ink === 'blank') insertBlank();
  else if (b.dataset.ink === 'strip') toggleStrip();
  else if (b.dataset.ink === 'delblank') deleteCurrentBlank();
  else if (b.dataset.ink === 'hide') { setDrawMode(false); showTools(false); }
});
setTool(ink.tool);

// Apple Pencil taps on buttons don't always produce a click event in iPad Safari, so a pen
// tap on a control is turned into a click here (and any native click that follows is dropped).
let penClick = { el: null, t: 0 };
const PRESSABLE = 'button, label.btn, label.chk, [data-act], [data-save], [data-tool], [data-ink], [data-style], .thumb';
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
  const hex = (c) => { const n = parseInt(c.slice(1), 16); return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255); };
  seq.forEach((sl, j) => { if (sl.b) doc.insertPage(j, [pageSize.w, pageSize.h]); });   // blank pages in place
  const out = doc.getPages();
  for (let j = 0; j < seq.length && j < out.length; j++) {
    if (seq[j].b) {
      for (const [x1, y1, x2, y2, c, lw] of rulingOf(seq[j].style)) {
        out[j].drawLine({ start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, thickness: lw, color: hex(c) });
      }
    }
    for (const s of ink.strokes) {
      if (!shownOn(s, j)) continue;
      out[j].drawSvgPath(svgPathOf(s.pts), {
        x: 0, y: 0, borderWidth: s.w, borderOpacity: s.a, borderLineCap: LineCapStyle.Round, borderColor: hex(s.color),
      });
    }
  }
  return doc.save();
}
let readyBlob = null, readyName = '';
async function exportAnnotated() {
  if (!pdf) return;
  if (!ink.strokes.length && !Object.keys(blanks).length) { toast('No annotations to save yet'); return; }
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

// ---------- slide strip: thumbnails to jump around the deck ----------
const stripEl = $('strip'), stripInner = $('stripInner');
let thumbObserver = null;
function stripEntries() {      // one per frame (pictured fully revealed, entered at its first step) and per blank page
  const out = [];
  for (let i = 0; i < seq.length; i++) {
    const sl = seq[i];
    if (sl.b) { out.push({ go: i, show: i, label: 'blank' }); continue; }
    if (frameStart(i) !== i) continue;
    out.push({ go: i, show: frameEnd(i), label: labels ? labels[sl.p] : String(sl.p + 1) });
  }
  return out;
}
function openStrip() {
  if (!pdf) return;
  closeMenu();
  const tw = Math.round(Math.min(180, Math.max(110, window.innerWidth / 7.5))), th = Math.round((tw * pageSize.h) / pageSize.w);
  if (thumbObserver) thumbObserver.disconnect();
  for (const c of stripInner.querySelectorAll('canvas')) freeCanvas(c);
  stripInner.textContent = '';
  thumbObserver = new IntersectionObserver((ents) => {
    for (const en of ents) if (en.isIntersecting) { thumbObserver.unobserve(en.target); renderThumb(en.target); }
  }, { root: stripEl, rootMargin: '0px 600px' });
  for (const en of stripEntries()) {
    const b = document.createElement('button');
    b.className = 'thumb'; b.dataset.thumb = en.go; b.dataset.show = en.show;
    const c = document.createElement('canvas');
    c.width = Math.round(tw * dpr); c.height = Math.round(th * dpr); c.style.width = tw + 'px'; c.style.height = th + 'px';
    const lab = document.createElement('span'); lab.textContent = en.label;
    b.append(c, lab);
    if (target >= en.go && target <= en.show) b.classList.add('cur');
    stripInner.appendChild(b);
    thumbObserver.observe(b);
  }
  stripEl.hidden = false;
  const cur = stripInner.querySelector('.cur');
  if (cur) stripEl.scrollLeft = cur.offsetLeft - (stripEl.clientWidth - cur.offsetWidth) / 2;
}
function closeStrip() {
  if (stripEl.hidden) return;
  stripEl.hidden = true;
  if (thumbObserver) thumbObserver.disconnect();
  for (const c of stripInner.querySelectorAll('canvas')) freeCanvas(c);
  stripInner.textContent = '';
}
const toggleStrip = () => (stripEl.hidden ? openStrip() : closeStrip());
async function renderThumb(btn) {
  const i = +btn.dataset.show, sl = seq[i], c = btn.querySelector('canvas');
  if (!sl || !c || !c.width) return;
  const ctx = c.getContext('2d');
  try {
    if (sl.b) {
      const k = c.width / pageSize.w;
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
      ctx.setTransform(k, 0, 0, -k, 0, c.height);
      for (const [x1, y1, x2, y2, col, lw] of rulingOf(sl.style)) {
        ctx.strokeStyle = col; ctx.lineWidth = Math.max(lw, 0.7 / k);
        ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
      }
    } else {
      const pg = await getPage(sl.p);
      const vp = pg.getViewport({ scale: c.width / pg.getViewport({ scale: 1 }).width });
      await pg.render({ canvas: c, viewport: vp }).promise;
      if (!c.width) return;                       // strip closed meanwhile
      ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.transform(...vp.transform);
    }
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    const minW = 1.4 / Math.hypot(ctx.getTransform().a, ctx.getTransform().b);   // keep ink visible when small
    for (const s of ink.strokes) if (shownOn(s, i)) drawStroke(ctx, { ...s, w: Math.max(s.w, minW) });
    ctx.globalAlpha = 1;
  } catch { /* closed or cancelled */ }
}
stripEl.addEventListener('click', (e) => {
  const b = e.target.closest('.thumb');
  if (!b) return;
  const i = +b.dataset.thumb;
  closeStrip();
  if (seq[i] && i !== target) { linkHistory.push(seq[target]); goTo(i); }
});
stripEl.addEventListener('wheel', (e) => {     // a vertical wheel scrolls the strip sideways
  if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) { stripEl.scrollLeft += e.deltaY * (e.deltaMode === 1 ? 16 : 1); e.preventDefault(); }
}, { passive: false });

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
  closeStrip();
  commitFade(); dropLayer(layer); layer = null;
  for (const e of backdrops.values()) freeCanvas(e.canvas);
  backdrops.clear(); pagePromises.clear(); pages.length = 0; linkCache.clear(); linkHistory.length = 0;
  seq = []; pdfSlots = []; blanks = {}; numPages = 0;
  ink.strokes = []; ink.undo = []; ink.active = null; ink.sel = [];
  resetView();
}
async function openData(data, name) {
  try {
    origBytes = data.slice(); docName = name;
    if (pdf) { const old = pdf; pdf = null; closeDoc(); old.loadingTask.destroy().catch(() => {}); }   // PDF.js 6: close via its loading task
    const pdfjsLib = await pdfjsReady;  // also settles localPdfjs
    const opts = { data, enableXfa: false };
    if (localPdfjs) { opts.standardFontDataUrl = ASSET('./pdfjs/standard_fonts/'); opts.wasmUrl = ASSET('./pdfjs/wasm/'); }
    pdf = await pdfjsLib.getDocument(opts).promise;
    pdfCount = pdf.numPages;
    pdfSlots = Array.from({ length: pdfCount }, (_, p) => ({ p }));
    labels = await pdf.getPageLabels().catch(() => null);
    const vp = (await getPage(0)).getViewport({ scale: 1 });
    pageSize = { w: vp.width, h: vp.height };
    docKey = name + ':' + pdfCount;
    await loadBlanks();
    rebuildSeq();
    await loadInk();
    layout();
    startEl.hidden = true; closeMenu();
    const pos = store.get('pos:' + docKey, 0);   // a slot key ('p3', 'b…'), or a page index from older versions
    let saved = typeof pos === 'number' ? seqIndexOfPdf(Math.min(pdfCount - 1, Math.max(0, pos))) : seq.findIndex((sl) => slotKey(sl) === pos);
    if (saved < 0) saved = 0;
    await goTo(saved, { cut: true, force: true });
    if (saved > 0) toast(seq[saved].b ? 'Resumed on a blank page' : `Resumed at frame ${labels ? labels[seq[saved].p] : seq[saved].p + 1}`);
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
  closeStrip();
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
window.__op = { get state() { return { target, layer: layer && layer.idx, fading: !!fading, view: { ...view }, W, H, numPages, labels, detail: !!(layer && layer.detail), strokes: ink.strokes.length, slot: layer && slotKey(layer.slot), seqLen: seq.length }; }, ink, buildAnnotatedPdf, insertBlank, setBlankStyle, linkCache, pages, goTo, fitScale: () => fitScale, openData };
