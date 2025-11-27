#!/bin/sh

# Outputs properties for the backup user and mountpoint in JSON format (for use with outputs.schema.json)

cat <<EOF
[
  { "name": "username", "value": "backup", "default": "backup" },
  { "name": "mountpoint", "value": "backup" },
  { "name": "uid", "value": 2001 },
  { "name": "gid", "value": 2001 }
]
EOF
