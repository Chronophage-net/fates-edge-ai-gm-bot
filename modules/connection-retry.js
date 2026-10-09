'use strict';

// Configuration/authorization failures need operator intervention, not retries.
// Capacity, temporary storage errors and handshake timeouts remain retryable.
const permanentCodes = new Set(['ROOM_PASSWORD_INVALID', 'ROOM_BANNED', 'ROOM_CODE_INVALID']);
function isPermanentAdmissionFailure(message) {
  return message?.type === 'error' && permanentCodes.has(message.code);
}
function shouldReconnect({ code, admissionRejected = false, identityRejected = false } = {}) {
  return !admissionRejected && !identityRejected && ![4000, 4002, 4004, 1008].includes(code);
}
module.exports = { isPermanentAdmissionFailure, shouldReconnect };
