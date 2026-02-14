FROM myoung34/github-runner:latest

# Install additional tools needed for CI pipeline:
# - etherwake: Send WOL magic packets to wake ubuntupve
# - skopeo: Required by backend integration tests (OCI image inspection)
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      etherwake \
      skopeo \
    && rm -rf /var/lib/apt/lists/*

# Install Playwright system dependencies for Chromium only.
# The browser binary itself is installed at runtime by the CI workflow
# via `npx playwright install chromium` (cached between runs).
RUN npx playwright install-deps chromium
