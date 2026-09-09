import http from 'node:http';
import crypto from 'node:crypto';
import path from 'node:path';
import { PNG } from 'pngjs';
import { removeBackground } from '@imgly/background-removal-node';

/**
 * Background removal for comic book covers.
 *
 * This is a service rather than a Netlify function because it cannot be one:
 * onnxruntime-node is 49.5 MB zipped on its own, against a 50 MB budget for an
 * entire function. It is ours, on our own infrastructure, so the customer's
 * photograph reaches no new third party -- which is the whole reason for not
 * using a hosted remover instead.
 *
 * The matting model itself lives in the image. MODEL_PATH pins it to an
 * absolute directory rather than relying on the library's default, which
 * resolves against process.cwd() and would silently try the network from any
 * other working directory. Nothing is downloaded at runtime.
 *
 * Auth is a bearer token and nothing else: ingress is open because Netlify
 * functions have no fixed egress address to allow-list.
 *
 * Deliberately NO sharp here, although the rest of this repo uses it happily.
 * Loading sharp and this library into one process segfaults during the model
 * load -- reproduced on Windows, and not a gamble worth taking inside a
 * container we cannot attach a debugger to. pngjs is pure JavaScript, decodes
 * the RGBA the model just produced, and is the only image work this service
 * does.
 */

const PORT = process.env.PORT || 8080;
const TOKEN = process.env.CUTOUT_TOKEN || '';
const MAX_BYTES = 12 * 1024 * 1024;
const MODEL_PATH = process.env.CUTOUT_MODEL_PATH
  || `file://${path.resolve('/app/node_modules/@imgly/background-removal-node/dist')}/`;

const CONFIG = { publicPath: MODEL_PATH, output: { format: 'image/png' } };

let modelReady = false;
let modelError = null;

const send = (res, status, body, headers = {}) => {
  res.writeHead(status, { 'Cache-Control': 'no-store', ...headers });
  res.end(body);
};
const json = (res, status, obj) =>
  send(res, status, JSON.stringify(obj), { 'Content-Type': 'application/json' });

/** JPEG and PNG only, sniffed from the bytes rather than trusted from a header. */
function sniff(buf) {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  return null;
}

/** Alpha coverage and the bounding box of everything that survived, in one pass. */
function describeAlpha(png) {
  const { data, width, height } = PNG.sync.read(png);   // always RGBA out of the model
  let opaque = 0, minX = width, minY = height, maxX = -1, maxY = -1;
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      if (data[(row + x) * 4 + 3] < 16) continue;   // ~6% alpha: below this is background
      opaque++;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  const coverage = opaque / (width * height);
  const bbox = maxX < 0 ? [0, 0, 0, 0] : [minX, minY, maxX - minX + 1, maxY - minY + 1];
  return { width, height, coverage, bbox };
}

/** A flat grey 64x64 PNG, purely to make the model load something once. */
function seedPng() {
  const img = new PNG({ width: 64, height: 64 });
  img.data.fill(0x80);
  for (let i = 3; i < img.data.length; i += 4) img.data[i] = 0xff;
  return PNG.sync.write(img);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (c) => {
      total += c.length;
      if (total > MAX_BYTES) {
        reject(Object.assign(new Error(`Body exceeds ${MAX_BYTES} bytes`), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function cutout(buffer) {
  const started = Date.now();
  const blob = new Blob([buffer], { type: sniff(buffer) || 'image/png' });
  const out = await removeBackground(blob, CONFIG);
  const png = Buffer.from(await out.arrayBuffer());
  modelReady = true;
  return { png, ms: Date.now() - started };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (req.method === 'GET' && url.pathname === '/healthz') {
    return json(res, 200, { ok: true, modelReady, modelError, node: process.version });
  }

  if (url.pathname !== '/cutout') return json(res, 404, { error: 'Not found' });
  if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });

  /* Constant-time-ish compare. The token is the only thing between an open
     ingress and our compute budget, so a wrong one is told nothing useful. */
  const auth = req.headers.authorization || '';
  const given = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!TOKEN || given.length !== TOKEN.length
      || !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(TOKEN))) {
    return json(res, 401, { error: 'Unauthorized' });
  }

  let buffer;
  try {
    buffer = await readBody(req);
  } catch (err) {
    return json(res, err.status || 400, { error: err.message });
  }
  if (!buffer.length) return json(res, 400, { error: 'Empty body' });
  const type = sniff(buffer);
  if (!type) return json(res, 415, { error: 'Body must be JPEG or PNG' });

  try {
    const { png, ms } = await cutout(buffer);
    const info = describeAlpha(png);
    console.log(JSON.stringify({
      at: new Date().toISOString(), event: 'cutout',
      inBytes: buffer.length, outBytes: png.length,
      px: `${info.width}x${info.height}`,
      coverage: +info.coverage.toFixed(4), bbox: info.bbox, ms,
    }));
    return send(res, 200, png, {
      'Content-Type': 'image/png',
      'Content-Length': String(png.length),
      'X-Cutout-Px': `${info.width}x${info.height}`,
      'X-Alpha-Coverage': info.coverage.toFixed(4),
      'X-Bbox': info.bbox.join(','),
      'X-Cutout-Ms': String(ms),
    });
  } catch (err) {
    modelError = err.message;
    console.error(JSON.stringify({ at: new Date().toISOString(), event: 'cutout-failed', error: err.message }));
    return json(res, 500, { error: 'Cutout failed', detail: err.message });
  }
});

server.listen(PORT, () => {
  console.log(JSON.stringify({ event: 'listening', port: PORT, modelPath: MODEL_PATH }));
  /* Warm the model AFTER the port is open. Cloud Run's startup probe only
     waits for the listener, so warming here keeps the first real request fast
     without making the container look slow to start. A failure is logged and
     left to the first request to surface properly. */
  cutout(seedPng())
    .then(({ ms }) => console.log(JSON.stringify({ event: 'model-warm', ms })))
    .catch((e) => {
      modelError = e.message;
      console.error(JSON.stringify({ event: 'model-warm-failed', error: e.message }));
    });
});
