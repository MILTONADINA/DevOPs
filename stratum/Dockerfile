# Production image for the Stratum (CQ) proxy.
#
# IMPORTANT: build with the DevOps PARENT directory as the context — the proxy imports
# `@devops/observability/pii-redaction` (= ../observability/pii-redaction.ts) on the capture/redaction
# path, which lives outside stratum/. From the repo root (/Users/milto/Projects/DevOps):
#
#   docker build -f stratum/Dockerfile -t stratum-proxy .
#
# Run (HOST=0.0.0.0 so it is reachable outside the container; ANTHROPIC_API_KEY is required to boot —
# the proxy forwards to Anthropic; commercial mode additionally needs Supabase creds):
#   docker run -p 4080:4080 -e HOST=0.0.0.0 -e ANTHROPIC_API_KEY=sk-ant-… stratum-proxy   # personal
#   docker run -p 4080:4080 -e HOST=0.0.0.0 -e CQ_COMMERCIAL=true \
#     -e SUPABASE_URL=… -e SUPABASE_SERVICE_KEY=… -e ANTHROPIC_API_KEY=… \
#     -e STRIPE_WEBHOOK_SECRET=whsec_… stratum-proxy                            # commercial
#
# The app runs the TypeScript source directly via tsx (the validated runtime; `npm run build` is
# --noEmit, there is no JS dist), so tsx (a devDependency) must be installed.

FROM node:24-slim
ENV NODE_ENV=production
WORKDIR /app/stratum

# Dependencies first (layer-cached unless the manifests change). `--include=dev` is REQUIRED:
# tsx (the runtime) is a devDependency, and NODE_ENV=production would otherwise make `npm ci` omit
# it — forcing a slow, network-dependent tsx download on every container start.
COPY stratum/package.json stratum/package-lock.json ./
RUN npm ci --include=dev

# App source + the single cross-subtree file the capture/redaction path imports (@devops/* → ../*),
# placed at the sibling path the alias resolves to (/app/observability).
COPY stratum/ ./
COPY observability/pii-redaction.ts /app/observability/pii-redaction.ts

# Captures dir must be writable by the non-root runtime user.
RUN mkdir -p data/sessions && chown -R node:node /app
USER node

ENV PORT=4080 HOST=0.0.0.0
EXPOSE 4080

# Liveness: /health is public + unauthenticated even in commercial mode (no key, no DB needed).
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["npx", "tsx", "src/proxy/index.ts"]
