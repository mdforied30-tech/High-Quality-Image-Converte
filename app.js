// High Quality Image Convert - all processing runs in the browser (private, free).
const $ = (s) => document.querySelector(s);
const state = { tool: "jpg2jpeg", files: [], outputs: [], upscaler: {} };

const GROUPS = {
  jpg2jpeg: "convert", png2jpg: "convert", jpg2png: "convert", jpg2webp: "convert", webp2jpg: "convert",
  svg: "vector", eps: "vector", upscale: "upscale",
};
const CONVERT = {
  jpg2jpeg: ["image/jpeg", "jpeg"], png2jpg: ["image/jpeg", "jpg"], webp2jpg: ["image/jpeg", "jpg"],
  jpg2png: ["image/png", "png"], jpg2webp: ["image/webp", "webp"],
};

/* ---------- UI ---------- */
function refreshOptions() {
  const g = GROUPS[state.tool];
  document.querySelectorAll(".row").forEach((r) => {
    r.hidden = !r.dataset.for.split(" ").includes(g);
  });
  const lossless = state.tool === "jpg2png";
  document.querySelectorAll('[data-for="convert"]').forEach((r) => (r.hidden = r.hidden || lossless));
}
$("#tools").addEventListener("click", (e) => {
  const b = e.target.closest(".chip"); if (!b) return;
  document.querySelectorAll(".chip").forEach((c) => c.classList.remove("active"));
  b.classList.add("active"); state.tool = b.dataset.tool; refreshOptions();
});
$("#quality").oninput = (e) => ($("#qv").textContent = e.target.value);
$("#colors").oninput = (e) => ($("#cv").textContent = e.target.value);
$("#detail").onchange = (e) => ($("#dv").textContent = e.target.selectedOptions[0].text.split(" ")[0]);

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
const status = (t) => ($("#status").textContent = t);
const progress = (p) => { $("#barwrap").hidden = p == null; $("#bar").style.width = (p || 0) + "%"; };

/* ---------- Image helpers ---------- */
function loadImage(file) {
  return new Promise((res, rej) => {
    const url = URL.createObjectURL(file); const img = new Image();
    img.onload = () => res({ img, url }); img.onerror = () => rej(new Error("Cannot read " + file.name));
    img.src = url;
  });
}
function makeCanvas(w, h) { const c = document.createElement("canvas"); c.width = w; c.height = h; return c; }
function drawFull(img, flatten) {
  const c = makeCanvas(img.naturalWidth, img.naturalHeight); const x = c.getContext("2d", { willReadFrequently: true });
  if (flatten) { x.fillStyle = "#fff"; x.fillRect(0, 0, c.width, c.height); }
  x.imageSmoothingEnabled = true; x.imageSmoothingQuality = "high"; x.drawImage(img, 0, 0); return c;
}
const toBlob = (c, type, q) => new Promise((r) => c.toBlob(r, type, q));
const baseName = (n) => n.replace(/\.[^.]+$/, "");
const kb = (n) => (n > 1048576 ? (n / 1048576).toFixed(2) + " MB" : Math.round(n / 1024) + " KB");

// Colour enhancement (pure pixel maths, works on every browser)
function enhance(canvas, mode) {
  if (mode === "none") return canvas;
  const P = { natural: [1.08, 1.12, 0], vivid: [1.18, 1.3, 4], rich: [1.12, 1.22, 10] }[mode]; // contrast, saturation, warmth
  const [ct, sat, warm] = P; const x = canvas.getContext("2d", { willReadFrequently: true });
  const d = x.getImageData(0, 0, canvas.width, canvas.height); const a = d.data;
  for (let i = 0; i < a.length; i += 4) {
    let r = a[i], g = a[i + 1], b = a[i + 2];
    const l = 0.299 * r + 0.587 * g + 0.114 * b;
    r = l + (r - l) * sat; g = l + (g - l) * sat; b = l + (b - l) * sat;
    r = (r - 128) * ct + 128 + warm; g = (g - 128) * ct + 128; b = (b - 128) * ct + 128 - warm;
    a[i] = r < 0 ? 0 : r > 255 ? 255 : r; a[i + 1] = g < 0 ? 0 : g > 255 ? 255 : g; a[i + 2] = b < 0 ? 0 : b > 255 ? 255 : b;
  }
  x.putImageData(d, 0, 0); return canvas;
}
// Unsharp mask to bring back crisp edges after resizing
function sharpen(canvas, amount = 0.5) {
  const w = canvas.width, h = canvas.height, x = canvas.getContext("2d", { willReadFrequently: true });
  const src = x.getImageData(0, 0, w, h), out = x.createImageData(w, h), s = src.data, o = out.data;
  const k = [0, -1, 0, -1, 5, -1, 0, -1, 0];
  for (let y = 0; y < h; y++) for (let xx = 0; xx < w; xx++) {
    const i = (y * w + xx) * 4;
    for (let c = 0; c < 3; c++) {
      let v = 0;
      for (let j = -1; j <= 1; j++) for (let m = -1; m <= 1; m++) {
        const yy = Math.min(h - 1, Math.max(0, y + j)), xm = Math.min(w - 1, Math.max(0, xx + m));
        v += s[(yy * w + xm) * 4 + c] * k[(j + 1) * 3 + m + 1];
      }
      o[i + c] = Math.min(255, Math.max(0, s[i + c] + (v - s[i + c]) * amount));
    }
    o[i + 3] = s[i + 3];
  }
  x.putImageData(out, 0, 0); return canvas;
}

