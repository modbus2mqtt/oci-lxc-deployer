FROM ghcr.io/actions/actions-runner:latest

# etherwake for WOL magic packets
RUN sudo apt-get update && \
    sudo apt-get install -y --no-install-recommends etherwake && \
    sudo rm -rf /var/lib/apt/lists/*

COPY pvetest /usr/local/bin/pvetest
RUN sudo chmod +x /usr/local/bin/pvetest
