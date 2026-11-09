'use strict';

const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');

const ALLOWED_ROOT_FILES = new Set([
    'message.json',
    'messages.json',
    'character.json',
    'user.json',
]);

const MAX_UNCOMPRESSED_BYTES = 512 * 1024 * 1024; // 512 MB
const MAX_ENTRIES = 20000;

/**
 * Normalize zip entry paths and reject zip-slip / absolute paths.
 * @param {string} entryName
 * @returns {string|null} normalized relative path or null if invalid
 */
function safeEntryPath(entryName) {
    if (!entryName || typeof entryName !== 'string') {
        return null;
    }
    const normalized = entryName.replace(/\\/g, '/');
    if (normalized.includes('\0')) {
        return null;
    }
    if (path.isAbsolute(normalized) || /^[a-zA-Z]:/.test(normalized)) {
        return null;
    }
    const parts = normalized.split('/').filter(Boolean);
    if (parts.some((p) => p === '..')) {
        return null;
    }
    return parts.join('/');
}

/**
 * Map a zip-relative path to one of the expected CAI export locations.
 * Accepts both flat and nested layouts (e.g. Username/data/message.json).
 * @param {string} rel
 * @returns {{kind: 'data'|'image'|'skip', name: string}|null}
 */
function classifyEntry(rel) {
    const lower = rel.toLowerCase();
    const base = path.posix.basename(lower);

    if (ALLOWED_ROOT_FILES.has(base) && (lower.endsWith(`/data/${base}`) || lower === base || lower.endsWith(`/${base}`))) {
        return { kind: 'data', name: base === 'messages.json' ? 'message.json' : base };
    }

    if (lower.includes('/images/') || lower.startsWith('images/')) {
        if (!/\.(png|jpe?g|webp|gif)$/i.test(base)) {
            return { kind: 'skip', name: base };
        }
        return { kind: 'image', name: path.posix.basename(rel) };
    }

    return { kind: 'skip', name: base };
}

/**
 * Extract a CharacterAI export zip into the session directory.
 * @param {string|Buffer} zipInput
 * @param {string} targetDir
 * @returns {{files: {messages: string, characters: string|null, user: string|null}, imageCount: number}}
 */
function extractExportZip(zipInput, targetDir) {
    const zip = new AdmZip(zipInput);
    const entries = zip.getEntries();

    if (entries.length > MAX_ENTRIES) {
        throw new Error('Archive has too many entries.');
    }

    let uncompressed = 0;
    const dataDir = path.join(targetDir, 'data');
    const imagesDir = path.join(targetDir, 'images');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.mkdirSync(imagesDir, { recursive: true });

    /** @type {Record<string, string>} */
    const found = {};
    let imageCount = 0;

    for (const entry of entries) {
        if (entry.isDirectory) {
            continue;
        }

        const rel = safeEntryPath(entry.entryName);
        if (!rel) {
            throw new Error(`Blocked unsafe archive path: ${entry.entryName}`);
        }

        const size = entry.header?.size ?? 0;
        uncompressed += size;
        if (uncompressed > MAX_UNCOMPRESSED_BYTES) {
            throw new Error('Archive exceeds uncompressed size limit.');
        }

        const classified = classifyEntry(rel);
        if (!classified || classified.kind === 'skip') {
            continue;
        }

        const data = entry.getData();
        if (classified.kind === 'data') {
            const outPath = path.join(dataDir, classified.name);
            fs.writeFileSync(outPath, data);
            found[classified.name] = outPath;
        } else if (classified.kind === 'image') {
            const safeName = classified.name.replace(/[^\w.\-()+]/g, '_');
            fs.writeFileSync(path.join(imagesDir, safeName), data);
            imageCount += 1;
        }
    }

    if (!found['message.json']) {
        throw new Error('message.json not found in archive.');
    }

    return {
        files: {
            messages: found['message.json'],
            characters: found['character.json'] || null,
            user: found['user.json'] || null,
        },
        imageCount,
    };
}

module.exports = {
    extractExportZip,
    safeEntryPath,
};
