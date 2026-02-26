#!/bin/sh
set -e

# Set up authorized_keys for node user (incoming SSH)
if [ -n "$SSH_PUBLIC_KEY" ]; then
    echo "$SSH_PUBLIC_KEY" > /home/node/.ssh/authorized_keys
    chmod 600 /home/node/.ssh/authorized_keys
    chown node:node /home/node/.ssh/authorized_keys
    echo "SSH public key installed for node user"
else
    echo "WARNING: No SSH_PUBLIC_KEY set — SSH login will not work" >&2
fi

# Set up private key for node user (outgoing SSH to PVE host / nested VM)
if [ -n "${SSH_PRIVATE_KEY:-}" ]; then
    echo "$SSH_PRIVATE_KEY" > /home/node/.ssh/id_rsa
    chmod 600 /home/node/.ssh/id_rsa
    chown node:node /home/node/.ssh/id_rsa
    echo "SSH private key installed for node user"
fi

# Start sshd in foreground (runs as root, login as node)
exec /usr/sbin/sshd -D -e
