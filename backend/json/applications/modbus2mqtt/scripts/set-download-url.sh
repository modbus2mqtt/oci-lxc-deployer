#!/bin/sh
owner="modbus2mqtt"
repo="modbus2mqtt"
packagerurl=$(curl -sL https://api.github.com/repos/$owner/$repo/releases/latest | \
  awk '
    /"name":/ && /x86_64\.apk"/ { found=1 }
    found && /"browser_download_url":/ {
      gsub(/.*: *"/, "", $0)
      gsub(/",?$/, "", $0)
      print $0
      exit
    }
  ')
packagerpubkeyurl="https://github.com/$owner/$repo/releases/latest/download/packager.rsa.pub"
echo '[{ "name": "packageurl", "value": "'$packagerurl'" }, { "name": "packagerpubkeyurl", "value": "'$packagerpubkeyurl'" }]'