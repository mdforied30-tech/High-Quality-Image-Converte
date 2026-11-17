// Vector tracing runs here so the main page never freezes.
importScripts("https://cdn.jsdelivr.net/npm/imagetracerjs@1.2.6/imagetracer_v1.2.6.js");
self.onmessage = (e) => {
  const { mode, imgd, options } = e.data;
  try {
    const T = self.ImageTracer;
    if (!T) throw new Error("tracer not available in worker");
    const result = mode === "svg" ? T.imagedataToSVG(imgd, options) : T.imagedataToTracedata(imgd, options);
    self.postMessage({ result });
  } catch (err) {
    self.postMessage({ error: String(err && err.message ? err.message : err) });
  }
};
