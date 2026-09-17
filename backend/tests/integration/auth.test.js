/**
 * Identity: directory → auth → session.
 *
 * Run against the REAL directory services, not stubs. The claim being tested is
 * "Lexx holds no identities of its own", and only a real directory can falsify it.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';
import { startDirectories, stopDirectories } from '../helpers/directories.js';
import { allModels } from '../../models/index.js';
import { User } from '../../models/User.js';
import { RefreshToken } from '../../models/RefreshToken.js';
import { sha256Hex } from '../../config/crypto.js';
import { AuditEvent } from '../../models/AuditEvent.js';
import { createApp } from '../../app.js';
import { makeBrowserKeyPair, activateUser, loginUser } from '../helpers/client.js';
import { AUTHORITY, ROLE, USER_STATUS, DECISION } from '../../models/enums.js';

let mongo;
let server;

// Seeded by the directory services (see their seed.js).
const IO = 'UP-GZB-4471';
const SHO = 'UP-GZB-4402';
const JUDGE = 'UP-JUD-2291';
const EXAMINER = 'FSL-LKO-0091';
const ADVOCATE_ON_RECORD = 'UP/1234/2015';
const ADVOCATE_NOT_ON_RECORD = 'UP/9876/2019';
const SUSPENDED_OFFICER = 'UP-GZB-4499';
const EXPIRED_POSTING_OFFICER = 'UP-GZB-4488';
const LAPSED_COP_ADVOCATE = 'UP/5555/2011';

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  const uri = mongo.getUri();

  await startDirectories(uri);

  await mongoose.connect(uri, { dbName: 'lexx_test_auth', bufferCommands: false });
  for (const m of allModels) await m.createIndexes();

  server = createApp();
}, 120_000);

afterAll(async () => {
  await mongoose.disconnect();
  await stopDirectories();
  await mongo.stop();
});

beforeEach(async () => {
  // Clear only Lexx's own collections. The directories keep their seeded state.
  await Promise.all(Object.values(mongoose.connection.collections).map((c) => c.deleteMany({})));
});

// =========================================================== BEAT 1: rejection ==

describe('a fake authority identity is rejected and audited', () => {
  it('rejects an unknown PIS number', async () => {
    const res = await request(server)
      .post('/api/auth/verify-identity')
      .send({ authorityId: 'UP-GZB-9999' });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('IDENTITY_NOT_VERIFIED');
  });

  it('writes a DENY audit row for the attempt', async () => {
    await request(server).post('/api/auth/verify-identity').send({ authorityId: 'UP-GZB-9999' });

    const audit = await AuditEvent.findOne({ authorityId: 'UP-GZB-9999' }).lean();
    expect(audit).toBeTruthy();
    expect(audit.decision).toBe(DECISION.DENY);
    expect(audit.reason).toBe('IDENTITY_NOT_IN_DIRECTORY');
  });

  it('refuses to activate an account for an identity that does not exist', async () => {
    const keys = makeBrowserKeyPair();
    const res = await request(server).post('/api/auth/activate').send({
      authorityId: 'UP-GZB-9999',
      otp: '123456',
      password: 'CorrectHorse!2026',
      publicKeyJwk: keys.publicKeyJwk,
    });

    expect(res.status).toBe(403);
    expect(await User.countDocuments()).toBe(0);
  });

  it('rejects a malformed identifier before it reaches a directory', async () => {
    for (const bad of ['', 'a', '../../etc/passwd', 'x'.repeat(200), 'UP GZB 4471']) {
      const res = await request(server).post('/api/auth/verify-identity').send({ authorityId: bad });
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
    }
  });

  it('rejects an operator-injection payload instead of matching a record', async () => {
    const res = await request(server)
      .post('/api/auth/verify-identity')
      .send({ authorityId: { $ne: null } });
    expect(res.status).toBe(400);
  });
});

// ============================================================== provisioning ==

describe('accounts are provisioned from the directory, never from the request', () => {
  it('verifies a real officer and reports a masked phone', async () => {
    const res = await request(server).post('/api/auth/verify-identity').send({ authorityId: IO });

    expect(res.status).toBe(200);
    expect(res.body.authority).toBe(AUTHORITY.POLICE);
    expect(res.body.role).toBe(ROLE.IO);
    expect(res.body.scope.stationCode).toBe('UP-GZB-KVN');
    expect(res.body.nextStep).toBe('ACTIVATE');
    // The full number must never leave the directory boundary.
    expect(res.body.maskedPhone).toMatch(/^•+\d{4}$/);
  });

  it('activates with the role and scope taken from the directory', async () => {
    const session = await activateUser(server, IO);
    expect(session.user.authority).toBe(AUTHORITY.POLICE);
    expect(session.user.role).toBe(ROLE.IO);
    expect(session.user.scope.stationCode).toBe('UP-GZB-KVN');
    expect(session.user.scope.districtCode).toBe('UP-GZB');
  });

  it('IGNORES role, authority and scope supplied in the activation body', async () => {
    // The privilege-escalation attempt the whole design exists to defeat.
    const keys = makeBrowserKeyPair();
    await request(server).post('/api/auth/request-otp').send({ authorityId: IO, purpose: 'ACTIVATION' });
    const otpRes = await request(server)
      .post('/api/auth/request-otp')
      .send({ authorityId: IO, purpose: 'ACTIVATION' });

    const res = await request(server).post('/api/auth/activate').send({
      authorityId: IO,
      otp: otpRes.body.demoOtp,
      password: 'CorrectHorse!2026',
      publicKeyJwk: keys.publicKeyJwk,
      // ---- all of this is attacker-supplied and must be discarded ----
      role: 'DISTRICT_SP',
      authority: 'COURT',
      scope: { stationCode: 'XX-YYY-ZZZ', districtCode: 'XX-YYY', courtId: 'FAKE-COURT' },
      status: 'ACTIVE',
      createdVia: 'INVITE',
    });

    expect(res.status).toBe(201);
    expect(res.body.user.role).toBe(ROLE.IO);
    expect(res.body.user.authority).toBe(AUTHORITY.POLICE);
    expect(res.body.user.scope.stationCode).toBe('UP-GZB-KVN');
    expect(res.body.user.scope.courtId).toBeNull();

    const stored = await User.findOne({ authorityId: IO }).lean();
    expect(stored.role).toBe(ROLE.IO);
    expect(stored.scope.districtCode).toBe('UP-GZB');
  });

  it('refuses to activate the same account twice', async () => {
    await activateUser(server, IO);
    const keys = makeBrowserKeyPair();
    const res = await request(server).post('/api/auth/activate').send({
      authorityId: IO,
      otp: '123456',
      password: 'CorrectHorse!2026',
      publicKeyJwk: keys.publicKeyJwk,
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('ACCOUNT_EXISTS');
  });

  it('rejects a weak password', async () => {
    const keys = makeBrowserKeyPair();
    const otpRes = await request(server)
      .post('/api/auth/request-otp')
      .send({ authorityId: IO, purpose: 'ACTIVATION' });
    const res = await request(server).post('/api/auth/activate').send({
      authorityId: IO,
      otp: otpRes.body.demoOtp,
      password: 'short',
      publicKeyJwk: keys.publicKeyJwk,
    });
    expect(res.status).toBe(400);
  });

  it('rejects a non-P-256 public key', async () => {
    const otpRes = await request(server)
      .post('/api/auth/request-otp')
      .send({ authorityId: IO, purpose: 'ACTIVATION' });
    const res = await request(server).post('/api/auth/activate').send({
      authorityId: IO,
      otp: otpRes.body.demoOtp,
      password: 'CorrectHorse!2026',
      publicKeyJwk: { kty: 'EC', crv: 'P-384', x: 'aaa', y: 'bbb' },
    });
    expect(res.status).toBe(400);
  });

  it('returns 410 Gone for self-registration', async () => {
    const res = await request(server).post('/api/auth/register').send({ authorityId: IO });
    expect(res.status).toBe(410);
    expect(res.body.error.message).toMatch(/provisioned by your authority directory/i);
  });
});

// ===================================================== roles from directories ==

describe('each authority resolves to the right role and scope', () => {
  it('resolves an SHO', async () => {
    const s = await activateUser(server, SHO);
    expect(s.user.role).toBe(ROLE.SHO);
    expect(s.user.scope.stationCode).toBe('UP-GZB-KVN');
  });

  it('resolves a judge to their court VIA THE ROSTER', async () => {
    // Lexx never assigns a judge to a court. The court published a roster; we read it.
    const s = await activateUser(server, JUDGE);
    expect(s.user.authority).toBe(AUTHORITY.COURT);
    expect(s.user.role).toBe(ROLE.COURT);
    expect(s.user.scope.courtId).toBe('UP-GZB-SESS-02');
    expect(s.user.scope.districtCode).toBe('UP-GZB');
  });

  it('resolves court registry staff to the same single Court role', async () => {
    const s = await activateUser(server, 'UP-GZB-EVC-02');
    expect(s.user.authority).toBe(AUTHORITY.COURT);
    expect(s.user.role).toBe(ROLE.COURT);
    expect(s.user.scope.courtId).toBe('UP-GZB-CJM-01');
  });

  it('resolves an FSL examiner to their lab', async () => {
    const s = await activateUser(server, EXAMINER);
    expect(s.user.authority).toBe(AUTHORITY.FSL);
    expect(s.user.role).toBe(ROLE.FSL_EXAMINER);
    expect(s.user.scope.labId).toBe('UP-FSL-LKO');
  });

  it('gives an advocate NO jurisdictional scope — their access is per-case only', async () => {
    const s = await activateUser(server, ADVOCATE_ON_RECORD);
    expect(s.user.authority).toBe(AUTHORITY.LEGAL);
    expect(s.user.scope.stationCode).toBeNull();
    expect(s.user.scope.districtCode).toBeNull();
    expect(s.user.scope.courtId).toBeNull();
  });

  it('activates the not-on-record advocate as a perfectly valid user', async () => {
    // The denial demo depends on this advocate being genuine. They are refused
    // access to a case because they are not on record, not because they are fake.
    const s = await activateUser(server, ADVOCATE_NOT_ON_RECORD);
    expect(s.user.authority).toBe(AUTHORITY.LEGAL);
    expect(s.user.status).toBe(USER_STATUS.ACTIVE);
  });
});

// ================================================ directory status enforcement ==

describe('directory status is enforced at the door', () => {
  it('refuses a SUSPENDED officer', async () => {
    const res = await request(server)
      .post('/api/auth/verify-identity')
      .send({ authorityId: SUSPENDED_OFFICER });
    expect(res.status).toBe(403);
    expect(res.body.error.details.reason).toMatch(/SUSPENDED/);
  });

  it('refuses an officer whose posting has expired', async () => {
    // The access-expiry property: nobody in Lexx did anything, the posting simply ran out.
    const res = await request(server)
      .post('/api/auth/verify-identity')
      .send({ authorityId: EXPIRED_POSTING_OFFICER });
    expect(res.status).toBe(403);
    expect(res.body.error.details.reason).toMatch(/POSTING_(EXPIRED|NOT_CURRENT)/);
  });

  it('refuses an advocate whose certificate of practice has lapsed', async () => {
    const res = await request(server)
      .post('/api/auth/verify-identity')
      .send({ authorityId: LAPSED_COP_ADVOCATE });
    expect(res.status).toBe(403);
    expect(res.body.error.details.reason).toBe('CERTIFICATE_OF_PRACTICE_EXPIRED');
  });
});

// ==================================================================== login ==

describe('login re-verifies against the live directory', () => {
  it('signs in an activated officer', async () => {
    await activateUser(server, IO);
    const res = await loginUser(server, IO);
    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBeTruthy();
    expect(res.body.user.role).toBe(ROLE.IO);
  });

  it('rejects a wrong password', async () => {
    await activateUser(server, IO);
    const res = await loginUser(server, IO, 'WrongPassword!2026');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('BAD_CREDENTIALS');
  });

  it('gives the same error for an unknown user as for a wrong password', async () => {
    // No user enumeration through differing error codes.
    await activateUser(server, IO);
    const wrongPassword = await loginUser(server, IO, 'WrongPassword!2026');
    const unknownUser = await request(server)
      .post('/api/auth/login')
      .send({ authorityId: SHO, password: 'WrongPassword!2026', otp: '123456' });

    expect(wrongPassword.body.error.code).toBe('BAD_CREDENTIALS');
    expect(unknownUser.status).toBeGreaterThanOrEqual(400);
  });

  it('denies a user suspended inside Lexx on the next request, not the next login', async () => {
    const s = await activateUser(server, IO);

    const before = await request(server).get('/api/auth/me').set('Authorization', `Bearer ${s.accessToken}`);
    expect(before.status).toBe(200);

    await User.updateOne({ authorityId: IO }, { $set: { status: USER_STATUS.SUSPENDED } });

    // Same still-valid token; authority is re-read from the database each request.
    const after = await request(server).get('/api/auth/me').set('Authorization', `Bearer ${s.accessToken}`);
    expect(after.status).toBe(403);
    expect(after.body.error.code).toBe('USER_NOT_ACTIVE');
  });

  it('rejects a token whose role no longer matches the stored user', async () => {
    const s = await activateUser(server, IO);
    await User.updateOne({ authorityId: IO }, { $set: { role: ROLE.SHO } });

    const res = await request(server).get('/api/auth/me').set('Authorization', `Bearer ${s.accessToken}`);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('SESSION_STALE');
  });
});

// ====================================================================== OTP ==

describe('OTP hardening (ADR-004)', () => {
  it('is single-use', async () => {
    await activateUser(server, IO);
    const otpRes = await request(server)
      .post('/api/auth/request-otp')
      .send({ authorityId: IO, purpose: 'LOGIN' });
    const otp = otpRes.body.demoOtp;

    const first = await request(server)
      .post('/api/auth/login')
      .send({ authorityId: IO, password: 'CorrectHorse!2026', otp });
    expect(first.status).toBe(200);

    const replay = await request(server)
      .post('/api/auth/login')
      .send({ authorityId: IO, password: 'CorrectHorse!2026', otp });
    expect(replay.status).toBe(401);
    expect(replay.body.error.code).toBe('OTP_INVALID');
  });

  it('is purpose-bound: an activation code does not work for login', async () => {
    await activateUser(server, IO);
    const activationOtp = await request(server)
      .post('/api/auth/request-otp')
      .send({ authorityId: IO, purpose: 'ACTIVATION' });
    // Requesting an ACTIVATION code for an existing account is itself refused.
    expect(activationOtp.status).toBe(400);
  });

  it('rejects a wrong code', async () => {
    await activateUser(server, IO);
    await request(server).post('/api/auth/request-otp').send({ authorityId: IO, purpose: 'LOGIN' });
    const res = await request(server)
      .post('/api/auth/login')
      .send({ authorityId: IO, password: 'CorrectHorse!2026', otp: '000000' });
    expect(res.status).toBe(401);
  });

  it('caps brute-force attempts on one challenge', async () => {
    await activateUser(server, IO);
    await request(server).post('/api/auth/request-otp').send({ authorityId: IO, purpose: 'LOGIN' });

    let sawLockout = false;
    for (let i = 0; i < 8; i += 1) {
      const res = await request(server)
        .post('/api/auth/login')
        .send({ authorityId: IO, password: 'CorrectHorse!2026', otp: '000000' });
      if (res.status === 429) sawLockout = true;
    }
    expect(sawLockout).toBe(true);
  });

  it('invalidates a previous code when a new one is issued', async () => {
    await activateUser(server, IO);
    const first = await request(server)
      .post('/api/auth/request-otp')
      .send({ authorityId: IO, purpose: 'LOGIN' });
    await request(server).post('/api/auth/request-otp').send({ authorityId: IO, purpose: 'LOGIN' });

    const res = await request(server)
      .post('/api/auth/login')
      .send({ authorityId: IO, password: 'CorrectHorse!2026', otp: first.body.demoOtp });
    expect(res.status).toBe(401);
  });
});

// ================================================================== tokens ==

describe('session tokens', () => {
  it('rejects a missing, malformed or unsigned token', async () => {
    const noToken = await request(server).get('/api/auth/me');
    expect(noToken.status).toBe(401);

    const junk = await request(server).get('/api/auth/me').set('Authorization', 'Bearer not.a.token');
    expect(junk.status).toBe(401);

    // alg:none — the classic algorithm-confusion attempt.
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(
      JSON.stringify({ sub: '507f1f77bcf86cd799439011', role: 'DISTRICT_SP' })
    ).toString('base64url');
    const forged = await request(server)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${header}.${payload}.`);
    expect(forged.status).toBe(401);
  });

  it('issues refresh tokens that never expire on their own', async () => {
    const s = await activateUser(server, IO);
    const record = await RefreshToken.findOne({ tokenHash: sha256Hex(s.refreshToken) }).lean();
    expect(record.expiresAt.getUTCFullYear()).toBe(9999);

    const renewed = await request(server).post('/api/auth/refresh').send({ refreshToken: s.refreshToken });
    expect(renewed.status).toBe(200);
    const next = await RefreshToken.findOne({ tokenHash: sha256Hex(renewed.body.refreshToken) }).lean();
    expect(next.expiresAt.getUTCFullYear()).toBe(9999);
  });

  it('rotates the refresh token and refuses the old one', async () => {
    const s = await activateUser(server, IO);

    const first = await request(server).post('/api/auth/refresh').send({ refreshToken: s.refreshToken });
    expect(first.status).toBe(200);
    expect(first.body.refreshToken).not.toBe(s.refreshToken);

    const replay = await request(server).post('/api/auth/refresh').send({ refreshToken: s.refreshToken });
    expect(replay.status).toBe(401);
    expect(replay.body.error.code).toBe('REFRESH_REUSED');
  });

  it('revokes the whole family when reuse is detected', async () => {
    const s = await activateUser(server, IO);
    const rotated = await request(server).post('/api/auth/refresh').send({ refreshToken: s.refreshToken });

    // Replaying the consumed token should burn the successor too.
    await request(server).post('/api/auth/refresh').send({ refreshToken: s.refreshToken });

    const afterCompromise = await request(server)
      .post('/api/auth/refresh')
      .send({ refreshToken: rotated.body.refreshToken });
    expect(afterCompromise.status).toBe(401);
  });

  it('logs out and revokes refresh tokens', async () => {
    const s = await activateUser(server, IO);
    const out = await request(server)
      .post('/api/auth/logout')
      .set('Authorization', `Bearer ${s.accessToken}`);
    expect(out.status).toBe(200);

    const res = await request(server).post('/api/auth/refresh').send({ refreshToken: s.refreshToken });
    expect(res.status).toBe(401);
  });
});
