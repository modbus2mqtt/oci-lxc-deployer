FROM python:3.12-alpine

# iputils-ping is SUID by default on Alpine, so it works for non-root users.
# Magic Packets (UDP /wake) don't need any capability — broadcast sender
# uses an ephemeral source port.
RUN apk add --no-cache iputils \
    && pip install --no-cache-dir flask gunicorn \
    && adduser -D -u 1000 wolproxy

COPY --chown=wolproxy:wolproxy app.py /app/app.py
WORKDIR /app
EXPOSE 5000

USER wolproxy

CMD ["gunicorn", "-b", "0.0.0.0:5000", "--access-logfile", "-", "app:app"]
