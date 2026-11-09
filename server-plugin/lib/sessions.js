'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SESSION_TTL_MS = 60 * 60 * 1000;
const MAX_SESSIONS = 8;

/** @type {Map<string, {dir: string, createdAt: number, data: object}>} */
const sessions = new Map();

function createSessionId() {
    return crypto.randomBytes(24).toString('hex');
}

function purgeExpired() {
    const now = Date.now();
    for (const [id, session] of sessions.entries()) {
        if (now - session.createdAt > SESSION_TTL_MS) {
            destroySession(id);
        }
    }
}

/**
 * @returns {{id: string, dir: string}}
 */
function createSession() {
    purgeExpired();
    while (sessions.size >= MAX_SESSIONS) {
        const oldest = [...sessions.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt)[0];
        if (oldest) {
            destroySession(oldest[0]);
        } else {
            break;
        }
    }

    const id = createSessionId();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `st-migasst-${id.slice(0, 8)}-`));
    sessions.set(id, { dir, createdAt: Date.now(), data: {} });
    return { id, dir };
}

/**
 * @param {string} id
 */
function getSession(id) {
    if (!id || typeof id !== 'string' || !/^[a-f0-9]{48}$/.test(id)) {
        return null;
    }
    purgeExpired();
    const session = sessions.get(id);
    if (!session) {
        return null;
    }
    session.createdAt = Date.now();
    return session;
}

/**
 * @param {string} id
 */
function destroySession(id) {
    const session = sessions.get(id);
    if (!session) {
        return;
    }
    sessions.delete(id);
    try {
        fs.rmSync(session.dir, { recursive: true, force: true });
    } catch {
        // ignore cleanup errors
    }
}

function destroyAll() {
    for (const id of [...sessions.keys()]) {
        destroySession(id);
    }
}

module.exports = {
    createSession,
    getSession,
    destroySession,
    destroyAll,
};
