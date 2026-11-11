import express from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { createUser, getUserByUsername, updateSetting, getSettings, getUserById, recordLogin, addLog } from './db.js';

import { sendAdminNotification, sendLoginOTP, sendLoginNotification } from './notifier.js';

const router = express.Router();

// --- JWT Secret ---
// Must be set via environment variable. No hardcoded fallback.
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error('[FATAL] JWT_SECRET environment variable is not set. The server cannot start securely.');
  process.exit(1);
}

// --- Admin identity check ---
// Relies solely on the is_admin flag set in the database.
function isAdminUser(user) {
  return user && (user.is_admin === 1 || user.is_admin === true);
}

// --- requireAdmin middleware ---
// Use on any route that must only be accessible to the admin.
export const requireAdmin = (req, res, next) => {
  if (!isAdminUser(req.user)) {
    return res.status(403).json({ success: false, error: 'Forbidden. Admin access only.' });
  }
  next();
};

// JWTs last 30 days, so most users never hit /auth/login again after their first sign-in —
// which used to mean last_login_at (and therefore the admin dashboard's "Active" status)
// stayed frozen at their very first login forever. Instead, treat any authenticated request
// as a sign of activity, throttled per-user so we're not writing to the DB on every poll.
const lastActivityUpdate = new Map();
const ACTIVITY_UPDATE_THROTTLE_MS = 5 * 60 * 1000; // 5 minutes

function trackActivity(userId) {
  const last = lastActivityUpdate.get(userId) || 0;
  const now = Date.now();
  if (now - last < ACTIVITY_UPDATE_THROTTLE_MS) return;
  lastActivityUpdate.set(userId, now);
  recordLogin(userId).catch(() => {});
}

// --- Middleware to protect routes (any authenticated user) ---
export const requireAuth = (req, res, next) => {
  const token = req.header('Authorization')?.replace('Bearer ', '');

  if (!token) {
    return res.status(401).json({ success: false, error: 'Authentication required' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded; // { id, username, is_admin }
    trackActivity(decoded.id);
    next();
  } catch (err) {
    res.status(401).json({ success: false, error: 'Invalid or expired token' });
  }
};

// --- OTP token helpers ---
// A short-lived HMAC token encodes userId server-side so the client
// never sees or controls the raw userId during 2FA verification.
const OTP_TOKEN_SECRET = JWT_SECRET + ':otp-token';
const OTP_TOKEN_TTL_MS = 10 * 60 * 1000; // 10 minutes

function generateOtpToken(userId) {
  const payload = `${userId}:${Date.now()}`;
  const sig = crypto.createHmac('sha256', OTP_TOKEN_SECRET).update(payload).digest('hex');
  // base64-encode "payload.sig" for safe transport
  return Buffer.from(`${payload}.${sig}`).toString('base64url');
}

function verifyOtpToken(token) {
  try {
    const decoded = Buffer.from(token, 'base64url').toString('utf8');
    const lastDot = decoded.lastIndexOf('.');
    const payload = decoded.slice(0, lastDot);
    const sig = decoded.slice(lastDot + 1);
    const expectedSig = crypto.createHmac('sha256', OTP_TOKEN_SECRET).update(payload).digest('hex');
    // Timing-safe comparison
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expectedSig))) {
      return null;
    }
    const [userId, issuedAt] = payload.split(':');
    if (Date.now() - parseInt(issuedAt, 10) > OTP_TOKEN_TTL_MS) {
      return null; // token expired
    }
    return parseInt(userId, 10);
  } catch {
    return null;
  }
}

// --- Register ---
router.post('/register', async (req, res) => {
  try {
    const { username, password } = req.body;
    const cleanUsername = (username || '').trim();

    if (!cleanUsername || !password) {
      return res.status(400).json({ success: false, error: 'Username and password required' });
    }

    const existingUser = await getUserByUsername(cleanUsername);
    if (existingUser) {
      return res.status(400).json({ success: false, error: 'Username already exists' });
    }

    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(password, salt);

    const userId = await createUser(cleanUsername, passwordHash);
    const createdUser = await getUserById(userId);
    const isAdmin = isAdminUser(createdUser);

    const token = jwt.sign({ id: userId, username: cleanUsername, is_admin: isAdmin }, JWT_SECRET, { expiresIn: '30d' });

    await addLog(userId, 'INFO', 'Account created successfully.').catch(() => {});

    // Notify admin when a non-admin user registers
    if (!isAdmin) {
      const settings = await getSettings(userId).catch(() => ({}));
      const keywords = settings.keywords || 'None';
      const location = settings.location || 'None';
      await sendAdminNotification(`New user registered: ${cleanUsername} (ID: ${userId}) [Keywords: ${keywords}, Location: ${location}]`);
    }

    res.json({ success: true, token, user: { id: userId, username: cleanUsername, is_admin: isAdmin } });
  } catch (err) {
    console.error('Registration error:', err);
    res.status(500).json({ success: false, error: 'Registration failed: ' + err.message });
  }
});