/* ---------- Converters ---------- */
async function doConvert(file, { img }) {
  const [mime, ext] = CONVERT[state.tool]; const q = +$("#quality").value / 100;
  let c = drawFull(img, mime === "image/jpeg");
  c = enhance(c, $("#enhance").value);
  const blob = await toBlob(c, mime, mime === "image/png" ? undefined : q);
  return { blob, name: `${baseName(file.name)}.${ext}`, w: c.width, h: c.height };
}

function traceOptions() {
  const detail = $("#detail").value;
  const base = { numberofcolors: +$("#colors").value, colorsampling: 2, colorquantcycles: 4, blurradius: 0, strokewidth: 0, roundcoords: 2, viewbox: true, desc: false };
  const d = { fine: { ltres: 0.3, qtres: 0.3, pathomit: 2 }, balanced: { ltres: 1, qtres: 1, pathomit: 8 }, smooth: { ltres: 2, qtres: 2, pathomit: 20, blurradius: 2, blurdelta: 20 } }[detail];
  return { ...base, ...d };
}
function traceSource(img) {
  const max = 1400, s = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
  const c = makeCanvas(Math.round(img.naturalWidth * s), Math.round(img.naturalHeight * s));
  const x = c.getContext("2d", { willReadFrequently: true }); x.imageSmoothingQuality = "high"; x.drawImage(img, 0, 0, c.width, c.height);
  return x.getImageData(0, 0, c.width, c.height);
}
async function doSVG(file, { img }) {
  const svg = ImageTracer.imagedataToSVG(traceSource(img), traceOptions());
  return { blob: new Blob([svg], { type: "image/svg+xml" }), name: `${baseName(file.name)}.svg`, w: img.naturalWidth, h: img.naturalHeight };
}
function tracedataToEPS(td) {
  const W = td.width, H = td.height, f = (n) => +n.toFixed(2);
  let o = `%!PS-Adobe-3.0 EPSF-3.0\n%%BoundingBox: 0 0 ${W} ${H}\n%%Creator: FM Developer - High Quality Image Convert\n%%EndComments\n`;
  const sub = (p) => {
    const s = p.segments; if (!s.length) return "";
    let t = `${f(s[0].x1)} ${f(H - s[0].y1)} moveto\n`;
    for (const g of s) {
      if (g.type === "L") t += `${f(g.x2)} ${f(H - g.y2)} lineto\n`;
      else { // quadratic -> cubic
        const x0 = g.x1, y0 = g.y1, cx = g.x2, cy = g.y2, x1 = g.x3, y1 = g.y3;
        t += `${f(x0 + (2 / 3) * (cx - x0))} ${f(H - (y0 + (2 / 3) * (cy - y0)))} ${f(x1 + (2 / 3) * (cx - x1))} ${f(H - (y1 + (2 / 3) * (cy - y1)))} ${f(x1)} ${f(H - y1)} curveto\n`;
      }
    }
    return t + "closepath\n";
  };
  td.layers.forEach((layer, k) => {
    const c = td.palette[k]; if (!c || c.a === 0) return;
    o += `${(c.r / 255).toFixed(4)} ${(c.g / 255).toFixed(4)} ${(c.b / 255).toFixed(4)} setrgbcolor\n`;
    layer.forEach((p) => {
      if (p.isholepath) return;
      o += "newpath\n" + sub(p);
      (p.holechildren || []).forEach((hi) => { if (layer[hi]) o += sub(layer[hi]); });
      o += "eofill\n";
    });
  });
  return o + "showpage\n%%EOF\n";
}
async function doEPS(file, { img }) {
  const td = ImageTracer.imagedataToTracedata(traceSource(img), traceOptions());
  const eps = tracedataToEPS(td);
  return { blob: new Blob([eps], { type: "application/postscript" }), name: `${baseName(file.name)}.eps`, w: td.width, h: td.height };
}

