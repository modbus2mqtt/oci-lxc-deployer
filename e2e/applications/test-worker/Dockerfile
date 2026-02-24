FROM node:24-alpine

# Install test dependencies and SSH server
RUN apk add --no-cache \
      bash \
      jq \
      git \
      openssh-server \
      # Playwright Chromium system dependencies
      chromium \
      nss \
      freetype \
      harfbuzz \
      ca-certificates \
      ttf-freefont \
    && corepack enable \
    && corepack prepare pnpm@latest --activate \
    # Generate SSH host keys
    && ssh-keygen -A \
    # Allow root login via public key only
    && sed -i 's/#PermitRootLogin.*/PermitRootLogin prohibit-password/' /etc/ssh/sshd_config \
    && sed -i 's/#PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config \
    && mkdir -p /root/.ssh \
    && chmod 700 /root/.ssh

# Tell Playwright to use system Chromium instead of downloading its own
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium-browser

EXPOSE 22

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]

LABEL \
    org.opencontainers.image.title="oci-lxc-deployer-ci-test-worker" \
    org.opencontainers.image.description="CI test worker with Playwright, pnpm, and SSH for oci-lxc-deployer E2E tests" \
    org.opencontainers.image.vendor="modbus2mqtt" \
    org.opencontainers.image.authors="Volkmar Nissen <volkmar.nissen@gmail.com>" \
    org.opencontainers.image.licenses="MIT" \
    org.opencontainers.image.version="1.0.0" \
    org.opencontainers.image.source="https://github.com/modbus2mqtt/oci-lxc-deployer" \
    org.opencontainers.image.base.name="node:24-alpine"
