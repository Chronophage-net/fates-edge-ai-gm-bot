'use strict';
const { createHash, randomBytes } = require('node:crypto');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[157][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const format = b => { const h=b.toString('hex'); return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`; };
function legacyRoomId(code) {
 if (UUID.test(code)) return code.toLowerCase();
 const namespace=Buffer.from('d4c6363e8b185c9fb420d21b61c30b94','hex');
 const b=createHash('sha1').update(namespace).update(String(code).toUpperCase()).digest().subarray(0,16);
 b[6]=(b[6]&15)|0x50; b[8]=(b[8]&63)|0x80; return format(b);
}
function newRoomId(now=Date.now()) { const b=randomBytes(16); b.writeUIntBE(now,0,6); b[6]=(b[6]&15)|0x70;b[8]=(b[8]&63)|0x80;return format(b); }
module.exports={legacyRoomId,newRoomId,UUID};
