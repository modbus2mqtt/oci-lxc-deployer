#!/bin/sh
# Import a Node-RED flow from a URL or file path
# Runs inside the node-red container
# Inputs (templated):
#   {{ flow_source }}     - URL or path to the flow JSON
#   {{ flow_username }}   - Optional username for credential nodes
#   {{ flow_password }}   - Optional password for credential nodes

FLOW_SOURCE="{{ flow_source }}"
FLOW_USERNAME="{{ flow_username }}"
FLOW_PASSWORD="{{ flow_password }}"
NODERED_USER="nodered"
NODERED_DIR="/home/$NODERED_USER/.node-red"
FLOWS_FILE="$NODERED_DIR/flows.json"
CREDS_FILE="$NODERED_DIR/flows_cred.json"

if [ -z "$FLOW_SOURCE" ]; then
  echo "Error: flow_source is required" >&2
  exit 1
fi

# Ensure .node-red directory exists
if [ ! -d "$NODERED_DIR" ]; then
  echo "Error: Node-RED directory not found at $NODERED_DIR" >&2
  exit 1
fi

# Download or copy the flow file
TEMP_FLOW="/tmp/imported_flow.json"

if echo "$FLOW_SOURCE" | grep -qE '^https?://'; then
  echo "Downloading flow from $FLOW_SOURCE..." >&2
  if ! wget -q -O "$TEMP_FLOW" "$FLOW_SOURCE"; then
    echo "Error: Failed to download flow from $FLOW_SOURCE" >&2
    exit 1
  fi
else
  if [ ! -f "$FLOW_SOURCE" ]; then
    echo "Error: Flow file not found at $FLOW_SOURCE" >&2
    exit 1
  fi
  cp "$FLOW_SOURCE" "$TEMP_FLOW"
fi

# Validate JSON
if ! cat "$TEMP_FLOW" | head -c 1 | grep -q '\['; then
  echo "Error: Invalid flow JSON (must be an array)" >&2
  rm -f "$TEMP_FLOW"
  exit 1
fi

# Backup existing flows if present
if [ -f "$FLOWS_FILE" ]; then
  BACKUP="$FLOWS_FILE.backup.$(date +%Y%m%d%H%M%S)"
  cp "$FLOWS_FILE" "$BACKUP"
  echo "Backed up existing flows to $BACKUP" >&2
fi

# Copy flow to Node-RED directory
cp "$TEMP_FLOW" "$FLOWS_FILE"
chown "$NODERED_USER:$NODERED_USER" "$FLOWS_FILE"
chmod 644 "$FLOWS_FILE"

# If username/password provided, update credentials using Node.js
if [ -n "$FLOW_USERNAME" ] || [ -n "$FLOW_PASSWORD" ]; then
  echo "Updating credentials..." >&2
  
  node << 'NODEJS_SCRIPT'
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const nodeRedDir = process.env.NODERED_DIR || '/home/nodered/.node-red';
const flowsFile = path.join(nodeRedDir, 'flows.json');
const credsFile = path.join(nodeRedDir, 'flows_cred.json');
const settingsFile = path.join(nodeRedDir, 'settings.js');
const runtimeConfigFile = path.join(nodeRedDir, '.config.runtime.json');

const username = process.env.FLOW_USERNAME || '';
const password = process.env.FLOW_PASSWORD || '';

// Get or create credential secret
function getCredentialSecret() {
  // Try settings.js first
  if (fs.existsSync(settingsFile)) {
    const settings = fs.readFileSync(settingsFile, 'utf-8');
    const match = settings.match(/credentialSecret\s*:\s*["']([^"']+)["']/);
    if (match) return match[1];
  }
  
  // Try .config.runtime.json
  if (fs.existsSync(runtimeConfigFile)) {
    try {
      const config = JSON.parse(fs.readFileSync(runtimeConfigFile, 'utf-8'));
      if (config._credentialSecret) return config._credentialSecret;
    } catch (e) {}
  }
  
  // Generate new secret
  const newSecret = crypto.randomBytes(32).toString('hex');
  console.error('Generated new credential secret');
  
  // Save to runtime config
  let config = {};
  if (fs.existsSync(runtimeConfigFile)) {
    try { config = JSON.parse(fs.readFileSync(runtimeConfigFile, 'utf-8')); } catch (e) {}
  }
  config._credentialSecret = newSecret;
  fs.writeFileSync(runtimeConfigFile, JSON.stringify(config, null, 2));
  
  return newSecret;
}

