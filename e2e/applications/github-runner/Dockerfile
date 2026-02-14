FROM myoung34/github-runner:latest

# Install additional tools and Playwright Chromium system dependencies.
# - etherwake: Send WOL magic packets to wake ubuntupve
# - skopeo: Required by backend integration tests (OCI image inspection)
# - Remaining packages: System libraries required by Chromium (Playwright).
#   The browser binary itself is installed at runtime via `npx playwright install chromium`.
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      etherwake \
      skopeo \
      fonts-liberation \
      libasound2t64 \
      libatk-bridge2.0-0 \
      libatk1.0-0 \
      libatspi2.0-0 \
      libcairo2 \
      libcups2 \
      libdbus-1-3 \
      libdrm2 \
      libgbm1 \
      libglib2.0-0 \
      libnspr4 \
      libnss3 \
      libpango-1.0-0 \
      libx11-6 \
      libxcb1 \
      libxcomposite1 \
      libxdamage1 \
      libxext6 \
      libxfixes3 \
      libxkbcommon0 \
      libxrandr2 \
      libxshmfence1 \
    && rm -rf /var/lib/apt/lists/*
