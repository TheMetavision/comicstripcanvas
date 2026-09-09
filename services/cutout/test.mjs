import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

/**
 * Exercise a running cutout service -- local or deployed.
 *
 *   node test.mjs                                  # http://127.0.0.1:8099
 *   CUTOUT_SERVICE_URL=https://... CUTOUT_TOKEN=... node test.mjs
 *
 * Writes each cutout next to its source in tools/builder/style-out/ so the
 * result can be looked at, not just measured. sharp is borrowed from the repo
 * root purely to make the JPEG case -- the service itself has no sharp, and
 * must not: loading it alongside the matting model segfaults the process.
 */

const BASE = (process.env.CUTOUT_SERVICE_URL || 'http://127.0.0.1:8099').replace(/\/+$/, '');
const TOKEN = process.env.CUTOUT_TOKEN || 'localtesttoken';
const OUT = path.resolve('../../tools/builder/style-out');

const post = (body, type, token = TOKEN) => fetch(`${BASE}/cutout`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': type },
  body,
});

async function run(tag, body, type) {
  const t = Date.now();
  const res = await post(body, type);
  const wall = Date.now() - t;
  if (!res.ok) return console.log(`${tag}: HTTP ${res.status} ${(await res.text()).slice(0, 120)}`);
  const png = Buffer.from(await res.arrayBuffer());
  const dest = path.join(OUT, `service-cutout-${tag}.png`);
  fs.writeFileSync(dest, png);
  console.log(
    `${tag}: in ${body.length}B ${type} -> out ${png.length}B ${res.headers.get('x-cutout-px')}` +
    `, coverage ${res.headers.get('x-alpha-coverage')}, bbox ${res.headers.get('x-bbox')}` +
    `, model ${res.headers.get('x-cutout-ms')}ms, wall ${wall}ms`
  );
}

const health = await fetch(`${BASE}/healthz`);
console.log(`healthz ${health.status} ${await health.text()}`);

const png4k = fs.readFileSync(path.join(OUT, 'Dilked-Cover-Photo-gemini-3-pro-image-preview-4K.png'));
const png2k = fs.readFileSync(path.join(OUT, 'Martin-Sutcliffe-gemini-3-pro-image-preview-2K.png'));
await run('Dilked-4K', png4k, 'image/png');
await run('Martin-2K', png2k, 'image/png');

// The pipeline posts the styled JPEG, so that is the shape that actually matters.
const sharp = createRequire(path.resolve('../../package.json'))('sharp');
await run('Dilked-4K-fromjpeg', await sharp(png4k).jpeg({ quality: 92 }).toBuffer(), 'image/jpeg');

console.log(`bad token -> ${(await post(Buffer.from([0xff, 0xd8, 0xff]), 'image/jpeg', 'wrong')).status}`);
const notImg = await post(Buffer.from('hello world'), 'image/png');
console.log(`not an image -> ${notImg.status} ${(await notImg.text()).slice(0, 60)}`);
const big = await post(Buffer.alloc(13 * 1024 * 1024, 1), 'image/png')
  .then((r) => r.status).catch((e) => `refused mid-upload (${e.message})`);
console.log(`13 MB body -> ${big}`);
