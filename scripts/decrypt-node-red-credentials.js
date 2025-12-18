#!/usr/bin/env node
/**
 * Decrypt Node-RED credentials file and output in plain text
 * 
 * Usage: node decrypt-node-red-credentials.js [node-red-dir]
 * 
 * If node-red-dir is not provided, defaults to ~/.node-red
 * 
 * Outputs JSON with decrypted credentials to stdout
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const nodeRedDir = process.argv[2] || path.join(process.env.HOME, '.node-red');

function getCredentialSecret() {
  // Try settings.js first
  const settingsPath = path.join(nodeRedDir, 'settings.js');
  if (fs.existsSync(settingsPath)) {
    const settings = fs.readFileSync(settingsPath, 'utf-8');
    const match = settings.match(/credentialSecret\s*:\s*["']([^"']+)["']/);
    if (match) {
      return match[1];
    }
  }

  // Try .config.runtime.json
  const runtimeConfigPath = path.join(nodeRedDir, '.config.runtime.json');
  if (fs.existsSync(runtimeConfigPath)) {
    const config = JSON.parse(fs.readFileSync(runtimeConfigPath, 'utf-8'));
    if (config._credentialSecret) {
      return config._credentialSecret;
    }
  }

  return null;
}

function decryptCredentials(encryptedCreds, secret) {
  const decrypted = {};

  for (const [nodeId, nodeCreds] of Object.entries(encryptedCreds)) {
    if (nodeId === '$') {
      // This is the encrypted blob format (Node-RED 1.x+)
      try {
        const decryptedBlob = decryptBlob(nodeCreds, secret);
        return JSON.parse(decryptedBlob);
      } catch (e) {
        console.error('Failed to decrypt credential blob:', e.message);
        return null;
      }
    }
    
    // Legacy format: per-node encryption
    decrypted[nodeId] = {};
    for (const [key, value] of Object.entries(nodeCreds)) {
      if (typeof value === 'string' && value.startsWith('$')) {
        try {
          decrypted[nodeId][key] = decryptValue(value, secret);
        } catch (e) {
          decrypted[nodeId][key] = '[DECRYPTION_FAILED]';
        }
      } else {
        decrypted[nodeId][key] = value;
      }
    }
  }

  return decrypted;
}

function decryptBlob(data, secret) {
  const encryptionAlgorithm = 'aes-256-ctr';
  const key = crypto.createHash('sha256').update(secret).digest();
  
  const parts = data.split('$');
  const initVector = Buffer.from(parts[1], 'base64');
  const encryptedData = Buffer.from(parts[2], 'base64');
  
  const decipher = crypto.createDecipheriv(encryptionAlgorithm, key, initVector);
  let decrypted = decipher.update(encryptedData, undefined, 'utf8');
  decrypted += decipher.final('utf8');
  
  return decrypted;
}

function decryptValue(value, secret) {
  // Legacy per-value encryption
  const encryptionAlgorithm = 'aes-256-ctr';
  const key = crypto.createHash('sha256').update(secret).digest();
  
  const parts = value.split('$');
  if (parts.length !== 3) {
    return value; // Not encrypted
  }
  
  const initVector = Buffer.from(parts[1], 'base64');
  const encryptedData = Buffer.from(parts[2], 'base64');
  
  const decipher = crypto.createDecipheriv(encryptionAlgorithm, key, initVector);
  let decrypted = decipher.update(encryptedData, undefined, 'utf8');
  decrypted += decipher.final('utf8');
  
  return decrypted;
}

// Main
const credFilePath = path.join(nodeRedDir, 'flows_cred.json');

if (!fs.existsSync(credFilePath)) {
  console.error('Error: flows_cred.json not found at', credFilePath);
  process.exit(1);
}

const secret = getCredentialSecret();
if (!secret) {
  console.error('Error: Could not find credentialSecret in settings.js or .config.runtime.json');
  process.exit(1);
}

console.error('Using Node-RED directory:', nodeRedDir);
console.error('Found credential secret');

const encryptedCreds = JSON.parse(fs.readFileSync(credFilePath, 'utf-8'));
const decryptedCreds = decryptCredentials(encryptedCreds, secret);

if (decryptedCreds) {
  console.log(JSON.stringify(decryptedCreds, null, 2));
} else {
  console.error('Error: Failed to decrypt credentials');
  process.exit(1);
}



