// scripts/update-gh-secret.mjs
// Usage: node scripts/update-gh-secret.mjs STRAVA_REFRESH_TOKEN
// Requires env: GITHUB_REPOSITORY (owner/repo), GITHUB_TOKEN

import fs from 'node:fs/promises';

const [, , secretName] = process.argv;
if (!secretName) {
  console.error('Usage: node scripts/update-gh-secret.mjs STRAVA_REFRESH_TOKEN');
  process.exit(1);
}

const repo = process.env.GITHUB_REPOSITORY; // "owner/repo"
const token = process.env.GITHUB_TOKEN;
if (!repo || !token) {
  console.error('Missing GITHUB_REPOSITORY or GITHUB_TOKEN');
  process.exit(1);
}

// Read rotated token
let newValue;
try {
  newValue = (await fs.readFile('.data/rotated_refresh_token.txt', 'utf8')).trim();
} catch {
  console.log('No rotated refresh token file found; skipping secret update.');
  process.exit(0);
}

// Get public key for secrets
const pub = await fetch(`https://api.github.com/repos/${repo}/actions/secrets/public-key`, {
  headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'gh-script' }
});
if (!pub.ok) {
  console.error('Failed to get public key:', await pub.text());
  process.exit(1);
}
const { key_id, key } = await pub.json();

// Encrypt with libsodium sealed box (tweetsodium)
import sodium from 'tweetsodium';
const messageBytes = Buffer.from(newValue);
const keyBytes = Buffer.from(key, 'base64');
const encryptedBytes = sodium.seal(messageBytes, keyBytes);
const encrypted_value = Buffer.from(encryptedBytes).toString('base64');

// PUT the secret
const put = await fetch(`https://api.github.com/repos/${repo}/actions/secrets/${secretName}`, {
  method: 'PUT',
  headers: {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    'User-Agent': 'gh-script'
  },
  body: JSON.stringify({ encrypted_value, key_id })
});
if (!put.ok) {
  console.error('Failed to update secret:', await put.text());
  process.exit(1);
}
console.log(`Updated ${secretName} in repo secrets.`);
