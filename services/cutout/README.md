# Cutout service

Background removal for the **standard comic book cover** only. Runs on Google
Cloud Run, not on Netlify, and deliberately lives outside `netlify/` and `src/`
so the Netlify build never sees it.

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
| `GET /healthz` | unauthenticated; `{ ok, modelReady, modelError, node }` |
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

```sh
gcloud run deploy cutout \
  --source . \
  --project gen-lang-client-0145364883 \
  --region europe-west2 \
  --memory 2Gi \
  --cpu 2 \
  --concurrency 2 \
  --timeout 120 \
  --min-instances 0 \
  --max-instances 3 \
  --ingress all \
  --allow-unauthenticated
```

### Deployed

`https://cutout-634842895189.europe-west2.run.app` (alias
`https://cutout-cdyki42vka-nw.a.run.app`), revision `cutout-00001-7d4`, deployed
2026-09-09. The container starts clean — the build passed the model assertion
below, and the first log line is
`{"event":"listening","port":"8080","modelPath":"file:///app/node_modules/…/dist/"}`.

**Public access needed an organization-policy exception.** The project sits under
org `901013979338`, whose `constraints/iam.allowedPolicyMemberDomains` allows
only customer `C038wqnn6`, so `--allow-unauthenticated` failed during the deploy
with `FAILED_PRECONDITION: One or more users named in the policy do not belong to
a permitted customer`. A project-scoped override (`allValues: ALLOW`) lets the
`allUsers` / `roles/run.invoker` binding be written; it is stored and visible in
`gcloud run services get-iam-policy cutout`.

At the time of writing the service still answers 404 to unauthenticated callers
despite that binding, and those requests leave no entry in the Cloud Run logs —
they are refused at the edge before reaching the container. The one request that
did reach it carried our own bearer token while auth was still required and was
logged as `401 — The access token could not be verified`: Cloud Run reads the
`Authorization` header itself whenever a service requires authentication. **If
this service ever has to stay private, the service token must move out of
`Authorization` into its own header** (`X-Cutout-Token`) in both `server.mjs` and
`makeCutout`, or Cloud Run will eat it before the container sees it.

`--allow-unauthenticated` with `--ingress all` is deliberate: Netlify functions
have no fixed egress address to allow-list, so IAM cannot express "only our
site". The bearer token is the access control, and the service does nothing but
return a cut-out version of whatever it is given.

APIs needed once per project:

```sh
gcloud services enable run.googleapis.com artifactregistry.googleapis.com cloudbuild.googleapis.com \n  --project gen-lang-client-0145364883
```

## The token

Generate and set it — never commit it, and never write it into a file here:

```sh
gcloud run services update cutout --region europe-west2 \
  --set-env-vars "CUTOUT_TOKEN=$(openssl rand -hex 32)"
```

The same value goes into Netlify as `CUTOUT_TOKEN`, alongside
`CUTOUT_SERVICE_URL` (the service URL, no trailing slash). Both are secret.

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

Local, Node 24 on Windows, model already warm — Cloud Run figures will differ,
and the first request after a cold start also pays the model load:

| input | in | out | coverage | model |
| --- | --- | --- | --- | --- |
| Dilked cover, PNG | 5504×3072, 8.99 MB | 4.32 MB RGBA | 0.5636 | 9,271 ms |
| Dilked cover, JPEG q92 | 5504×3072, 3.17 MB | 4.45 MB RGBA | 0.5639 | 8,342 ms |
| Martin, PNG | 2048×2048, 3.21 MB | 1.47 MB RGBA | 0.6114 | 6,293 ms |

Both cut cleanly — five separate figures on the Dilked cover, hair edges intact
on the portrait. Note the coverage: a person photographed close up legitimately
keeps ~60% of the frame, which is why the gate's ceiling is 0.90 and not lower.

## Retention

The service stores nothing. Images arrive in a request body, are held in memory
and are gone when the response is written; only the log line (byte counts,
dimensions, coverage, timing) survives, and it contains no image data.
