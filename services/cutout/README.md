# Cutout service

Background removal for the **standard comic book cover** only. Runs on Fly.io,
not on Netlify, and deliberately lives outside `netlify/` and `src/` so the
Netlify build never sees it.

## Why it is not a Netlify function

`onnxruntime-node` is **49.5 MB zipped on its own**, against a 50 MB budget for
an entire function — before `sharp`, `@google/genai` and the rest. It does not
fit and cannot be made to fit without deleting platform binaries inside
`node_modules` during the build.

The alternative was a hosted remover (remove.bg, Photoroom and the like). That
would be a third party receiving customers' photographs — a new data processor,
a new DPA, and a new paragraph in the privacy policy. This is our own service on
our own infrastructure instead, which is why the policy can say the image
reaches nobody new.

## API

| | |
| --- | --- |
| `GET /healthz` | unauthenticated; `{ ok, modelReady, modelError, node }`. `modelReady` is false until the first cutout finishes, including the warm-up. |
| `POST /cutout` | `Authorization: Bearer $CUTOUT_TOKEN`, body = raw JPEG or PNG bytes, max 12 MB |

`POST /cutout` returns an RGBA PNG at the input's full resolution, plus:

- `X-Cutout-Px` — `WxH` of the result, so the caller need not decode it again
- `X-Alpha-Coverage` — fraction of pixels that survived, `0`–`1`
- `X-Bbox` — `x,y,w,h` of the opaque region
- `X-Cutout-Ms` — model time

The caller is expected to quality-gate on coverage rather than trust the PNG
blindly; `style-photo-background.mjs` refuses anything under 5% or over 90%.

## No sharp in here

The rest of the repo uses sharp everywhere. This service must not: loading sharp
and `@imgly/background-removal-node` into one process **segfaults** during the
model load — reproduced on Windows with both Git Bash and PowerShell, exit 139
and 5 respectively, immediately after `sharp loaded`. `pngjs` is pure
JavaScript, decodes the RGBA the model has just produced, and is all the image
handling this service needs.

## The model is in the image

`CUTOUT_MODEL_PATH` pins `publicPath` to an absolute directory inside the
container. The library's default resolves against `process.cwd()`, so from any
other working directory it would quietly fall back to fetching over the
network. The Dockerfile asserts the model chunks are present at build time, so
a packaging change fails the build rather than every request.

## Deploy

Hosted on **Fly.io**, in London (`lhr`), as app `csc-cutout` —
`https://csc-cutout.fly.dev`. Configuration is in `fly.toml`; Fly builds the
same Dockerfile on its own remote builder, so no local Docker is needed.

```sh
cd services/cutout
fly deploy                     # build remotely and roll out
fly logs --app csc-cutout      # startup, model-warm, one line per cutout
fly machine list --app csc-cutout
```

Machines scale to zero when idle and start on the first request. A cover is cut
out once, minutes apart at best, and the work happens inside a background
function where nobody is watching a spinner — so a cold start is the right thing
to pay for, and an idle machine all day is not.

### Cloud Run: tried, abandoned

The first host was Google Cloud Run in europe-west2. The container built and ran
there, but **the run.app hostnames never routed**: every path on both the
project-number and the alias hostname returned a Google front-end 404 in ~130 ms,
from inside and outside the network and through `gcloud run services proxy`, with
no request ever reaching the container and nothing in its logs. Everything Google
reported said the service was fine — `Ready / CONDITION_SUCCEEDED`, ingress
`INGRESS_TRAFFIC_ALL`, default URL enabled, `allUsers` bound to
`roles/run.invoker`, DNS resolving to Cloud Run front ends. Deleting the service
and redeploying from source changed nothing. Not worth further debugging when the
same container runs elsewhere in minutes.

Two things it taught us, kept because they cost an evening:

- Public access needed an organization-policy exception. The project sits under
  an org whose `constraints/iam.allowedPolicyMemberDomains` forbade `allUsers`
  outright, so `--allow-unauthenticated` failed with `FAILED_PRECONDITION`.
- **Cloud Run reads the `Authorization` header itself** whenever a service
  requires authentication — our own bearer token came back as
  `401 — The access token could not be verified`. Any host that authenticates in
  that header needs the service token moved to one of its own
  (`X-Cutout-Token`). Fly does not, so `Authorization: Bearer` stands.

## The token

Generate and set it — never commit it, and never write it into a file here:

```sh
fly secrets set CUTOUT_TOKEN=$(openssl rand -hex 32) --app csc-cutout
```

Setting a secret restarts the machines, so it takes effect on its own.

The same value goes into Netlify as `CUTOUT_TOKEN`, alongside
`CUTOUT_SERVICE_URL` (`https://csc-cutout.fly.dev`, no trailing slash). Both are
secret.

With either unset the cutout step is skipped rather than failed: no `cutoutError`
is written, nothing is logged, the cover keeps its styled image, and the status
endpoint reports `cutoutEnabled: false` so the builder's Add to basket gate does
not sit waiting for a cutout nobody is going to send.

## Testing it

With the service running (locally: `CUTOUT_TOKEN=... CUTOUT_MODEL_PATH=file:///…/dist/ PORT=8099 node server.mjs`):

```sh
node test.mjs                                          # localhost
CUTOUT_SERVICE_URL=https://… CUTOUT_TOKEN=… node test.mjs   # deployed
```

It posts the two styled covers from `tools/builder/style-out/`, once as PNG and
once re-encoded as the JPEG the pipeline actually sends, and checks the refusals
(bad token, non-image, oversize body). Cutouts are written back to `style-out/`
to be looked at.

## Measured

On Fly, `shared-cpu-2x` with 2 GB, warm:

| input | in | out | coverage | model |
| --- | --- | --- | --- | --- |
| Dilked cover, PNG | 5504×3072, 8.99 MB | 4.30 MB RGBA | 0.5632 | 15,015 ms |
| Dilked cover, JPEG q92 | 5504×3072, 3.17 MB | 4.33 MB RGBA | 0.5630 | 16,523 ms |
| Martin, PNG | 2048×2048, 3.21 MB | 1.47 MB RGBA | 0.6111 | 10,606 ms |

Cold, on a stopped machine: **34.7 s wall** for the 2048×2048 (machine start,
17.6 s model load, then inference), against **11.6 s warm**. Comfortably inside
the 90 s the pipeline allows. Shared vCPUs are roughly 1.7× slower than the same
work on this laptop, which is the price of scaling to zero.

Both cut cleanly — five separate figures on the Dilked cover, hair edges intact
on the portrait. Note the coverage: a person photographed close up legitimately
keeps ~60% of the frame, which is why the gate's ceiling is 0.90 and not lower.

## Retention

The service stores nothing. Images arrive in a request body, are held in memory
and are gone when the response is written; only the log line (byte counts,
dimensions, coverage, timing) survives, and it contains no image data.
