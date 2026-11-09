'use strict';

const fs = require('fs');

/**
 * @typedef {Object} CaiMessage
 * @property {string} chat_id
 * @property {string} candidate_id
 * @property {string} raw_content
 * @property {string} create_time
 * @property {string|null} [tti_image_rel_path]
 */

/**
 * @typedef {'bot'|'user'|'unknown'} SpeakerRole
 */

/**
 * @param {string} filePath
 * @returns {any}
 */
function readJsonFile(filePath) {
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
}

/**
 * Heuristic speaker role for a message inside an already-sorted chat.
 * Rules from DESIGN.md:
 *  - first message is always the greeting (bot)
 *  - candidate_id starting with "cmpl-" is a bot candidate
 *  - otherwise alternate user/bot after the greeting
 * @param {CaiMessage} message
 * @param {number} index
 * @param {SpeakerRole} [prevRole]
 * @returns {SpeakerRole}
 */
function detectRole(message, index, prevRole) {
    if (index === 0) {
        return 'bot';
    }
    const candidate = String(message.candidate_id || '');
    if (candidate.startsWith('cmpl-')) {
        return 'bot';
    }
    if (prevRole === 'bot') {
        return 'user';
    }
    if (prevRole === 'user') {
        return 'bot';
    }
    return index % 2 === 0 ? 'bot' : 'user';
}

/**
 * Normalize greeting text for matching.
 * @param {string} text
 * @returns {string}
 */
function normalizeGreeting(text) {
    return String(text || '')
        .replace(/\r\n/g, '\n')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
}

/**
 * Parse message.json and optional character.json into collated chats and character records.
 * @param {string} messagesPath
 * @param {string|null} charactersPath
 * @param {string|null} userPath
 */
const MAX_MESSAGES = 500_000;
const MAX_CHARACTERS = 50_000;
const MAX_CHATS = 50_000;

function parseExport(messagesPath, charactersPath, userPath) {
    /** @type {CaiMessage[]} */
    const messages = readJsonFile(messagesPath);
    const characters = charactersPath ? readJsonFile(charactersPath) : [];
    const user = userPath && fs.existsSync(userPath) ? readJsonFile(userPath) : null;

    if (!Array.isArray(messages)) {
        throw new Error('message.json must be an array.');
    }
    if (!Array.isArray(characters)) {
        throw new Error('character.json must be an array.');
    }
    if (messages.length > MAX_MESSAGES) {
        throw new Error('message.json exceeds supported message count.');
    }
    if (characters.length > MAX_CHARACTERS) {
        throw new Error('character.json exceeds supported character count.');
    }

    /** @type {Map<string, CaiMessage[]>} */
    const byChat = new Map();
    for (const msg of messages) {
        if (!msg || typeof msg !== 'object' || !msg.chat_id) {
            continue;
        }
        const list = byChat.get(msg.chat_id) || [];
        list.push(msg);
        byChat.set(msg.chat_id, list);
    }

    const chats = [];
    for (const [chatId, list] of byChat.entries()) {
        const sorted = list.slice().sort((a, b) => String(a.create_time).localeCompare(String(b.create_time)));
        /** @type {SpeakerRole} */
        let prevRole = 'unknown';
        const annotated = sorted.map((msg, index) => {
            const role = detectRole(msg, index, prevRole);
            prevRole = role;
            return {
                index,
                candidate_id: msg.candidate_id,
                raw_content: msg.raw_content || '',
                create_time: msg.create_time,
                tti_image_rel_path: msg.tti_image_rel_path ?? null,
                role,
                roleSource: index === 0
                    ? 'greeting'
                    : String(msg.candidate_id || '').startsWith('cmpl-')
                        ? 'cmpl'
                        : 'alternate',
            };
        });

        const greeting = annotated[0]?.raw_content || '';
        chats.push({
            chatId,
            messageCount: annotated.length,
            startedAt: annotated[0]?.create_time || null,
            endedAt: annotated[annotated.length - 1]?.create_time || null,
            greeting,
            greetingKey: normalizeGreeting(greeting),
            messages: annotated,
            skip: false,
            characterKey: null,
        });
    }

    if (chats.length > MAX_CHATS) {
        throw new Error('Export exceeds supported chat count.');
    }

    chats.sort((a, b) => String(a.startedAt || '').localeCompare(String(b.startedAt || '')));

    const characterRecords = characters.map((char, idx) => ({
        key: `export-${idx}`,
        source: 'export',
        name: String(char.name || char.title || `Character ${idx + 1}`).trim(),
        title: char.title || null,
        description: char.description || '',
        greeting: char.greeting || '',
        greetingKey: normalizeGreeting(char.greeting || ''),
        definition: char.definition || '',
        created: char.created || null,
        updated: char.updated || null,
        baseImgPrompt: char.base_img_prompt || null,
    }));

    return {
        user: user
            ? {
                username: user.username || null,
                firstName: user.first_name || null,
                lastName: user.last_name || null,
            }
            : null,
        stats: {
            messageCount: messages.length,
            chatCount: chats.length,
            characterCount: characterRecords.length,
        },
        characters: characterRecords,
        chats,
    };
}

/**
 * Apply manual role / skip overrides from the client.
 * @param {object} parsed
 * @param {Array<{chatId: string, skip?: boolean, roles?: Array<{index: number, role: SpeakerRole}>}>} overrides
 */
function applyChatOverrides(parsed, overrides) {
    if (!Array.isArray(overrides)) {
        return parsed;
    }
    const byId = new Map(parsed.chats.map((c) => [c.chatId, c]));
    for (const item of overrides) {
        const chat = byId.get(item.chatId);
        if (!chat) {
            continue;
        }
        if (typeof item.skip === 'boolean') {
            chat.skip = item.skip;
        }
        if (Array.isArray(item.roles)) {
            for (const roleOverride of item.roles) {
                const msg = chat.messages[roleOverride.index];
                if (!msg) {
                    continue;
                }
                if (roleOverride.role === 'bot' || roleOverride.role === 'user') {
                    msg.role = roleOverride.role;
                    msg.roleSource = 'manual';
                }
            }
        }
    }
    return parsed;
}

module.exports = {
    parseExport,
    applyChatOverrides,
    normalizeGreeting,
    detectRole,
};
