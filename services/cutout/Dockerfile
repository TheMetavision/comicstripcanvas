# Debian slim rather than Alpine: onnxruntime-node ships prebuilt glibc
# binaries, and on musl it either falls back to a source build or refuses
# outright. The image is large because the matting model is in it -- which is
# the point, since a model fetched at runtime is a network dependency on the
# critical path and a third party we would have to name in the privacy policy.
FROM node:20-slim

WORKDIR /app

# Dependencies first, so a change to server.mjs does not re-resolve them.
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY server.mjs ./

# Prove at build time that the model files are actually in the image. If the
# package layout ever changes this fails the build rather than failing every
# request at runtime, which is the failure this project has already had once.
RUN node -e "const fs=require('fs'),p='/app/node_modules/@imgly/background-removal-node/dist';\
  const f=fs.readdirSync(p);\
  if(!f.includes('resources.json')) throw new Error('resources.json missing from '+p);\
  const big=f.filter(n=>fs.statSync(p+'/'+n).size>1e6);\
  if(big.length<10) throw new Error('expected the model chunks in '+p+', found '+big.length);\
  console.log('model files present:',big.length,'chunks');"

ENV NODE_ENV=production
ENV CUTOUT_MODEL_PATH=file:///app/node_modules/@imgly/background-removal-node/dist/

# Cloud Run supplies PORT; 8080 is only the local default.
EXPOSE 8080
CMD ["node", "server.mjs"]
