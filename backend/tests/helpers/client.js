/**
 * Test client helpers.
 *
 * `makeBrowserKeyPair` reproduces exactly what the browser's Web Crypto does:
 * ECDSA P-256, IEEE P1363 (r||s) signature encoding, over the hex hash STRING.
 * If this drifts from `frontend/lib/crypto.js`, the tests would be verifying a
 * signature format the real client never produces — so the two must stay in step.
 */
import crypto from 'node:crypto';
import request from 'supertest';
import { createApp } from '../../app.js';

export const app = () => createApp();

/** A simulated browser keypair. The private key never leaves this object. */
export function makeBrowserKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', {
    namedCurve: 'prime256v1',
  });
  const jwk = publicKey.export({ format: 'jwk' });
  return {
    publicKeyJwk: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y },
    privateKey,
    sign: (message) =>
      crypto
        .sign('sha256', Buffer.from(message, 'utf8'), {
          key: privateKey,
          dsaEncoding: 'ieee-p1363',
        })
        .toString('hex'),
  };
}

export const sha256Hex = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/**
 * Activate an account end to end: verify identity → OTP → activate.
 * Returns tokens plus the keypair, so the caller can sign uploads as this user.
 */
export async function activateUser(server, authorityId, password = 'CorrectHorse!2026') {
  const keys = makeBrowserKeyPair();

  const identity = await request(server).post('/api/auth/verify-identity').send({ authorityId });
  if (identity.status !== 200) {
    throw new Error(`verify-identity failed for ${authorityId}: ${JSON.stringify(identity.body)}`);
  }

  const otpRes = await request(server)
    .post('/api/auth/request-otp')
    .send({ authorityId, purpose: 'ACTIVATION' });
  if (otpRes.status !== 200) {
    throw new Error(`request-otp failed for ${authorityId}: ${JSON.stringify(otpRes.body)}`);
  }

  const activated = await request(server).post('/api/auth/activate').send({
    authorityId,
    otp: otpRes.body.demoOtp,
    password,
    publicKeyJwk: keys.publicKeyJwk,
  });
  if (activated.status !== 201) {
    throw new Error(`activate failed for ${authorityId}: ${JSON.stringify(activated.body)}`);
  }

  return {
    authorityId,
    password,
    keys,
    accessToken: activated.body.accessToken,
    refreshToken: activated.body.refreshToken,
    user: activated.body.user,
  };
}

/** Log in an already-activated account, exercising the live directory re-check. */
export async function loginUser(server, authorityId, password = 'CorrectHorse!2026') {
  const otpRes = await request(server)
    .post('/api/auth/request-otp')
    .send({ authorityId, purpose: 'LOGIN' });
  if (otpRes.status !== 200) {
    throw new Error(`request-otp failed for ${authorityId}: ${JSON.stringify(otpRes.body)}`);
  }

  const res = await request(server)
    .post('/api/auth/login')
    .send({ authorityId, password, otp: otpRes.body.demoOtp });

  return res;
}

/** Convenience: activate then return an authorised supertest wrapper. */
export async function asUser(server, authorityId, password) {
  const session = await activateUser(server, authorityId, password);
  const auth = (req) => req.set('Authorization', `Bearer ${session.accessToken}`);
  return { ...session, auth };
}

export { request };
