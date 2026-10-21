// Only authenticated ciphertext may leave the ephemeral runner. No dependencies.
import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import { pipeline } from 'node:stream/promises';

try {
  const secret = process.env.CM_CACHE_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY;
  const origin = process.env.CM_CACHE_ORIGIN || process.env.SUPABASE_URL;
  const user = process.env.CM_CACHE_USER || process.env.SUPABASE_USER_ID;
  if (!secret || !origin || !user) throw new Error('Missing cache scope');
  const key = Buffer.from(hkdfSync('sha256', secret, 'cm-input-cache-v1', `${origin}\n${user}`, 32));
  const [mode, digest, size] = process.argv.slice(2);
  if (mode === 'key') {
    process.stdout.write(createHmac('sha256', key).update('cache-namespace-v1').digest('hex'));
  } else {
    if (!/^[a-f0-9]{64}$/.test(digest) || !/^\d+$/.test(size)) throw new Error('Invalid cache identity');
    const aad = Buffer.from(`cm-input-cache-v1:${digest}:${size}`);
    if (mode === 'seal') {
      const nonce = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, nonce);
      cipher.setAAD(aad);
      process.stdout.write(nonce);
      await pipeline(process.stdin, cipher, process.stdout, { end: false });
      process.stdout.write(cipher.getAuthTag());
    } else if (mode === 'open') {
      const length = fs.fstatSync(0).size;
      if (length !== Number(size) + 28) throw new Error('Invalid envelope size');
      const nonce = Buffer.alloc(12), tag = Buffer.alloc(16);
      fs.readSync(0, nonce, 0, 12, 0);
      fs.readSync(0, tag, 0, 16, length - 16);
      const cipher = createDecipheriv('aes-256-gcm', key, nonce);
      cipher.setAAD(aad);
      cipher.setAuthTag(tag);
      if (Number(size) === 0) {
        cipher.final();
      } else {
        await pipeline(fs.createReadStream(null, { fd: 0, start: 12, end: length - 17, autoClose: false }), cipher, process.stdout);
      }
    } else throw new Error('Invalid mode');
  }
} catch {
  // Never print crypto exceptions, private paths, environment, or credentials.
  process.exitCode = 2;
}
