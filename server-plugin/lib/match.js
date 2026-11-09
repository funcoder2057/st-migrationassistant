'use strict';

const { normalizeGreeting } = require('./parse');

/**
 * Group chats that share a greeting and match them against export characters.
 * @param {object} parsed parseExport result
 */
function buildCharacterClusters(parsed) {
    /** @type {Map<string, object>} */
    const clusters = new Map();

    for (const chat of parsed.chats) {
        if (chat.skip) {
            continue;
        }
        const key = chat.greetingKey || `empty:${chat.chatId}`;
        if (!clusters.has(key)) {
            clusters.set(key, {
                clusterId: `cluster-${clusters.size + 1}`,
                greetingKey: key,
                greeting: chat.greeting,
                chatIds: [],
                messageCount: 0,
                match: null,
                matchSource: 'none',
                matchConfidence: 0,
                needsSearch: true,
                overrides: null,
            });
        }
        const cluster = clusters.get(key);
        cluster.chatIds.push(chat.chatId);
        cluster.messageCount += chat.messageCount;
        chat.characterKey = cluster.clusterId;
    }

    // Exact greeting match against characters from the export
    const byGreeting = new Map();
    for (const character of parsed.characters) {
        if (!character.greetingKey) {
            continue;
        }
        if (!byGreeting.has(character.greetingKey)) {
            byGreeting.set(character.greetingKey, []);
        }
        byGreeting.get(character.greetingKey).push(character);
    }

    for (const cluster of clusters.values()) {
        const hits = byGreeting.get(cluster.greetingKey) || [];
        if (hits.length === 1) {
            cluster.match = { ...hits[0] };
            cluster.matchSource = 'export-exact';
            cluster.matchConfidence = 1;
            cluster.needsSearch = false;
        } else if (hits.length > 1) {
            // Prefer the most recently updated export character when greetings collide
            const sorted = hits.slice().sort((a, b) => String(b.updated || '').localeCompare(String(a.updated || '')));
            cluster.match = { ...sorted[0] };
            cluster.candidates = sorted;
            cluster.matchSource = 'export-ambiguous';
            cluster.matchConfidence = 0.6;
            cluster.needsSearch = false;
        } else {
            // Soft match: greeting prefix / containment against export characters
            const soft = softMatchExport(cluster.greeting, parsed.characters);
            if (soft) {
                cluster.match = { ...soft.character };
                cluster.matchSource = 'export-soft';
                cluster.matchConfidence = soft.score;
                cluster.needsSearch = soft.score < 0.85;
            }
        }
    }

    const list = [...clusters.values()].sort((a, b) => b.messageCount - a.messageCount);
    return {
        clusters: list,
        summary: {
            total: list.length,
            matchedExport: list.filter((c) => c.matchSource.startsWith('export')).length,
            needsSearch: list.filter((c) => c.needsSearch).length,
            skippedChats: parsed.chats.filter((c) => c.skip).length,
        },
    };
}

/**
 * @param {string} greeting
 * @param {object[]} characters
 * @returns {{character: object, score: number}|null}
 */
function softMatchExport(greeting, characters) {
    const needle = normalizeGreeting(greeting);
    if (!needle || needle.length < 12) {
        return null;
    }

    let best = null;
    for (const character of characters) {
        const hay = character.greetingKey;
        if (!hay) {
            continue;
        }
        let score = 0;
        if (hay === needle) {
            score = 1;
        } else if (hay.startsWith(needle.slice(0, Math.min(80, needle.length))) || needle.startsWith(hay.slice(0, Math.min(80, hay.length)))) {
            score = 0.75;
        } else if (hay.includes(needle.slice(0, 48)) || needle.includes(hay.slice(0, 48))) {
            score = 0.55;
        }
        if (score > 0 && (!best || score > best.score)) {
            best = { character, score };
        }
    }
    return best;
}

/**
 * Apply user overrides for cluster → character assignments.
 * @param {object} matchResult
 * @param {Array<{clusterId: string, action: 'keep'|'replace'|'skip'|'manual', character?: object}>} overrides
 */
