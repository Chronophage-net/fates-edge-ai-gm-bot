const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isPermanentAdmissionFailure, shouldReconnect } = require('../../modules/connection-retry');

test('bad credentials, bans and invalid room configuration stop automatic retries', () => {
  for (const code of ['ROOM_PASSWORD_INVALID', 'ROOM_BANNED', 'ROOM_CODE_INVALID']) {
    assert.equal(isPermanentAdmissionFailure({ type: 'error', code }), true);
    assert.equal(shouldReconnect({ code: 4003, admissionRejected: true }), false);
  }
  for (const code of [4000, 4002, 4004, 1008]) assert.equal(shouldReconnect({ code }), false);
  assert.equal(shouldReconnect({ code: 4003, identityRejected: true }), false);
});
test('temporary failures, full rooms and GM conflict remain retryable', () => {
  for (const code of ['ROOM_FULL', 'ROOM_AUTH_UNAVAILABLE', 'HANDSHAKE_TIMEOUT', 'GM_CONFLICT']) {
    assert.equal(isPermanentAdmissionFailure({ type: 'error', code }), false);
  }
  for (const code of [1001, 1006, 1011, 1013, 4003, 4008]) assert.equal(shouldReconnect({ code }), true);
});
