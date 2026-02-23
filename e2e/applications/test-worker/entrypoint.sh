#!/bin/sh
set -e

# Set up authorized_keys from environment variable (incoming SSH)
if [ -n "$SSH_PUBLIC_KEY" ]; then
    echo "$SSH_PUBLIC_KEY" > /root/.ssh/authorized_keys
    chmod 600 /root/.ssh/authorized_keys
    echo "SSH public key installed"
else
    echo "WARNING: No SSH_PUBLIC_KEY set — SSH login will not work" >&2
fi

# Set up private key from environment variable (outgoing SSH to nested VM)
if [ -n "${SSH_PRIVATE_KEY:-}" ]; then
    echo "$SSH_PRIVATE_KEY" > /root/.ssh/id_ed25519
    chmod 600 /root/.ssh/id_ed25519
    echo "SSH private key installed"
fi

# Start sshd in foreground
exec /usr/sbin/sshd -D -e
