const { Router } = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { db } = require('../config/database');
const { redis } = require('../config/redis');
const { env } = require('../config/env');
const { authenticateToken } = require('../middleware/auth');

const router = Router();

router.post('/register', async (req, res) => {
  const { username, email, password } = req.body;

  if (!username || !email || !password) {
    res.status(400).json({ error: 'VALIDATION_ERROR', message: 'username, email, and password are required' });
    return;
  }

  if (password.length < 8) {
    res.status(400).json({ error: 'VALIDATION_ERROR', message: 'Password must be at least 8 characters' });
    return;
  }

  try {
    const passwordHash = await bcrypt.hash(password, 12);

    const result = await db.query(
      `INSERT INTO users (username, email, password_hash, phone_verified, account_created)
       VALUES ($1, $2, $3, true, NOW() - INTERVAL '30 days')
       RETURNING id, username, email, phone_verified, account_created, created_at`,
      [username, email, passwordHash]
    );

    const user = result.rows[0];
    const accountAge = 30;

    const token = jwt.sign(
      {
        userId: user.id,
        username: user.username,
        email: user.email,
        phoneVerified: user.phone_verified,
        accountAge,
      },
      env.JWT_SECRET,
      { expiresIn: env.JWT_EXPIRES_IN }
    );

    // Pre-warm Redis cache to shield Postgres from N+1 query cascades on checkout
    await redis.setex(
      `user:eligibility:${user.id}`,
      3600,
      JSON.stringify({
        eligible: user.phone_verified && accountAge >= 7,
        phoneVerified: user.phone_verified,
        accountAge,
      })
    );

    res.status(201).json({
      message: 'Account created successfully',
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        phoneVerified: user.phone_verified,
        accountAge,
      },
      token,
    });
  } catch (error) {
    if (error.code === '23505') {
      res.status(409).json({ error: 'DUPLICATE', message: 'Username or email already taken' });
      return;
    }
    console.error('[Auth] Registration failed:', error);
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

router.post('/login', async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    res.status(400).json({ error: 'VALIDATION_ERROR', message: 'username and password are required' });
    return;
  }

  try {
    const result = await db.query(
      `SELECT id, username, email, password_hash, phone_verified, is_active,
              EXTRACT(DAY FROM (NOW() - account_created)) as account_age_days
       FROM users WHERE username = $1`,
      [username]
    );

    if (result.rows.length === 0) {
      res.status(401).json({ error: 'INVALID_CREDENTIALS', message: 'Invalid username or password' });
      return;
    }

    const user = result.rows[0];

    if (!user.is_active) {
      res.status(403).json({ error: 'ACCOUNT_DEACTIVATED', message: 'This account has been deactivated' });
      return;
    }

    const passwordValid = await bcrypt.compare(password, user.password_hash);
    if (!passwordValid) {
      res.status(401).json({ error: 'INVALID_CREDENTIALS', message: 'Invalid username or password' });
      return;
    }

    const accountAge = Math.floor(user.account_age_days !== null ? user.account_age_days : 30);

    const token = jwt.sign(
      {
        userId: user.id,
        username: user.username,
        email: user.email,
        phoneVerified: user.phone_verified,
        accountAge,
      },
      env.JWT_SECRET,
      { expiresIn: env.JWT_EXPIRES_IN }
    );

    // Pre-warm Redis cache to shield Postgres from N+1 query cascades on checkout
    await redis.setex(
      `user:eligibility:${user.id}`,
      3600,
      JSON.stringify({
        eligible: user.phone_verified && accountAge >= 7,
        phoneVerified: user.phone_verified,
        accountAge,
      })
    );

    res.json({
      message: 'Login successful',
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        phoneVerified: user.phone_verified,
        accountAge,
      },
      token,
    });
  } catch (error) {
    console.error('[Auth] Login failed:', error);
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

router.get('/me', authenticateToken, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT id, username, email, phone_verified, account_created,
              EXTRACT(DAY FROM (NOW() - account_created)) as account_age_days
       FROM users WHERE id = $1`,
      [req.user.id]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'NOT_FOUND' });
      return;
    }

    const user = result.rows[0];
    res.json({
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        phoneVerified: user.phone_verified,
        accountAgeDays: Math.floor(user.account_age_days),
      },
    });
  } catch (error) {
    console.error('[Auth] Fetch current user failed:', error);
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

module.exports = router;