// Encrypt credentials blob
function encryptCredentials(creds, secret) {
  const encryptionAlgorithm = 'aes-256-ctr';
  const key = crypto.createHash('sha256').update(secret).digest();
  const initVector = crypto.randomBytes(16);
  
  const cipher = crypto.createCipheriv(encryptionAlgorithm, key, initVector);
  let encrypted = cipher.update(JSON.stringify(creds), 'utf8', 'base64');
  encrypted += cipher.final('base64');
  
  return { '$': '$' + initVector.toString('base64') + '$' + encrypted };
}

// Decrypt credentials blob
function decryptCredentials(encryptedCreds, secret) {
  if (!encryptedCreds || !encryptedCreds['$']) return {};
  
  const encryptionAlgorithm = 'aes-256-ctr';
  const key = crypto.createHash('sha256').update(secret).digest();
  
  const data = encryptedCreds['$'];
  const parts = data.split('$');
  if (parts.length !== 3) return {};
  
  try {
    const initVector = Buffer.from(parts[1], 'base64');
    const encryptedData = Buffer.from(parts[2], 'base64');
    
    const decipher = crypto.createDecipheriv(encryptionAlgorithm, key, initVector);
    let decrypted = decipher.update(encryptedData, undefined, 'utf8');
    decrypted += decipher.final('utf8');
    
    return JSON.parse(decrypted);
  } catch (e) {
    console.error('Failed to decrypt credentials:', e.message);
    return {};
  }
}

// Find nodes with credentials in flow
function findCredentialNodes(flows) {
  const nodes = [];
  for (const node of flows) {
    if (node.credentials !== undefined || 
        ['mysql', 'postgresql', 'mongodb', 'influxdb', 'http request', 'mqtt-broker', 'sqlitedb'].includes(node.type)) {
      nodes.push(node);
    }
  }
  return nodes;
}

// Main
try {
  if (!fs.existsSync(flowsFile)) {
    console.error('Error: flows.json not found');
    process.exit(1);
  }
  
  const flows = JSON.parse(fs.readFileSync(flowsFile, 'utf-8'));
  const credentialNodes = findCredentialNodes(flows);
  
  if (credentialNodes.length === 0) {
    console.error('No credential nodes found in flow');
    process.exit(0);
  }
  
  console.error('Found ' + credentialNodes.length + ' node(s) with credentials');
  
  const secret = getCredentialSecret();
  
  // Load existing credentials
  let existingCreds = {};
  if (fs.existsSync(credsFile)) {
    try {
      const encrypted = JSON.parse(fs.readFileSync(credsFile, 'utf-8'));
      existingCreds = decryptCredentials(encrypted, secret);
    } catch (e) {
      console.error('Could not read existing credentials, starting fresh');
    }
  }
  
  // Update credentials for each node
  for (const node of credentialNodes) {
    if (!existingCreds[node.id]) {
      existingCreds[node.id] = {};
    }
    
    // Set username/password if provided and not already set
    if (username && !existingCreds[node.id].user) {
      existingCreds[node.id].user = username;
      console.error('Set username for node ' + node.id + ' (' + (node.name || node.type) + ')');
    }
    if (password && !existingCreds[node.id].password) {
      existingCreds[node.id].password = password;
      console.error('Set password for node ' + node.id + ' (' + (node.name || node.type) + ')');
    }
  }
  
  // Encrypt and save
  const encrypted = encryptCredentials(existingCreds, secret);
  fs.writeFileSync(credsFile, JSON.stringify(encrypted, null, 2));
  fs.chownSync(credsFile, parseInt(process.env.NODERED_UID || 1000), parseInt(process.env.NODERED_GID || 1000));
  fs.chmodSync(credsFile, 0o600);
  
  console.error('Credentials updated successfully');
  
} catch (e) {
  console.error('Error:', e.message);
  process.exit(1);
}
NODEJS_SCRIPT

fi

rm -f "$TEMP_FLOW"

# Restart Node-RED to load the new flow
echo "Restarting Node-RED service..." >&2
rc-service node-red restart >&2 || true

echo "Flow imported successfully" >&2
echo "[]"

exit 0
