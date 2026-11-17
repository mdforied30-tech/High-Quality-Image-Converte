// High Quality Image Convert v2 (FM Developer)
// 4K-safe: tiled AI upscale, banded pixel processing, worker-based vector tracing,
// memory-aware size limits. Everything runs in the browser; photos never leave the device.
const $ = (s) => document.querySelector(s);
const COARSE = matchMedia("(pointer:coarse)").matches;      // phone/tablet
const MAX_PX = COARSE ? 16e6 : 120e6;                         // safe canvas area
const MAX_SIDE = COARSE ? 8192 : 16384;
const TILE = COARSE ? 96 : 160, OVER = 12;                    // AI tile size + overlap (hides seams)
const tick = () => new Promise((r) => setTimeout(r, 0));      // let the UI breathe
const PRESET = { fhd: 1920, "2k": 2560, "3k": 3072, "4k": 3840 }; // long-side pixels
const state = { tool: "jpg2jpeg", files: [], outputs: [], upscaler: {}, cancel: false, prog: () => {} };

const GROUPS = { jpg2jpeg: "convert", png2jpg: "convert", jpg2png: "convert", jpg2webp: "convert", webp2jpg: "convert", svg: "vector", eps: "vector", upscale: "upscale" };
const CONVERT = {
  jpg2jpeg: ["image/jpeg", "jpeg"], png2jpg: ["image/jpeg", "jpg"], webp2jpg: ["image/jpeg", "jpg"],
  jpg2png: ["image/png", "png"], jpg2webp: ["image/webp", "webp"],
};

/* ---------- UI ---------- */
const status = (t) => ($("#status").textContent = t);
const progress = (p) => { $("#barwrap").hidden = p == null; $("#bar").style.width = (p || 0) + "%"; };
function refreshOptions() {
  const g = GROUPS[state.tool];
  document.querySelectorAll(".row").forEach((r) => (r.hidden = !r.dataset.for.split(" ").includes(g)));
  const noQ = state.tool === "jpg2png" || (g === "upscale" && $("#upfmt").value === "png");
  $("#quality").closest(".row").hidden = noQ || g === "vector";
}
function warmUp() { // preload the AI model while the user picks options
  if (state.tool === "upscale" && $("#method").value === "ai" && isNum($("#scale").value)) getUpscaler(+$("#scale").value).catch(() => {});
}
const isNum = (v) => /^\d+$/.test(v);
$("#tools").addEventListener("click", (e) => {
  const b = e.target.closest(".chip"); if (!b) return;
  document.querySelectorAll(".chip").forEach((c) => c.classList.remove("active"));
  b.classList.add("active"); state.tool = b.dataset.tool; refreshOptions(); warmUp();
});
$("#upfmt").addEventListener("change", refreshOptions);
$("#scale").addEventListener("change", warmUp);
$("#method").addEventListener("change", warmUp);
$("#quality").oninput = (e) => ($("#qv").textContent = e.target.value);
$("#colors").oninput = (e) => ($("#cv").textContent = e.target.value);
$("#detail").onchange = (e) => ($("#dv").textContent = e.target.selectedOptions[0].text.split(" ")[0]);
$("#cancel").addEventListener("click", () => { state.cancel = true; status("Cancelling..."); });

const drop = $("#drop");
$("#file").addEventListener("change", (e) => setFiles(e.target.files));
["dragenter", "dragover"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("over"); }));
["dragleave", "drop"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("over"); }));
drop.addEventListener("drop", (e) => setFiles(e.dataTransfer.files));
function setFiles(list) {
  state.files = [...list].filter((f) => f.type.startsWith("image/"));
  $("#go").disabled = !state.files.length;
  status(state.files.length ? `${state.files.length} image(s) ready. Press Start.` : "No valid image selected.");
}

/* ---------- Image helpers ---------- */
async function loadImage(file) {
  const url = URL.createObjectURL(file), img = new Image(); img.src = url;
  try { await img.decode(); } catch { throw new Error("Cannot read " + file.name); }
  return { img, url };
}
const makeCanvas = (w, h) => { const c = document.createElement("canvas"); c.width = Math.max(1, w); c.height = Math.max(1, h); return c; };
const toBlob = (c, type, q) => new Promise((r) => c.toBlob(r, type, q));
const baseName = (n) => n.replace(/\.[^.]+$/, "");
const kb = (n) => (n > 1048576 ? (n / 1048576).toFixed(2) + " MB" : Math.round(n / 1024) + " KB");