function applyMatchOverrides(matchResult, overrides) {
    if (!Array.isArray(overrides)) {
        return matchResult;
    }
    const byId = new Map(matchResult.clusters.map((c) => [c.clusterId, c]));
    for (const item of overrides) {
        const cluster = byId.get(item.clusterId);
        if (!cluster) {
            continue;
        }
        if (item.action === 'skip') {
            cluster.skipImport = true;
            cluster.overrides = item;
            continue;
        }
        if (item.action === 'replace' || item.action === 'manual') {
            if (item.character && typeof item.character === 'object') {
                cluster.match = {
                    key: item.character.key || `manual-${cluster.clusterId}`,
                    source: item.character.source || 'manual',
                    name: String(item.character.name || 'Unnamed').trim(),
                    title: item.character.title || null,
                    description: item.character.description || '',
                    greeting: item.character.greeting || cluster.greeting,
                    greetingKey: normalizeGreeting(item.character.greeting || cluster.greeting),
                    definition: item.character.definition || '',
                    imageUrl: item.character.imageUrl || null,
                };
                cluster.matchSource = item.action === 'manual' ? 'manual' : 'user-replace';
                cluster.matchConfidence = 1;
                cluster.needsSearch = false;
                cluster.skipImport = false;
                cluster.overrides = item;
            }
        }
        if (item.action === 'keep') {
            cluster.skipImport = false;
            cluster.needsSearch = false;
            cluster.overrides = item;
        }
    }
    return matchResult;
}

/**
 * Build ST-oriented import plan from matched clusters + chats.
 * @param {object} parsed
 * @param {object} matchResult
 */
function buildImportPlan(parsed, matchResult) {
    const chatById = new Map(parsed.chats.map((c) => [c.chatId, c]));
    const plan = [];

    for (const cluster of matchResult.clusters) {
        if (cluster.skipImport) {
            continue;
        }
        const character = cluster.match || {
            key: `greeting-only-${cluster.clusterId}`,
            source: 'greeting-only',
            name: deriveNameFromGreeting(cluster.greeting),
            description: '',
            greeting: cluster.greeting,
            definition: '',
        };

        const chats = cluster.chatIds
            .map((id) => chatById.get(id))
            .filter((c) => c && !c.skip)
            .map((c) => ({
                chatId: c.chatId,
                messageCount: c.messageCount,
                startedAt: c.startedAt,
                endedAt: c.endedAt,
                messages: c.messages.map((m) => ({
                    role: m.role,
                    mes: m.raw_content,
                    create_time: m.create_time,
                    candidate_id: m.candidate_id,
                })),
            }));

        plan.push({
            clusterId: cluster.clusterId,
            matchSource: cluster.matchSource,
            matchConfidence: cluster.matchConfidence,
            character: {
                name: character.name,
                description: character.description || '',
                first_mes: character.greeting || cluster.greeting,
                personality: character.definition || '',
                scenario: '',
                mes_example: '',
                creatornotes: `Migrated from CharacterAI via Migration Assistant (${character.source || cluster.matchSource})`,
                avatarImage: character.imageUrl || null,
            },
            chats,
            chatCount: chats.length,
            messageCount: chats.reduce((n, c) => n + c.messageCount, 0),
            include: true,
        });
    }

    return {
        items: plan,
        summary: {
            characters: plan.length,
            chats: plan.reduce((n, i) => n + i.chatCount, 0),
            messages: plan.reduce((n, i) => n + i.messageCount, 0),
        },
    };
}

/**
 * @param {string} greeting
 * @returns {string}
 */
function deriveNameFromGreeting(greeting) {
    const text = String(greeting || '').replace(/\s+/g, ' ').trim();
    if (!text) {
        return 'Unknown Character';
    }
    const nameMatch = text.match(/\b(?:named|name is|I(?:'|’)?m|I am)\s+([A-Z][A-Za-z0-9_\-]{1,30})/);
    if (nameMatch) {
        return nameMatch[1];
    }
    return text.slice(0, 42) + (text.length > 42 ? '…' : '');
}

module.exports = {
    buildCharacterClusters,
    applyMatchOverrides,
    buildImportPlan,
};
