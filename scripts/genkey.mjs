import * as secp from "@noble/secp256k1";
import { sha256 } from "@noble/hashes/sha256";
import { ripemd160 } from "@noble/hashes/ripemd160";
import { base58check } from "@scure/base";
import { generateMnemonic, mnemonicToSeedSync } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";

const b58c = base58check(sha256);
const toHex = b => Array.from(b).map(x=>x.toString(16).padStart(2,"0")).join("");
const fromHex = h => { const o=new Uint8Array(h.length/2); for(let i=0;i<o.length;i++) o[i]=parseInt(h.substr(i*2,2),16); return o; };

const mnemonic = generateMnemonic(wordlist, 128);
const seed = mnemonicToSeedSync(mnemonic);
let priv = seed.slice(0,32);
if (!secp.utils.isValidPrivateKey(priv)) priv = sha256(seed);
const privateKey = toHex(priv);
const pub = secp.getPublicKey(fromHex(privateKey), true);
const publicKey = toHex(pub);
const h160 = ripemd160(sha256(pub));
const payload = new Uint8Array(21);
payload[0] = 0x00;
payload.set(h160, 1);
const address = b58c.encode(payload);

console.log(JSON.stringify({ mnemonic, privateKey, publicKey, address }, null, 2));