// Keep any size inside what the device can safely hold
function fitDims(w, h) {
  const f = Math.min(1, Math.sqrt(MAX_PX / (w * h)), MAX_SIDE / Math.max(w, h));
  return f >= 1 ? [w, h, false] : [Math.floor(w * f), Math.floor(h * f), true];
}
function drawFull(img, flatten) {
  const [w, h, shrunk] = fitDims(img.naturalWidth, img.naturalHeight);
  if (shrunk) status("Image is larger than this device can safely handle, resized to fit.");
  const c = makeCanvas(w, h), x = c.getContext("2d");
  if (flatten) { x.fillStyle = "#fff"; x.fillRect(0, 0, w, h); }
  x.imageSmoothingEnabled = true; x.imageSmoothingQuality = "high"; x.drawImage(img, 0, 0, w, h); return c;
}
function hasAlpha(canvas) {
  const s = makeCanvas(64, 64), x = s.getContext("2d", { willReadFrequently: true }); x.drawImage(canvas, 0, 0, 64, 64);
  const d = x.getImageData(0, 0, 64, 64).data; for (let i = 3; i < d.length; i += 4) if (d[i] < 250) return true; return false;
}
// High quality resize: step by x2 so detail is never lost (good for 4K down/up sizing)
function resizeTo(src, tw, th) {
  let cur = src;
  while (cur.width !== tw) {
    const nw = tw > cur.width ? Math.min(tw, cur.width * 2) : Math.max(tw, Math.ceil(cur.width / 2));
    const nh = th > cur.height ? Math.min(th, cur.height * 2) : Math.max(th, Math.ceil(cur.height / 2));
    const n = makeCanvas(nw, nh), x = n.getContext("2d"); x.imageSmoothingEnabled = true; x.imageSmoothingQuality = "high";
    x.drawImage(cur, 0, 0, nw, nh); if (cur !== src) cur.width = cur.height = 1; cur = n;
  }
  if (cur.height !== th) { const n = makeCanvas(tw, th); const x = n.getContext("2d"); x.imageSmoothingQuality = "high"; x.drawImage(cur, 0, 0, tw, th); cur = n; }
  return cur;
}

// Colour enhance, processed in bands so big images never freeze the page
async function enhance(canvas, mode) {
  if (mode === "none") return canvas;
  const [ct, sat, warm] = { natural: [1.08, 1.12, 0], vivid: [1.18, 1.3, 4], rich: [1.12, 1.22, 10] }[mode];
  const w = canvas.width, h = canvas.height, x = canvas.getContext("2d"), BH = Math.max(32, Math.floor(2e6 / w));
  for (let y = 0; y < h; y += BH) {
    const bh = Math.min(BH, h - y), d = x.getImageData(0, y, w, bh), a = d.data;
    for (let i = 0; i < a.length; i += 4) {
      const r = a[i], g = a[i + 1], b = a[i + 2], l = 0.299 * r + 0.587 * g + 0.114 * b;
      a[i] = (l + (r - l) * sat - 128) * ct + 128 + warm;
      a[i + 1] = (l + (g - l) * sat - 128) * ct + 128;
      a[i + 2] = (l + (b - l) * sat - 128) * ct + 128 - warm;
    }
    x.putImageData(d, 0, y); await tick();
  }
  return canvas;
}
// Fast single-pass unsharp mask, also banded
async function sharpen(canvas, amount = 0.5) {
  const w = canvas.width, h = canvas.height, x = canvas.getContext("2d"), BH = Math.max(32, Math.floor(2e6 / w));
  const k = 1 + 4 * amount, n = -amount, st = w * 4;
  for (let y0 = 0; y0 < h; y0 += BH) {
    const ya = Math.max(0, y0 - 1), yb = Math.min(h, y0 + BH + 1), bh = yb - ya, ye = Math.min(h, y0 + BH);
    const src = x.getImageData(0, ya, w, bh), s = src.data, o = new Uint8ClampedArray(s);
    for (let y = Math.max(y0, 1); y < Math.min(ye, h - 1); y++) {
      let i = ((y - ya) * w + 1) * 4;
      for (let xx = 1; xx < w - 1; xx++, i += 4) {
        o[i] = s[i] * k + n * (s[i - 4] + s[i + 4] + s[i - st] + s[i + st]);
        o[i + 1] = s[i + 1] * k + n * (s[i - 3] + s[i + 5] + s[i + 1 - st] + s[i + 1 + st]);
        o[i + 2] = s[i + 2] * k + n * (s[i - 2] + s[i + 6] + s[i + 2 - st] + s[i + 2 + st]);
      }
    }
    x.putImageData(new ImageData(o, w, bh), 0, ya, 0, y0 - ya, w, ye - y0); await tick();
  }
  return canvas;
}