/* ---------- Upscale ---------- */
function fastUpscale(img, scale) {
  let cur = drawFull(img, false); const tw = img.naturalWidth * scale, th = img.naturalHeight * scale;
  while (cur.width < tw || cur.height < th) { // stepwise 1.5x keeps edges cleaner than one huge jump
    const nw = Math.min(tw, Math.round(cur.width * 1.5)), nh = Math.min(th, Math.round(cur.height * 1.5));
    const n = makeCanvas(nw, nh), x = n.getContext("2d", { willReadFrequently: true });
    x.imageSmoothingEnabled = true; x.imageSmoothingQuality = "high"; x.drawImage(cur, 0, 0, nw, nh); cur = n;
  }
  return sharpen(cur, 0.55);
}
async function getUpscaler(scale) {
  if (state.upscaler[scale]) return state.upscaler[scale];
  status(`Loading AI model (${scale}x), first time only...`);
  const [{ default: Upscaler }, { default: model }] = await Promise.all([
    import("https://esm.sh/upscaler@1.0.0-beta.19"),
    import(`https://esm.sh/@upscalerjs/esrgan-medium@1.0.0-beta.14/${scale}x`),
  ]);
  return (state.upscaler[scale] = new Upscaler({ model }));
}
async function doUpscale(file, { img }) {
  const scale = +$("#scale").value, fmt = $("#upfmt").value; let c;
  if ($("#method").value === "ai") {
    try {
      // keep AI input moderate so phones do not run out of memory
      const maxIn = 1000, s = Math.min(1, maxIn / Math.max(img.naturalWidth, img.naturalHeight));
      const src = makeCanvas(Math.round(img.naturalWidth * s), Math.round(img.naturalHeight * s));
      src.getContext("2d").drawImage(img, 0, 0, src.width, src.height);
      const up = await getUpscaler(scale > 4 ? 4 : scale);
      status("AI is enhancing detail, please wait...");
      const out = await up.upscale(src, { patchSize: 64, padding: 4, progress: (p) => progress(Math.round(p * 100)) });
      const im = new Image(); im.src = out; await im.decode();
      c = makeCanvas(im.naturalWidth, im.naturalHeight); c.getContext("2d").drawImage(im, 0, 0);
    } catch (e) {
      console.warn(e); status("AI model could not load, using Fast Upscale instead."); c = fastUpscale(img, scale);
    }
  } else c = fastUpscale(img, scale);
  c = enhance(c, $("#enhance").value);
  const mime = { png: "image/png", jpg: "image/jpeg", webp: "image/webp" }[fmt];
  if (fmt === "jpg") { const f = makeCanvas(c.width, c.height), x = f.getContext("2d"); x.fillStyle = "#fff"; x.fillRect(0, 0, f.width, f.height); x.drawImage(c, 0, 0); c = f; }
  const blob = await toBlob(c, mime, 0.98);
  return { blob, name: `${baseName(file.name)}_${scale}x.${fmt}`, w: c.width, h: c.height };
}

/* ---------- Run ---------- */
const RUN = { svg: doSVG, eps: doEPS, upscale: doUpscale };
$("#go").addEventListener("click", async () => {
  const fn = RUN[state.tool] || doConvert;
  $("#go").disabled = true; $("#results").innerHTML = ""; state.outputs = []; $("#zipall").hidden = true;
  for (let i = 0; i < state.files.length; i++) {
    const f = state.files[i]; status(`Working on ${f.name} (${i + 1}/${state.files.length})`); progress(Math.round((i / state.files.length) * 100));
    await new Promise((r) => setTimeout(r, 30));
    try {
      const src = await loadImage(f); const out = await fn(f, src); out.url = URL.createObjectURL(out.blob);
      state.outputs.push(out); addResult(src.url, f, out);
    } catch (e) { console.error(e); $("#results").insertAdjacentHTML("beforeend", `<div class="res err">${f.name}: ${e.message}</div>`); }
  }
  progress(null); status("Done. Your files are ready to download.");
  $("#zipall").hidden = state.outputs.length < 2; $("#go").disabled = false;
});
function addResult(origUrl, f, o) {
  const vec = /svg|eps/.test(o.name.split(".").pop());
  const preview = o.name.endsWith(".eps") ? origUrl : o.url;
  $("#results").insertAdjacentHTML("beforeend", `
  <div class="res"><div class="pair">
    <figure><img src="${origUrl}" alt=""><figcaption>Before</figcaption></figure>
    <figure><img src="${preview}" alt=""><figcaption>After</figcaption></figure></div>
    <div class="meta"><span>${f.name} (${kb(f.size)})</span><span>${o.w}x${o.h} &rarr; ${kb(o.blob.size)}${vec ? " vector" : ""}</span></div>
    <a class="dl" href="${o.url}" download="${o.name}">Download ${o.name}</a></div>`);
}
$("#zipall").addEventListener("click", async () => {
  const z = new JSZip(); state.outputs.forEach((o) => z.file(o.name, o.blob));
  const b = await z.generateAsync({ type: "blob" }); const a = document.createElement("a");
  a.href = URL.createObjectURL(b); a.download = "fm-developer-images.zip"; a.click();
});
refreshOptions();
