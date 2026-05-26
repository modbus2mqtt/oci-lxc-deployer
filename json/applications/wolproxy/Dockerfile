FROM python:3.12-alpine

# iputils-ping is SUID by default on Alpine, so it works for non-root users.
# Magic Packets (UDP /wake) don't need any capability — broadcast sender
# uses an ephemeral source port.
#
# Explicit gid before uid: alpine's `adduser -u 1000` does NOT lock the gid
# to 1000 — it creates a group with auto-assigned gid (typically the next
# free one in the image). When the image is extracted into a proxvex LXC
# the auto-assigned gid lands at 1001 (e.g. python:3.12-alpine already
# uses gid 1000 for the `python` user during pip's intermediate setup).
# `addgroup -g 1000 wolproxy` forces gid 1000, then `adduser -G wolproxy`
# uses that explicit group. Final chown is paranoia for /home/wolproxy
# permissions surviving the OCI-image-to-LXC-rootfs unpack step.
RUN apk add --no-cache iputils \
    && pip install --no-cache-dir flask gunicorn \
    && addgroup -g 1000 wolproxy \
    && adduser -D -u 1000 -G wolproxy wolproxy \
    && chown -R 1000:1000 /home/wolproxy

COPY --chown=wolproxy:wolproxy app.py /app/app.py
WORKDIR /app
EXPOSE 5000

USER wolproxy

CMD ["gunicorn", "-b", "0.0.0.0:5000", "--access-logfile", "-", "app:app"]