/* ---------- Converters ---------- */
async function doConvert(file, { img }) {
  const [mime, ext] = CONVERT[state.tool], q = +$("#quality").value / 100;
  let c = drawFull(img, mime === "image/jpeg");
  const T = +$("#res").value, long = Math.max(c.width, c.height); // optional HD/2K/3K/4K/8K output size
  if (T > 0 && T !== long) {
    const [tw, th, shrunk] = fitDims(Math.round((c.width * T) / long), Math.round((c.height * T) / long));
    if (shrunk) status(`Resolution limited to ${Math.max(tw, th)}px by this device's memory.`);
    const big = tw > c.width; c = resizeTo(c, tw, th); if (big) c = await sharpen(c, 0.4);
  }
  state.prog(0.3); c = await enhance(c, $("#enhance").value); state.prog(0.7);
  const blob = await toBlob(c, mime, mime === "image/png" ? undefined : q);
  return { blob, name: `${baseName(file.name)}.${ext}`, w: c.width, h: c.height };
}

/* ---------- Vector (SVG / EPS) ---------- */
function traceOptions() {
  const base = { numberofcolors: +$("#colors").value, colorsampling: 2, colorquantcycles: 4, blurradius: 0, strokewidth: 0, roundcoords: 2, viewbox: true, desc: false };
  const d = { fine: { ltres: 0.3, qtres: 0.3, pathomit: 2 }, balanced: { ltres: 1, qtres: 1, pathomit: 8 }, smooth: { ltres: 2, qtres: 2, pathomit: 20, blurradius: 2, blurdelta: 20 } }[$("#detail").value];
  return { ...base, ...d };
}
function traceSource(img) {
  const max = COARSE ? 1000 : 1600, s = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
  const c = makeCanvas(Math.round(img.naturalWidth * s), Math.round(img.naturalHeight * s));
  const x = c.getContext("2d", { willReadFrequently: true }); x.imageSmoothingQuality = "high"; x.drawImage(img, 0, 0, c.width, c.height);
  const d = x.getImageData(0, 0, c.width, c.height); return { width: d.width, height: d.height, data: d.data };
}
async function runTrace(mode, imgd, opts) { // tracing runs in a Web Worker so the page stays smooth
  try {
    return await new Promise((res, rej) => {
      const w = new Worker("worker.js"), to = setTimeout(() => { w.terminate(); rej(new Error("timeout")); }, 180000);
      w.onmessage = (e) => { clearTimeout(to); w.terminate(); e.data.error ? rej(new Error(e.data.error)) : res(e.data.result); };
      w.onerror = () => { clearTimeout(to); w.terminate(); rej(new Error("worker")); };
      w.postMessage({ mode, imgd, options: opts });
    });
  } catch (e) {
    console.warn("Worker unavailable, tracing on main thread", e); await tick();
    return mode === "svg" ? ImageTracer.imagedataToSVG(imgd, opts) : ImageTracer.imagedataToTracedata(imgd, opts);
  }
}
async function doSVG(file, { img }) {
  state.prog(0.2); const svg = await runTrace("svg", traceSource(img), traceOptions());
  return { blob: new Blob([svg], { type: "image/svg+xml" }), name: `${baseName(file.name)}.svg`, w: img.naturalWidth, h: img.naturalHeight };
}
function tracedataToEPS(td) {
  const W = td.width, H = td.height, f = (n) => +n.toFixed(2), parts = [];
  parts.push(`%!PS-Adobe-3.0 EPSF-3.0\n%%BoundingBox: 0 0 ${W} ${H}\n%%Creator: FM Developer - High Quality Image Convert\n%%EndComments\n`);
  const sub = (p) => {
    const s = p.segments; if (!s.length) return "";
    let t = `${f(s[0].x1)} ${f(H - s[0].y1)} moveto\n`;
    for (const g of s) {
      if (g.type === "L") t += `${f(g.x2)} ${f(H - g.y2)} lineto\n`;
      else { const x0 = g.x1, y0 = g.y1, cx = g.x2, cy = g.y2, x1 = g.x3, y1 = g.y3; // quadratic to cubic
        t += `${f(x0 + (2 / 3) * (cx - x0))} ${f(H - (y0 + (2 / 3) * (cy - y0)))} ${f(x1 + (2 / 3) * (cx - x1))} ${f(H - (y1 + (2 / 3) * (cy - y1)))} ${f(x1)} ${f(H - y1)} curveto\n`; }
    }
    return t + "closepath\n";
  };
  td.layers.forEach((layer, k) => {
    const c = td.palette[k]; if (!c || c.a === 0) return;
    parts.push(`${(c.r / 255).toFixed(4)} ${(c.g / 255).toFixed(4)} ${(c.b / 255).toFixed(4)} setrgbcolor\n`);
    layer.forEach((p) => {
      if (p.isholepath) return;
      let o = "newpath\n" + sub(p); (p.holechildren || []).forEach((hi) => { if (layer[hi]) o += sub(layer[hi]); });
      parts.push(o + "eofill\n");
    });
  });
  parts.push("showpage\n%%EOF\n"); return parts.join("");
}
async function doEPS(file, { img }) {
  state.prog(0.2); const td = await runTrace("trace", traceSource(img), traceOptions()); state.prog(0.8);
  return { blob: new Blob([tracedataToEPS(td)], { type: "application/postscript" }), name: `${baseName(file.name)}.eps`, w: td.width, h: td.height };
}

