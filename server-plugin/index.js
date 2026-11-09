'use strict';

const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { createSession, getSession, destroySession, destroyAll } = require('./lib/sessions');
const { extractExportZip } = require('./lib/zip');
const { parseExport, applyChatOverrides } = require('./lib/parse');
const { buildCharacterClusters, applyMatchOverrides, buildImportPlan } = require('./lib/match');
const { materializeImportPayloads, stagePayloads } = require('./lib/import');

const PLUGIN_ID = 'migration-assistant';
const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;

/**
 * Bounded JSON body parser that does not depend on a specific Express build.
 * Rejects oversized payloads and invalid JSON.
 */
function jsonParser(req, res, next) {
    if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) {
        next();
        return;
    }
    const chunks = [];
    let size = 0;
    const limit = 8 * 1024 * 1024;
    req.on('data', (chunk) => {
        size += chunk.length;
        if (size > limit) {
            res.status(413).json({ error: 'JSON body too large.' });
            req.destroy();
            return;
        }
        chunks.push(chunk);
    });
    req.on('end', () => {
        if (res.headersSent) {
            return;
        }
        if (!chunks.length) {
            req.body = {};
            next();
            return;
        }
        try {
            req.body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
                res.status(400).json({ error: 'JSON body must be an object.' });
                return;
            }
            next();
        } catch {
            res.status(400).json({ error: 'Invalid JSON body.' });
        }
    });
}

const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: MAX_UPLOAD_BYTES,
        files: 1,
        fields: 5,
    },
    fileFilter: (_req, file, cb) => {
        const name = String(file.originalname || '').toLowerCase();
        const okZip = name.endsWith('.zip') || file.mimetype === 'application/zip' || file.mimetype === 'application/x-zip-compressed';
        const okJson = name.endsWith('.json') || file.mimetype === 'application/json' || file.mimetype === 'text/json';
        if (!okZip && !okJson) {
            cb(new Error('Choose a CharacterAI export .zip or message .json file.'));
            return;
        }
        cb(null, true);
    },
});

/**
 * Require a valid session; send 404 otherwise.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
function requireSession(req, res) {
    const sessionId = String(req.params.sessionId || req.body?.sessionId || '');
    const session = getSession(sessionId);
    if (!session) {
        res.status(404).json({ error: 'Session not found or expired.' });
        return null;
    }
    return { sessionId, session };
}

/**
 * Slim chat list for UI review (omit full message bodies until requested).
 * @param {object} parsed
 */
function summarizeChats(parsed) {
    return parsed.chats.map((c) => ({
        chatId: c.chatId,
        messageCount: c.messageCount,
        startedAt: c.startedAt,
        endedAt: c.endedAt,
        greetingPreview: String(c.greeting || '').slice(0, 180),
        skip: !!c.skip,
        characterKey: c.characterKey,
        roleSummary: c.messages.reduce((acc, m) => {
            acc[m.role] = (acc[m.role] || 0) + 1;
            return acc;
        }, {}),
    }));
}

/**
 * @param {import('express').Router} router
 */
