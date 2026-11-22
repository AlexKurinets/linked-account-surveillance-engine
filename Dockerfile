FROM node:24-trixie-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-venv curl \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Python modelling environment (co-activity, isolation forest, Bayesian refit)
COPY models/requirements.txt models/requirements.txt
RUN python3 -m venv /opt/venv && /opt/venv/bin/pip install --no-cache-dir -r models/requirements.txt
ENV SURV_PYTHON=/opt/venv/bin/python

# TypeScript engine
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json vitest.config.ts ./
COPY src src
RUN npx tsc -p tsconfig.json

COPY config config
COPY db db
COPY models models
COPY test test

CMD ["node", "dist/cli.js"]
