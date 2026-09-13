/* Discord signs every interaction with Ed25519. An endpoint that skips this check will be
   rejected by the Developer Portal outright, and more to the point it would let anyone who
   finds the Worker URL read training data. Uses WebCrypto only, so it runs the same in a
   Worker and in Node (the test suite). */
function hexToBytes(hex) {
  if (typeof hex !== 'string' || hex.length % 2 || /[^0-9a-f]/i.test(hex)) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}
let keyCache = { hex: '', key: null };
export async function verifyDiscordRequest(publicKeyHex, signatureHex, timestamp, body) {
  try {
    const sig = hexToBytes(signatureHex), pub = hexToBytes(publicKeyHex);
    if (!sig || !pub || !timestamp) return false;
    if (keyCache.hex !== publicKeyHex) {
      keyCache = { hex: publicKeyHex, key: await crypto.subtle.importKey('raw', pub, { name: 'Ed25519' }, false, ['verify']) };
    }
    return await crypto.subtle.verify('Ed25519', keyCache.key, sig, new TextEncoder().encode(timestamp + body));
  } catch (e) {
    return false;
  }
}
