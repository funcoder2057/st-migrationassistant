'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Sanitize a filename segment for chat exports.
 * @param {string} name
 * @returns {string}
 */
function safeFileStem(name) {
    return String(name || 'character')
        .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 80) || 'character';
}

/**
 * Convert Migration Assistant plan items into SillyTavern-friendly payloads.
 * Does not write into SillyTavern user directories directly — returns data
 * for the UI extension to import through official ST APIs.
 * @param {object} plan buildImportPlan result
 * @param {object} [options]
 * @param {string[]} [options.includeClusterIds]
 */
function materializeImportPayloads(plan, options = {}) {
    const include = Array.isArray(options.includeClusterIds) && options.includeClusterIds.length
        ? new Set(options.includeClusterIds)
        : null;

    const payloads = [];
    for (const item of plan.items) {
        if (item.include === false) {
            continue;
        }
        if (include && !include.has(item.clusterId)) {
            continue;
        }

        const character = {
            name: String(item.character.name || 'Unnamed').slice(0, 120),
            description: String(item.character.description || ''),
            personality: String(item.character.personality || ''),
            first_mes: String(item.character.first_mes || ''),
            scenario: String(item.character.scenario || ''),
            mes_example: String(item.character.mes_example || ''),
            creatorcomment: String(item.character.creatornotes || ''),
            avatar: 'none',
            chat: safeFileStem(item.character.name),
            fav: false,
            data: {
                name: String(item.character.name || 'Unnamed').slice(0, 120),
                description: String(item.character.description || ''),
                personality: String(item.character.personality || ''),
                first_mes: String(item.character.first_mes || ''),
                scenario: String(item.character.scenario || ''),
                mes_example: String(item.character.mes_example || ''),
                creator_notes: String(item.character.creatornotes || ''),
                system_prompt: '',
                post_history_instructions: '',
                tags: ['migrated', 'characterai'],
                creator: 'Migration Assistant',
                character_version: 'cai-migrate-1',
                extensions: {
                    migration_assistant: {
                        clusterId: item.clusterId,
                        matchSource: item.matchSource,
                    },
                },
            },
        };

        const chats = item.chats.map((chat) => {
            const lines = chat.messages.map((m, idx) => {
                const isUser = m.role === 'user';
                return {
                    name: isUser ? 'User' : character.name,
                    is_user: isUser,
                    is_system: false,
                    send_date: m.create_time || new Date().toISOString(),
                    mes: String(m.mes || ''),
                    extra: {
                        cai_candidate_id: m.candidate_id || null,
                        cai_chat_id: chat.chatId,
                        isSmallSys: false,
                    },
                    ...(idx === 0 && !isUser ? { is_name: true } : {}),
                };
            });
            return {
                chatId: chat.chatId,
                fileStem: `${safeFileStem(character.name)} - ${chat.chatId.slice(0, 8)}`,
                messages: lines,
            };
        });

        payloads.push({
            clusterId: item.clusterId,
            character,
            chats,
            avatarImage: item.character.avatarImage || null,
        });
    }

    return payloads;
}

/**
 * Optionally stage JSON payloads into the session directory for download/debug.
 * @param {string} sessionDir
 * @param {object[]} payloads
 * @returns {string} staging directory path
 */
function stagePayloads(sessionDir, payloads) {
    const staging = path.join(sessionDir, 'staging');
    fs.mkdirSync(staging, { recursive: true });

    const resolvedStaging = path.resolve(staging);
    for (const payload of payloads) {
        const folder = path.resolve(staging, safeFileStem(payload.character.name) + '_' + payload.clusterId);
        const rel = path.relative(resolvedStaging, folder);
        if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
            throw new Error('Refusing to write outside staging directory.');
        }
        fs.mkdirSync(folder, { recursive: true });
        fs.writeFileSync(path.join(folder, 'character.json'), JSON.stringify(payload.character, null, 2), 'utf8');
        payload.chats.forEach((chat, idx) => {
            const chatPath = path.join(folder, `chat_${idx + 1}.jsonl`);
            const body = chat.messages.map((m) => JSON.stringify(m)).join('\n');
            fs.writeFileSync(chatPath, body, 'utf8');
        });
    }

    fs.writeFileSync(path.join(staging, 'manifest.json'), JSON.stringify({
        createdAt: new Date().toISOString(),
        count: payloads.length,
        clusters: payloads.map((p) => p.clusterId),
    }, null, 2), 'utf8');

    return staging;
}

module.exports = {
    materializeImportPayloads,
    stagePayloads,
    safeFileStem,
};