// --- Login ---
router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const cleanUsername = (username || '').trim();

    if (!cleanUsername || !password) {
      return res.status(400).json({ success: false, error: 'Username and password required' });
    }

    const user = await getUserByUsername(cleanUsername);
    if (!user) {
      return res.status(401).json({ success: false, error: 'Invalid credentials' });
    }

    const isMatch = await bcrypt.compare(password, user.password_hash);
    if (!isMatch) {
      return res.status(401).json({ success: false, error: 'Invalid credentials' });
    }

    const isAdmin = isAdminUser(user);

    // Admin: trigger 2FA OTP ONLY IF SMTP email service is configured
    const smtpUser = process.env.EMAIL_USER || process.env.SMTP_USER;
    const smtpPass = process.env.EMAIL_APP_PASSWORD || process.env.SMTP_PASS;
    const hasSmtpConfigured = Boolean(smtpUser && smtpPass);

    if (isAdmin) {
      const settings = await getSettings(user.id);

      // Rate-limit OTP generation: max 1 per 60 seconds
      const lastSentAt = parseInt(settings.otp_last_sent_at || '0', 10);
      const secondsSinceLastSent = (Date.now() - lastSentAt) / 1000;
      if (lastSentAt > 0 && secondsSinceLastSent < 60) {
        const waitSecs = Math.ceil(60 - secondsSinceLastSent);
        return res.status(429).json({
          success: false,
          error: `Please wait ${waitSecs} seconds before requesting a new code.`
        });
      }

      // Generate OTP
      const otpCode = Math.floor(100000 + Math.random() * 900000).toString();
      const expiresAt = Date.now() + 5 * 60 * 1000; // 5 minutes
      const now = Date.now();

      // Persist all OTP state to DB
      await updateSetting(user.id, 'otp_code', otpCode);
      await updateSetting(user.id, 'otp_expires_at', expiresAt.toString());
      await updateSetting(user.id, 'otp_attempts', '5');
      await updateSetting(user.id, 'otp_last_sent_at', now.toString());

      // Attempt to send email
      const emailSent = await sendLoginOTP(otpCode);

      if (!emailSent) {
        return res.status(500).json({
          success: false,
          error: 'Failed to send 2FA OTP code to your email. Please verify EMAIL_USER and EMAIL_APP_PASSWORD settings.'
        });
      }

      const otpToken = generateOtpToken(user.id);
      return res.json({
        success: true,
        requires2FA: true,
        otpToken
      });
    }

    // Direct JWT issue for non-admin users only
    const token = jwt.sign({ id: user.id, username: user.username, is_admin: false }, JWT_SECRET, { expiresIn: '30d' });

    await recordLogin(user.id).catch(() => {});
    await addLog(user.id, 'INFO', 'User logged in successfully.').catch(() => {});
    const clientIp = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '';
    await sendLoginNotification(user.id, user.username, clientIp).catch(() => {});

    res.json({ success: true, token, user: { id: user.id, username: user.username, is_admin: false } });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ success: false, error: 'Login failed: ' + err.message });
  }
});

// --- Verify OTP ---
router.post('/verify-otp', async (req, res) => {
  try {
    const { otpToken, otpCode } = req.body;

    if (!otpToken || !otpCode) {
      return res.status(400).json({ success: false, error: 'Missing information' });
    }

    const userId = verifyOtpToken(otpToken);
    if (!userId) {
      return res.status(401).json({ success: false, error: 'Invalid or expired session. Please log in again.' });
    }

    const settings = await getSettings(userId);
    const storedCode = settings.otp_code || '';
    const expiresAt = parseInt(settings.otp_expires_at || '0', 10);
    const attemptsLeft = parseInt(settings.otp_attempts || '0', 10);

    if (!storedCode || attemptsLeft <= 0) {
      return res.status(401).json({ success: false, error: 'OTP has been invalidated. Please log in again to request a new code.' });
    }

    if (Date.now() > expiresAt) {
      await updateSetting(userId, 'otp_code', '');
      await updateSetting(userId, 'otp_expires_at', '0');
      await updateSetting(userId, 'otp_attempts', '0');
      return res.status(401).json({ success: false, error: 'Code has expired. Please log in again.' });
    }

    const newAttempts = attemptsLeft - 1;
    await updateSetting(userId, 'otp_attempts', newAttempts.toString());

    const provided = Buffer.from(otpCode.trim().padEnd(6, ' '));
    const stored = Buffer.from(storedCode.padEnd(6, ' '));
    const isCorrect = provided.length === stored.length &&
      crypto.timingSafeEqual(provided, stored) &&
      otpCode.trim() === storedCode;

    if (!isCorrect) {
      if (newAttempts <= 0) {
        await updateSetting(userId, 'otp_code', '');
        await updateSetting(userId, 'otp_expires_at', '0');
        return res.status(401).json({
          success: false,
          error: 'Maximum attempts reached. Your code has been invalidated. Please log in again to request a new code.'
        });
      }
      return res.status(401).json({
        success: false,
        error: `Invalid code. ${newAttempts} attempt${newAttempts === 1 ? '' : 's'} remaining.`
      });
    }

    await updateSetting(userId, 'otp_code', '');
    await updateSetting(userId, 'otp_expires_at', '0');
    await updateSetting(userId, 'otp_attempts', '0');
    await updateSetting(userId, 'otp_last_sent_at', '0');

    const user = await getUserById(userId);
    if (!user) {
      return res.status(401).json({ success: false, error: 'User not found' });
    }

    const isAdmin = isAdminUser(user);
    const token = jwt.sign({ id: user.id, username: user.username, is_admin: isAdmin }, JWT_SECRET, { expiresIn: '30d' });

    await recordLogin(user.id).catch(() => {});
    await addLog(user.id, 'INFO', 'User logged in successfully.').catch(() => {});
    const clientIp = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '';
    await sendLoginNotification(user.id, user.username, clientIp).catch(() => {});

    res.json({ success: true, token, user: { id: user.id, username: user.username, is_admin: isAdmin } });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Verification failed' });
  }
});

export default router;
