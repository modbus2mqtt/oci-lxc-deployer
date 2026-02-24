FROM ghcr.io/actions/actions-runner:latest

# etherwake for WOL magic packets
RUN sudo apt-get update && \
    sudo apt-get install -y --no-install-recommends etherwake && \
    sudo rm -rf /var/lib/apt/lists/*

COPY pvetest /usr/local/bin/pvetest
RUN sudo chmod +x /usr/local/bin/pvetest

LABEL \
    org.opencontainers.image.title="oci-lxc-deployer-github-runner" \
    org.opencontainers.image.description="GitHub Actions self-hosted runner for oci-lxc-deployer CI/CD with etherwake and pvetest" \
    org.opencontainers.image.vendor="modbus2mqtt" \
    org.opencontainers.image.authors="Volkmar Nissen <volkmar.nissen@gmail.com>" \
    org.opencontainers.image.licenses="MIT" \
    org.opencontainers.image.version="1.0.0" \
    org.opencontainers.image.source="https://github.com/modbus2mqtt/oci-lxc-deployer" \
    org.opencontainers.image.base.name="ghcr.io/actions/actions-runner:latest"
