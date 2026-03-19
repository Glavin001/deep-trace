FROM node:22-slim

# Install system deps for git, Playwright, and general tooling
RUN apt-get update && \
    apt-get install -y git curl lsof procps && \
    rm -rf /var/lib/apt/lists/*

# Install Playwright browsers
RUN npx playwright install --with-deps chromium

WORKDIR /deep-trace

# Copy the deep-trace source and build it
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# Run the e2e tests
ENTRYPOINT ["bash", "tests/e2e-realworld/lib/run-all.sh"]