async function init(router) {
    router.get('/probe', (_req, res) => res.sendStatus(204));

    router.post('/upload', (req, res) => {
        upload.single('export')(req, res, (err) => {
            if (err) {
                const status = err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
                return res.status(status).json({ error: err.message || 'Upload failed.' });
            }

            let sessionId = null;
            try {
                if (!req.file?.buffer?.length) {
                    return res.status(400).json({ error: 'Missing export file.' });
                }

                const created = createSession();
                sessionId = created.id;
                const isZip = String(req.file.originalname || '').toLowerCase().endsWith('.zip')
                    || req.file.mimetype === 'application/zip'
                    || req.file.mimetype === 'application/x-zip-compressed';
                let parsed;
                let imageCount = 0;
                if (isZip) {
                    const extracted = extractExportZip(req.file.buffer, created.dir);
                    parsed = parseExport(extracted.files.messages, extracted.files.characters, extracted.files.user);
                    imageCount = extracted.imageCount;
                } else {
                    const messagesPath = path.join(created.dir, 'message.json');
                    fs.writeFileSync(messagesPath, req.file.buffer);
                    parsed = parseExport(messagesPath, null, null);
                }

                const session = getSession(sessionId);
                session.data.parsed = parsed;
                session.data.imageCount = imageCount;
                session.data.step = 'chats';

                // Drop the raw upload buffer reference ASAP
                req.file.buffer = null;

                return res.json({
                    sessionId,
                    user: parsed.user,
                    stats: parsed.stats,
                    imageCount,
                    chats: summarizeChats(parsed),
                    characters: parsed.characters.map((c) => ({
                        key: c.key,
                        name: c.name,
                        title: c.title,
                        greetingPreview: String(c.greeting || '').slice(0, 160),
                        hasDefinition: !!c.definition,
                    })),
                });
            } catch (error) {
                if (sessionId) {
                    destroySession(sessionId);
                }
                console.error('[migration-assistant] upload failed:', error.message);
                return res.status(400).json({ error: 'Could not process the uploaded export.' });
            }
        });
    });

    router.get('/session/:sessionId/chat/:chatId', (req, res) => {
        const ctx = requireSession(req, res);
        if (!ctx) {
            return;
        }
        const chatId = String(req.params.chatId || '');
        if (!/^[a-f0-9-]{36}$/i.test(chatId)) {
            return res.status(400).json({ error: 'Invalid chat id.' });
        }
        const chat = ctx.session.data.parsed?.chats?.find((c) => c.chatId === chatId);
        if (!chat) {
            return res.status(404).json({ error: 'Chat not found.' });
        }
        return res.json({ chat });
    });

    router.post('/session/:sessionId/chats/overrides', jsonParser, (req, res) => {
        const ctx = requireSession(req, res);
        if (!ctx) {
            return;
        }
        try {
            const overrides = Array.isArray(req.body?.overrides) ? req.body.overrides.slice(0, 5000) : [];
            applyChatOverrides(ctx.session.data.parsed, overrides);
            ctx.session.data.step = 'chats-confirmed';
            return res.json({
                ok: true,
                chats: summarizeChats(ctx.session.data.parsed),
            });
        } catch (error) {
            console.error('[migration-assistant] chat overrides failed:', error.message);
            return res.status(400).json({ error: 'Invalid chat overrides.' });
        }
    });

    router.post('/session/:sessionId/match', jsonParser, (req, res) => {
        const ctx = requireSession(req, res);
        if (!ctx) {
            return;
        }
        try {
            const matchResult = buildCharacterClusters(ctx.session.data.parsed);
            ctx.session.data.matchResult = matchResult;
            ctx.session.data.step = 'match';
            return res.json({
                summary: matchResult.summary,
                clusters: matchResult.clusters.map((c) => ({
                    clusterId: c.clusterId,
                    greetingPreview: String(c.greeting || '').slice(0, 200),
                    chatCount: c.chatIds.length,
                    messageCount: c.messageCount,
                    match: c.match
                        ? {
                            key: c.match.key,
                            name: c.match.name,
                            source: c.match.source,
                            greetingPreview: String(c.match.greeting || '').slice(0, 160),
                            hasDefinition: !!c.match.definition,
                            imageUrl: c.match.imageUrl || null,
                        }
                        : null,
                    matchSource: c.matchSource,
                    matchConfidence: c.matchConfidence,
                    needsSearch: c.needsSearch,
                    candidates: (c.candidates || []).map((x) => ({
                        key: x.key,
                        name: x.name,
                        greetingPreview: String(x.greeting || '').slice(0, 120),
                    })),
                })),
            });
        } catch (error) {
            console.error('[migration-assistant] match failed:', error.message);
            return res.status(500).json({ error: 'Character matching failed.' });
        }
    });

    router.post('/session/:sessionId/match/overrides', jsonParser, (req, res) => {
        const ctx = requireSession(req, res);
        if (!ctx) {
            return;
        }
        try {
            if (!ctx.session.data.matchResult) {
                return res.status(400).json({ error: 'Run matching first.' });
            }
            const overrides = Array.isArray(req.body?.overrides) ? req.body.overrides.slice(0, 5000) : [];
            // Strip unexpected fields from inbound character objects
            const cleaned = overrides.map((o) => ({
                clusterId: String(o.clusterId || ''),
                action: ['keep', 'replace', 'skip', 'manual'].includes(o.action) ? o.action : 'keep',
                character: o.character && typeof o.character === 'object'
                    ? {
                        key: String(o.character.key || '').slice(0, 120),
                        source: String(o.character.source || 'manual').slice(0, 40),
                        name: String(o.character.name || '').slice(0, 120),
                        title: o.character.title ? String(o.character.title).slice(0, 200) : null,
                        description: String(o.character.description || '').slice(0, 20000),
                        greeting: String(o.character.greeting || '').slice(0, 20000),
                        definition: String(o.character.definition || '').slice(0, 100000),
                        imageUrl: sanitizeImageRef(o.character.imageUrl),
                    }
                    : undefined,
            }));
            applyMatchOverrides(ctx.session.data.matchResult, cleaned);
            ctx.session.data.step = 'match-confirmed';
            return res.json({ ok: true, summary: ctx.session.data.matchResult.summary });
        } catch (error) {
            console.error('[migration-assistant] match overrides failed:', error.message);
            return res.status(400).json({ error: 'Invalid match overrides.' });
        }
    });

    router.post('/session/:sessionId/plan', jsonParser, (req, res) => {
        const ctx = requireSession(req, res);
        if (!ctx) {
            return;
        }
        try {
            if (!ctx.session.data.matchResult) {
                return res.status(400).json({ error: 'Confirm character matches first.' });
            }
            const plan = buildImportPlan(ctx.session.data.parsed, ctx.session.data.matchResult);
            ctx.session.data.plan = plan;
            ctx.session.data.step = 'plan';
            return res.json({
                summary: plan.summary,
                items: plan.items.map((item) => ({
                    clusterId: item.clusterId,
                    name: item.character.name,
                    matchSource: item.matchSource,
                    matchConfidence: item.matchConfidence,
                    chatCount: item.chatCount,
                    messageCount: item.messageCount,
                    include: item.include,
                    firstMesPreview: String(item.character.first_mes || '').slice(0, 160),
                    hasDefinition: !!item.character.personality,
                    hasAvatar: !!item.character.avatarImage,
                })),
            });
        } catch (error) {
            console.error('[migration-assistant] plan failed:', error.message);
            return res.status(500).json({ error: 'Could not build import plan.' });
        }
    });

    router.post('/session/:sessionId/import', jsonParser, (req, res) => {
        const ctx = requireSession(req, res);
        if (!ctx) {
            return;
        }
        try {
            if (!ctx.session.data.plan) {
                return res.status(400).json({ error: 'Build an import plan first.' });
            }
            const includeClusterIds = Array.isArray(req.body?.includeClusterIds)
                ? req.body.includeClusterIds.map(String).slice(0, 5000)
                : [];

            // Allow toggling include flags before materializing
            if (Array.isArray(req.body?.excludeClusterIds)) {
                const exclude = new Set(req.body.excludeClusterIds.map(String));
                for (const item of ctx.session.data.plan.items) {
                    if (exclude.has(item.clusterId)) {
                        item.include = false;
                    }
                }
            }

            const payloads = materializeImportPayloads(ctx.session.data.plan, { includeClusterIds });
            const staging = stagePayloads(ctx.session.dir, payloads);
            ctx.session.data.step = 'imported';
            ctx.session.data.payloadCount = payloads.length;

            return res.json({
                ok: true,
                count: payloads.length,
                staged: path.basename(staging),
                payloads: payloads.map((p) => ({
                    clusterId: p.clusterId,
                    character: p.character,
                    chats: p.chats,
                    avatarImage: p.avatarImage,
                })),
            });
        } catch (error) {
            console.error('[migration-assistant] import failed:', error.message);
            return res.status(500).json({ error: 'Import materialization failed.' });
        }
    });

    router.delete('/session/:sessionId', (req, res) => {
        const sessionId = String(req.params.sessionId || '');
        destroySession(sessionId);
        return res.sendStatus(204);
    });

    console.log(`[${PLUGIN_ID}] Server plugin loaded`);
    return Promise.resolve();
}

/**
 * Allow only http(s) URLs ending in jpg/png, or null.
 * @param {unknown} value
 * @returns {string|null}
 */
function sanitizeImageRef(value) {
    if (value == null || value === '') {
        return null;
    }
    const str = String(value).trim();
    if (str.length > 6_000_000) {
        return null;
    }
    // data:image/png|jpeg URLs from trusted client search results
    if (/^data:image\/(png|jpeg);base64,[a-z0-9+/=\s]+$/i.test(str)) {
        return str.replace(/\s+/g, '');
    }
    if (str.length > 2048) {
        return null;
    }
    try {
        const url = new URL(str);
        if (url.protocol !== 'http:' && url.protocol !== 'https:') {
            return null;
        }
        if (!/\.(png|jpe?g)$/i.test(url.pathname)) {
            return null;
        }
        return url.toString();
    } catch {
        return null;
    }
}

async function exit() {
    destroyAll();
    console.log(`[${PLUGIN_ID}] Server plugin unloaded`);
    return Promise.resolve();
}

module.exports = {
    init,
    exit,
    info: {
        id: PLUGIN_ID,
        name: 'Migration Assistant',
        description: 'Parses CharacterAI data exports and prepares SillyTavern import payloads.',
    },
};