/* ---------- Upscale (AI tiles + fast fallback) ---------- */
function getUpscaler(scale) { // cached promise: model loads once
  if (!state.upscaler[scale]) {
    state.upscaler[scale] = (async () => {
      status(`Loading AI model (${scale}x), first time only...`);
      const [{ default: Upscaler }, { default: model }] = await Promise.all([
        import("https://esm.sh/upscaler@1.0.0-beta.19"),
        import(`https://esm.sh/@upscalerjs/esrgan-medium@1.0.0-beta.14/${scale}x`),
      ]);
      const up = new Upscaler({ model }); status("AI model ready."); return up;
    })().catch((e) => { delete state.upscaler[scale]; throw e; });
  }
  return state.upscaler[scale];
}
// The image is cut into small overlapping tiles, so memory stays low even for 4K output
async function aiTiles(src, m, up) {
  const W = src.width, H = src.height, out = makeCanvas(W * m, H * m), ox = out.getContext("2d");
  const cols = Math.ceil(W / TILE), rows = Math.ceil(H / TILE), total = cols * rows; let done = 0;
  for (let ty = 0; ty < rows; ty++) for (let tx = 0; tx < cols; tx++) {
    if (state.cancel) throw new Error("Cancelled");
    const px = tx * TILE, py = ty * TILE, pw = Math.min(TILE, W - px), ph = Math.min(TILE, H - py);
    const x0 = Math.max(0, px - OVER), y0 = Math.max(0, py - OVER), x1 = Math.min(W, px + pw + OVER), y1 = Math.min(H, py + ph + OVER);
    const t = makeCanvas(x1 - x0, y1 - y0); t.getContext("2d").drawImage(src, x0, y0, x1 - x0, y1 - y0, 0, 0, x1 - x0, y1 - y0);
    const im = new Image(); im.src = await up.upscale(t); await im.decode();
    ox.drawImage(im, (px - x0) * m, (py - y0) * m, pw * m, ph * m, px * m, py * m, pw * m, ph * m);
    done++; state.prog(done / total * 0.9); status(`AI upscaling... ${Math.round(done / total * 100)}%`);
    if (done % 2 === 0) await tick();
  }
  return out;
}
async function doUpscale(file, { img }) {
  const sel = $("#scale").value, fmt = $("#upfmt").value, src = drawFull(img, false), W = src.width, H = src.height, long = Math.max(W, H);
  let tw, th;
  const T = PRESET[sel];
  if (T) {
    if (long >= T) throw new Error(`${file.name} is already ${T}px or larger. Choose 2x, 3x or 4x instead.`);
    tw = Math.round(W * T / long); th = Math.round(H * T / long);
  } else { tw = W * +sel; th = H * +sel; }
  [tw, th] = fitDims(tw, th);
  const need = tw / W; let m = need <= 2 ? 2 : need <= 3 ? 3 : 4;
  while (m > 2 && W * m * H * m > MAX_PX) m--;
  const jpg = fmt === "jpg" || fmt === "jpeg";
  const alpha = !jpg && hasAlpha(src); // AI drops transparency, so keep alpha images on the fast path
  let c = null, usedAI = false;
  if ($("#method").value === "ai" && W * m * H * m <= MAX_PX && !alpha) {
    try { c = await aiTiles(src, m, await getUpscaler(m)); usedAI = true; }
    catch (e) { if (e.message === "Cancelled") throw e; console.warn(e); status("AI model could not run, using Fast Upscale instead."); c = null; }
  } else if (alpha && $("#method").value === "ai") status("Transparent image: using Fast Upscale to keep transparency.");
  if (!c) c = src;
  if (c.width !== tw || c.height !== th) c = resizeTo(c, tw, th);
  state.prog(0.92);
  if (!usedAI) c = await sharpen(c, 0.55);
  c = await enhance(c, $("#enhance").value);
  if (jpg) { const f = makeCanvas(c.width, c.height), x = f.getContext("2d"); x.fillStyle = "#fff"; x.fillRect(0, 0, f.width, f.height); x.drawImage(c, 0, 0); c = f; }
  const mime = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp" }[fmt];
  const blob = await toBlob(c, mime, mime === "image/png" ? undefined : +$("#quality").value / 100);
  const label = PRESET[sel] ? (sel === "fhd" ? "FullHD" : sel.toUpperCase()) : sel + "x";
  return { blob, name: `${baseName(file.name)}_${label}.${fmt}`, w: c.width, h: c.height };
}

