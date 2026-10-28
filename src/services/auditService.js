const { db } = require('../config/database');

async function logAuditEvent(eventType, entityType, entityId, userId, details = {}) {
  try {
    await db.query(
      `INSERT INTO audit_log (event_type, entity_type, entity_id, user_id, details)
       VALUES ($1, $2, $3, $4, $5)`,
      [eventType, entityType, entityId, userId, JSON.stringify(details)]
    );
  } catch (error) {
    console.error('[Audit] Failed to log event:', eventType, error);
  }
}

async function getRecentAuditEvents(limit = 50) {
  const result = await db.query(
    `SELECT * FROM audit_log ORDER BY created_at DESC LIMIT $1`,
    [limit]
  );
  return result.rows;
}

module.exports = {
  logAuditEvent,
  getRecentAuditEvents,
};
