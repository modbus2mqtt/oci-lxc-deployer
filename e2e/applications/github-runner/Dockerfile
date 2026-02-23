FROM ghcr.io/actions/actions-runner:latest

# etherwake for WOL magic packets, isc-dhcp-client for LXC DHCP
RUN sudo apt-get update && \
    sudo apt-get install -y --no-install-recommends etherwake isc-dhcp-client && \
    sudo rm -rf /var/lib/apt/lists/*

COPY pvetest /usr/local/bin/pvetest
RUN sudo chmod +x /usr/local/bin/pvetest

COPY entrypoint.sh /entrypoint.sh
RUN sudo chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