/* ---------- Run ---------- */
const RUN = { svg: doSVG, eps: doEPS, upscale: doUpscale };
$("#go").addEventListener("click", async () => {
  const fn = RUN[state.tool] || doConvert, N = state.files.length; let lock = null;
  state.cancel = false; state.outputs = []; $("#results").innerHTML = ""; $("#zipall").hidden = true;
  $("#go").disabled = true; $("#cancel").hidden = false;
  try { lock = await navigator.wakeLock?.request("screen"); } catch {} // keep screen on during long jobs
  for (let i = 0; i < N; i++) {
    if (state.cancel) break;
    const f = state.files[i]; state.prog = (p) => progress(Math.round(((i + p) / N) * 100));
    status(`Working on ${f.name} (${i + 1}/${N})`); state.prog(0); await tick();
    try {
      const src = await loadImage(f), out = await fn(f, src); out.url = URL.createObjectURL(out.blob);
      state.outputs.push(out); addResult(src.url, f, out);
    } catch (e) {
      if (e.message === "Cancelled") break;
      console.error(e); $("#results").insertAdjacentHTML("beforeend", `<div class="res err">${f.name}: ${e.message}</div>`);
    }
  }
  try { lock?.release(); } catch {}
  progress(null); $("#cancel").hidden = true; $("#go").disabled = false;
  status(state.cancel ? "Cancelled." : "Done. Your files are ready to download.");
  $("#zipall").hidden = state.outputs.length < 2;
});
function addResult(origUrl, f, o) {
  const ext = o.name.split(".").pop(), vec = /svg|eps/.test(ext), preview = ext === "eps" ? origUrl : o.url;
  $("#results").insertAdjacentHTML("beforeend", `
  <div class="res"><div class="pair">
    <figure><img src="${origUrl}" alt=""><figcaption>Before</figcaption></figure>
    <figure><img src="${preview}" alt=""><figcaption>After</figcaption></figure></div>
    <div class="meta"><span>${f.name} (${kb(f.size)})</span><span>${o.w}x${o.h} &rarr; ${kb(o.blob.size)}${vec ? " vector" : ""}</span></div>
    <a class="dl" href="${o.url}" download="${o.name}">Download ${o.name}</a></div>`);
}
$("#zipall").addEventListener("click", async () => {
  const z = new JSZip(); state.outputs.forEach((o) => z.file(o.name, o.blob));
  const b = await z.generateAsync({ type: "blob", compression: "STORE" }); // STORE = no re-compress, fast
  const a = document.createElement("a"); a.href = URL.createObjectURL(b); a.download = "fm-developer-images.zip"; a.click();
});
refreshOptions();
