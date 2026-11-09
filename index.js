import { searchCharactersByGreeting, searchCharactersByQuery } from './api.js';
import { getUserAvatars, initPersona } from '../../../../scripts/personas.js';
import { getRequestHeaders } from '../../../../script.js';

const MODULE_NAME = 'st-migrationasst';
const PLUGIN_ID = 'migration-assistant';
const PLUGIN_BASE = `/api/plugins/${PLUGIN_ID}`;
const EXTENSION_FOLDER = `scripts/extensions/third-party/${MODULE_NAME}`;

const STEPS = ['upload', 'chats', 'match', 'search', 'import', 'profiles'];
const THEME_STORAGE_KEY = 'migasst-theme-v2';

const STEP_META = {
    upload: { title: 'Drop your export', next: 'Continue' },
    chats: { title: 'Review sorted chats', next: 'Confirm chats' },
    match: { title: 'Confirm character clusters', next: 'Continue to search' },
    search: { title: 'Fill missing characters', next: 'Build import plan' },
    import: { title: 'Complete import', next: 'Import chats' },
    profiles: { title: 'Optional profiles', next: 'Finish' },
};

/** @type {{sessionId: string|null, step: string, chats: any[], characters: any[], clusters: any[], planItems: any[], chatOverrides: Map<string, any>, matchOverrides: Map<string, any>, stats: any}} */
const state = {
    sessionId: null,
    step: 'upload',
    chats: [],
    characters: [],
    clusters: [],
    planItems: [],
    chatOverrides: new Map(),
    matchOverrides: new Map(),
    stats: null,
    openChatId: null,
    /** @type {Map<string, object>} */
    searchHits: new Map(),
    profiles: [],
    profilesImported: false,
    importCompleted: false,
};

function getContext() {
    return SillyTavern.getContext();
}

function escapeHtml(text) {
    return String(text ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function boundedText(value, maxLength = 20000) {
    return typeof value === 'string' ? value.slice(0, maxLength) : '';
}

function normalizeCardData(value) {
    const source = value?.data && typeof value.data === 'object' ? value.data : value;
    if (!source || typeof source !== 'object' || Array.isArray(source)) {
        throw new Error('Character card data must be a JSON object.');
    }
    const userName = [source.first_name, source.last_name].filter((part) => typeof part === 'string').join(' ').trim();
    const card = {
        name: boundedText(source.name || source.char_name || source.username || userName || value.name, 120).trim(),
        description: boundedText(source.description || source.char_persona || source.persona_description, 20000),
        greeting: boundedText(source.first_mes || source.greeting || source.char_greeting, 20000),
        definition: boundedText(source.personality || source.definition, 100000),
        scenario: boundedText(source.scenario || source.world_scenario, 20000),
        mes_example: boundedText(source.mes_example || source.example_dialogue, 20000),
        creator_notes: boundedText(source.creator_notes || source.creatorcomment || source.creatornotes, 20000),
    };
    if (!card.name) {
        throw new Error('This file does not contain a character name.');
    }
    return card;
}

async function decodeCardMetadata(file) {
    if (file.size > 25 * 1024 * 1024) {
        throw new Error('Character card files must be smaller than 25 MB.');
    }
    if (file.name.toLowerCase().endsWith('.json')) {
        return normalizeCardData(JSON.parse(await file.text()));
    }
    if (file.type !== 'image/png' && !file.name.toLowerCase().endsWith('.png')) {
        throw new Error('Choose a PNG character card or a character JSON file.');
    }

    const bytes = new Uint8Array(await file.arrayBuffer());
    const signature = [137, 80, 78, 71, 13, 10, 26, 10];
    if (bytes.length < 8 || signature.some((byte, index) => bytes[index] !== byte)) {
        throw new Error('This file is not a valid PNG image.');
    }

    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let offset = 8;
    let encodedCard = '';
    let chunkCount = 0;
    while (offset + 12 <= bytes.length && chunkCount < 4096) {
        const length = view.getUint32(offset);
        const type = new TextDecoder().decode(bytes.subarray(offset + 4, offset + 8));
        const start = offset + 8;
        const end = start + length;
        if (length > 8 * 1024 * 1024 || end + 4 > bytes.length) {
            throw new Error('PNG contains an invalid or oversized metadata chunk.');
        }
        const chunk = bytes.subarray(start, end);
        if (type === 'tEXt') {
            const separator = chunk.indexOf(0);
            if (separator > 0 && new TextDecoder('latin1').decode(chunk.subarray(0, separator)).toLowerCase() === 'chara') {
                encodedCard = new TextDecoder('latin1').decode(chunk.subarray(separator + 1));
            }
        } else if (type === 'iTXt') {
            const separator = chunk.indexOf(0);
            if (separator > 0 && new TextDecoder('latin1').decode(chunk.subarray(0, separator)).toLowerCase() === 'chara') {
                const compressionFlag = chunk[separator + 1];
                let textStart = separator + 3;
                for (let field = 0; field < 2; field += 1) {
                    const nextSeparator = chunk.indexOf(0, textStart);
                    if (nextSeparator < 0) {
                        textStart = chunk.length;
                        break;
                    }
                    textStart = nextSeparator + 1;
                }
                let textBytes = chunk.subarray(textStart);
                if (compressionFlag === 1) {
                    if (typeof DecompressionStream === 'undefined') {
                        throw new Error('This browser cannot read compressed PNG card metadata.');
                    }
                    const stream = new Blob([textBytes]).stream().pipeThrough(new DecompressionStream('deflate'));
                    textBytes = await readStreamLimited(stream, 2 * 1024 * 1024);
                }
                encodedCard = new TextDecoder().decode(textBytes);
            }
        }
        offset = end + 4;
        chunkCount += 1;
        if (type === 'IEND') {
            break;
        }
    }
    if (chunkCount >= 4096) {
        throw new Error('PNG contains too many metadata chunks.');
    }
    if (!encodedCard || encodedCard.length > 2 * 1024 * 1024) {
        throw new Error('No supported SillyTavern character card metadata was found in this PNG.');
    }
    const binary = atob(encodedCard.replace(/\s+/g, ''));
    const cardBytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return normalizeCardData(JSON.parse(new TextDecoder().decode(cardBytes)));
}

function readAsDataUrl(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(new Error(`Could not read ${file.name}.`));
        reader.readAsDataURL(file);
    });
}

function safeCardPayload(card) {
    const clean = normalizeCardData(card);
    return {
        spec: 'chara_card_v2',
        spec_version: '2.0',
        data: {
            name: clean.name,
            description: clean.description,
            personality: clean.definition,
            first_mes: clean.greeting,
            scenario: clean.scenario,
            mes_example: clean.mes_example,
            creator_notes: clean.creator_notes,
            system_prompt: '',
            post_history_instructions: '',
            tags: [],
            creator: 'Migration Assistant',
            character_version: '1.0',
            extensions: {},
        },
    };
}

function safeUploadName(value) {
    return String(value || 'character')
        .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 80) || 'character';
}

async function readStreamLimited(stream, maxBytes) {
    const reader = stream.getReader();
    const chunks = [];
    let size = 0;
    while (true) {
        const { done, value } = await reader.read();
        if (done) {
            break;
        }
        size += value.byteLength;
        if (size > maxBytes) {
            await reader.cancel();
            throw new Error('PNG character card metadata is too large.');
        }
        chunks.push(value);
    }
    const output = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
        output.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return output;
}

async function apiFetch(path, options = {}) {
    const opts = { ...options };
    opts.headers = { ...(options.headers || {}) };
    if (opts.body && !(opts.body instanceof FormData)) {
        opts.headers['Content-Type'] = 'application/json';
        opts.body = JSON.stringify(opts.body);
    }
    const res = await fetch(`${PLUGIN_BASE}${path}`, opts);
    if (!res.ok) {
        let message = `Request failed (${res.status})`;
        try {
            const data = await res.json();
            if (data?.error) {
                message = data.error;
            }
        } catch {
            // ignore
        }
        throw new Error(message);
    }
    if (res.status === 204) {
        return null;
    }
    return res.json();
}

async function probePlugin() {
    try {
        const res = await fetch(`${PLUGIN_BASE}/probe`, { method: 'GET' });
        return res.status === 204 || res.ok;
    } catch {
        return false;
    }
}

function setStatus(el, text, isError = false) {
    if (!el) {
        return;
    }
    el.hidden = !text;
    el.textContent = text || '';
    el.classList.toggle('is-error', !!isError);
}

function ensureAssets() {
    if (!document.getElementById('migasst_font_link')) {
        const preconnect1 = document.createElement('link');
        preconnect1.rel = 'preconnect';
        preconnect1.href = 'https://fonts.googleapis.com';
        const preconnect2 = document.createElement('link');
        preconnect2.rel = 'preconnect';
        preconnect2.href = 'https://fonts.gstatic.com';
        preconnect2.crossOrigin = 'anonymous';
        const font = document.createElement('link');
        font.id = 'migasst_font_link';
        font.rel = 'stylesheet';
        font.href = 'https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600&family=Sora:wght@400;500;600;700&display=swap';
        document.head.append(preconnect1, preconnect2, font);
    }
    const hasStylesheet = Array.from(document.querySelectorAll('link[rel="stylesheet"]')).some((stylesheet) => {
        if (!stylesheet.href) {
            return false;
        }
        return new URL(stylesheet.href).pathname.endsWith(`/${MODULE_NAME}/style.css`);
    });
    if (!hasStylesheet && !document.getElementById('migasst_style_link')) {
        const link = document.createElement('link');
        link.id = 'migasst_style_link';
        link.rel = 'stylesheet';
        link.href = `${EXTENSION_FOLDER}/style.css?v=4`;
        document.head.appendChild(link);
    }
}

function applyTheme(theme) {
    const selected = theme === 'dark' ? 'dark' : 'light';
    document.getElementById('migasst_wizard')?.setAttribute('data-theme', selected);
    document.getElementById('migration_assistant_settings')?.setAttribute('data-theme', selected);
    const toggle = document.getElementById('migasst_theme_toggle');
    if (toggle) {
        toggle.checked = selected === 'dark';
        toggle.setAttribute('aria-checked', String(toggle.checked));
    }
    const label = document.getElementById('migasst_theme_label');
    if (label) {
        label.textContent = selected === 'dark' ? 'Dark mode' : 'Light mode';
    }
    localStorage.setItem(THEME_STORAGE_KEY, selected);
}

function initializeTheme() {
    applyTheme(localStorage.getItem(THEME_STORAGE_KEY) || 'dark');
}

function openWizard() {
    const wizard = document.getElementById('migasst_wizard');
    if (!wizard) {
        return;
    }
    wizard.hidden = false;
    wizard.classList.add('is-open');
    document.body.style.overflow = 'hidden';
    goToStep(state.sessionId ? state.step : 'upload');
}

function closeWizard() {
    const wizard = document.getElementById('migasst_wizard');
    if (wizard) {
        wizard.classList.remove('is-open');
        wizard.hidden = true;
    }
    document.body.style.overflow = '';
}

function setNextLabel(label) {
    const next = document.getElementById('migasst_next');
    if (!next) {
        return;
    }
    const span = next.querySelector('span');
    if (span) {
        span.textContent = label;
    } else {
        next.textContent = label;
    }
}

function goToStep(step) {
    if (!STEPS.includes(step)) {
        return;
    }
    state.step = step;
    const current = STEPS.indexOf(step);

    document.querySelectorAll('#migasst_wizard .migasst-panel').forEach((panel) => {
        panel.classList.toggle('is-visible', panel.dataset.panel === step);
    });

    document.querySelectorAll('#migasst_wizard .migasst-step').forEach((item) => {
        const key = item.dataset.step;
        const idx = STEPS.indexOf(key);
        item.classList.toggle('is-active', key === step);
        item.classList.toggle('is-done', idx < current);
        const btn = item.querySelector('.migasst-step-btn');
        if (!btn) {
            return;
        }
        if (!state.sessionId && key !== 'upload') {
            btn.disabled = true;
        } else {
            btn.disabled = idx > current;
        }
    });

    const phase = document.getElementById('migasst_phase_label');
    const heading = document.getElementById('migasst_heading');
    if (phase) {
        phase.textContent = `Step ${current + 1} of ${STEPS.length}`;
    }
    if (heading) {
        heading.textContent = STEP_META[step]?.title || step;
    }

    const back = document.getElementById('migasst_back');
    const next = document.getElementById('migasst_next');
    const danger = document.getElementById('migasst_danger');
    if (back) {
        back.disabled = step === 'upload';
    }
    if (danger) {
        danger.hidden = !state.sessionId;
    }
    if (next) {
        next.disabled = step === 'upload' ? !state.sessionId : false;
        const label = step === 'profiles'
            ? (state.profilesImported ? 'Done' : state.profiles.some((profile) => profile.include && profile.type) ? 'Import selected profiles' : 'Skip & finish')
            : step === 'import' && state.importCompleted
                ? 'Continue to optional stage'
                : STEP_META[step]?.next || 'Continue';
        setNextLabel(label);
    }
}

async function handleUpload(file) {
    const status = document.getElementById('migasst_upload_status');
    if (!file) {
        return;
    }
    const fileName = String(file.name || '').toLowerCase();
    const isZip = fileName.endsWith('.zip');
    const isJson = fileName.endsWith('.json');
    if (!isZip && !isJson) {
        setStatus(status, 'Choose an export .zip or message .json file.', true);
        return;
    }
    setStatus(status, isZip ? 'Uploading and parsing export…' : 'Uploading and parsing messages…');
    const form = new FormData();
    form.append('export', file, file.name);
    try {
        const data = await apiFetch('/upload', { method: 'POST', body: form });
        state.sessionId = data.sessionId;
        state.chats = data.chats || [];
        state.characters = data.characters || [];
        state.stats = data.stats || null;
        state.chatOverrides = new Map();
        state.matchOverrides = new Map();
        const characterLabel = data.stats?.characterCount
            ? ` · ${data.stats.characterCount} export characters`
            : ' · no character data (you can add cards later)';
        setStatus(status, `Parsed ${data.stats?.chatCount ?? 0} chats · ${data.stats?.messageCount ?? 0} messages${characterLabel}.`);
        renderChatList();
        goToStep('chats');
    } catch (error) {
        setStatus(status, error.message || 'Upload failed.', true);
    }
}

function renderChatList() {
    const list = document.getElementById('migasst_chat_list');
    const stats = document.getElementById('migasst_chat_stats');
    const filter = String(document.getElementById('migasst_chat_filter')?.value || '').toLowerCase();
    if (!list) {
        return;
    }
    const rows = state.chats.filter((c) => {
        if (!filter) {
            return true;
        }
        return `${c.greetingPreview} ${c.chatId}`.toLowerCase().includes(filter);
    });
    if (stats) {
        const skipped = state.chats.filter((c) => c.skip).length;
        stats.textContent = `${state.chats.length} chats · ${skipped} skipped · showing ${rows.length}`;
    }
    if (!rows.length) {
        list.innerHTML = '<div class="migasst-empty">No chats match this filter.</div>';
        return;
    }
    list.innerHTML = rows.map((chat, i) => {
        const override = state.chatOverrides.get(chat.chatId);
        const skipped = override?.skip ?? chat.skip;
        return `
        <article class="migasst-card ${skipped ? 'is-skipped' : ''}" role="listitem" data-chat-id="${escapeHtml(chat.chatId)}" style="animation-delay:${Math.min(i, 12) * 28}ms">
            <div class="migasst-card-body">
                <p class="migasst-card-title">
                    <span class="migasst-badge">${escapeHtml(String(chat.messageCount))} msgs</span>
                    ${escapeHtml((chat.startedAt || '').slice(0, 19) || 'Unknown start')}
                </p>
                <p class="migasst-card-meta">${escapeHtml(chat.chatId)} · bot ${chat.roleSummary?.bot ?? 0} / user ${chat.roleSummary?.user ?? 0}</p>
                <p class="migasst-card-preview">${escapeHtml(chat.greetingPreview || '(empty greeting)')}</p>
            </div>
            <div class="migasst-card-actions">
                <button type="button" class="migasst-btn migasst-btn-ghost migasst-btn-small" data-action="inspect">Inspect</button>
                <button type="button" class="migasst-btn migasst-btn-danger migasst-btn-small" data-action="toggle-skip">${skipped ? 'Unskip' : 'Skip'}</button>
            </div>
        </article>`;
    }).join('');
}

async function openChatDrawer(chatId) {
    const drawer = document.getElementById('migasst_chat_drawer');
    const title = document.getElementById('migasst_chat_drawer_title');
    const msgList = document.getElementById('migasst_msg_list');
    if (!drawer || !msgList || !state.sessionId) {
        return;
    }
    state.openChatId = chatId;
    drawer.hidden = false;
    if (title) {
        title.textContent = `Chat ${chatId.slice(0, 8)}…`;
    }
    msgList.innerHTML = '<p class="migasst-row-meta">Loading…</p>';
    try {
        const data = await apiFetch(`/session/${state.sessionId}/chat/${encodeURIComponent(chatId)}`);
        const override = state.chatOverrides.get(chatId);
        const roleMap = new Map((override?.roles || []).map((r) => [r.index, r.role]));
        msgList.innerHTML = (data.chat?.messages || []).map((m) => {
            const role = roleMap.get(m.index) || m.role;
            return `
            <div class="migasst-msg ${role === 'bot' ? 'is-bot' : 'is-user'}" data-index="${m.index}">
                <div class="migasst-msg-top">
                    <span>${escapeHtml(role)} · ${escapeHtml(m.roleSource || '')}</span>
                    <button type="button" class="migasst-btn migasst-btn-danger migasst-btn-small" data-action="flip-role">Flip role</button>
                </div>
                <div class="migasst-msg-body">${escapeHtml(m.raw_content)}</div>
            </div>`;
        }).join('');
    } catch (error) {
        msgList.innerHTML = `<p class="migasst-status is-error">${escapeHtml(error.message)}</p>`;
    }
}

function flipMessageRole(index) {
    if (!state.openChatId) {
        return;
    }
    const current = state.chatOverrides.get(state.openChatId) || { chatId: state.openChatId, roles: [] };
    const roles = Array.isArray(current.roles) ? [...current.roles] : [];
    const existing = roles.find((r) => r.index === index);
    const chat = state.chats.find((c) => c.chatId === state.openChatId);
    void chat;
    const node = document.querySelector(`#migasst_msg_list .migasst-msg[data-index="${index}"]`);
    const currentRole = node?.classList.contains('is-bot') ? 'bot' : 'user';
    const nextRole = currentRole === 'bot' ? 'user' : 'bot';
    if (existing) {
        existing.role = nextRole;
    } else {
        roles.push({ index, role: nextRole });
    }
    state.chatOverrides.set(state.openChatId, { ...current, chatId: state.openChatId, roles });
    openChatDrawer(state.openChatId);
}

async function confirmChatsAndMatch() {
    if (!state.sessionId) {
        return;
    }
    const overrides = state.chats.map((c) => {
        const o = state.chatOverrides.get(c.chatId);
        return {
            chatId: c.chatId,
            skip: o?.skip ?? c.skip ?? false,
            roles: o?.roles || [],
        };
    });
    await apiFetch(`/session/${state.sessionId}/chats/overrides`, {
        method: 'POST',
        body: { overrides },
    });
    const match = await apiFetch(`/session/${state.sessionId}/match`, { method: 'POST', body: {} });
    state.clusters = match.clusters || [];
    renderMatchList();
    goToStep('match');
    const stats = document.getElementById('migasst_match_stats');
    if (stats && match.summary) {
        stats.textContent = `${match.summary.total} clusters · ${match.summary.matchedExport} export-matched · ${match.summary.needsSearch} need search`;
    }
}

function renderMatchList() {
    const list = document.getElementById('migasst_match_list');
    if (!list) {
        return;
    }
    list.innerHTML = state.clusters.map((cluster, i) => {
        const override = state.matchOverrides.get(cluster.clusterId);
        const skipped = override?.action === 'skip';
        const name = override?.character?.name || cluster.match?.name || 'Unmatched';
        const source = override?.action === 'manual' || override?.action === 'replace'
            ? override.action
            : cluster.matchSource;
        return `
        <article class="migasst-row ${skipped ? 'is-skipped' : (cluster.needsSearch ? 'is-warn' : '')}" data-cluster-id="${escapeHtml(cluster.clusterId)}" style="animation-delay:${Math.min(i, 12) * 25}ms">
            <div>
                <p class="migasst-row-title">
                    <span class="migasst-badge ${cluster.needsSearch ? 'warn' : ''}">${escapeHtml(source)}</span>
                    ${escapeHtml(name)}
                </p>
                <p class="migasst-row-meta">${cluster.chatCount} chats · ${cluster.messageCount} messages · confidence ${Math.round((cluster.matchConfidence || 0) * 100)}%</p>
                <p class="migasst-row-preview">${escapeHtml(cluster.greetingPreview || '')}</p>
                ${(cluster.candidates || []).length > 1 ? `<p class="migasst-row-meta">Ambiguous export candidates: ${cluster.candidates.map((c) => escapeHtml(c.name)).join(', ')}</p>` : ''}
            </div>
            <div class="migasst-row-actions">
                ${(cluster.candidates || []).map((c) => `<button type="button" class="migasst-btn migasst-btn-primary migasst-btn-small" data-action="pick-candidate" data-key="${escapeHtml(c.key)}">Use ${escapeHtml(c.name)}</button>`).join('')}
                <button type="button" class="migasst-btn migasst-btn-ghost migasst-btn-small" data-action="keep-match">Keep</button>
                <button type="button" class="migasst-btn migasst-btn-danger migasst-btn-small" data-action="skip-cluster">${skipped ? 'Unskip' : 'Skip'}</button>
            </div>
        </article>`;
    }).join('');
}

function renderSearchList() {
    const list = document.getElementById('migasst_search_list');
    if (!list) {
        return;
    }
    const needing = state.clusters.filter((c) => {
        const o = state.matchOverrides.get(c.clusterId);
        if (o?.action === 'skip') {
            return false;
        }
        if (o?.action === 'manual' || o?.action === 'replace' || o?.action === 'keep') {
            return false;
        }
        return c.needsSearch || !c.match;
    });
    if (!needing.length) {
        list.innerHTML = '<div class="migasst-status">No clusters need external search. Continue to import.</div>';
        return;
    }
    list.innerHTML = needing.map((cluster, i) => `
        <article class="migasst-row is-warn" data-cluster-id="${escapeHtml(cluster.clusterId)}" style="animation-delay:${Math.min(i, 12) * 25}ms">
            <div>
                <p class="migasst-row-title">${escapeHtml(cluster.match?.name || 'Needs character')}</p>
                <p class="migasst-row-meta">${cluster.chatCount} chats · ${cluster.messageCount} messages</p>
                <p class="migasst-row-preview">${escapeHtml(cluster.greetingPreview || '')}</p>
                <div class="migasst-manual-box">
                    <input class="migasst-input" data-field="name" placeholder="Character name" value="${escapeHtml(cluster.match?.name || '')}">
                    <textarea class="migasst-textarea" data-field="greeting" placeholder="Greeting">${escapeHtml(cluster.greetingPreview || '')}</textarea>
                    <textarea class="migasst-textarea" data-field="description" placeholder="Optional description"></textarea>
                    <textarea class="migasst-textarea" data-field="definition" placeholder="Optional definition / personality"></textarea>
                    <label class="migasst-file-picker">Import a character card (PNG or JSON)
                        <input type="file" data-field="card" accept=".png,.json,image/png,application/json">
                    </label>
                    <label class="migasst-file-picker">Optional character image (PNG or JPEG)
                        <input type="file" data-field="image" accept="image/png,image/jpeg,.png,.jpg,.jpeg">
                    </label>
                    <input class="migasst-input" data-field="query" placeholder="Search query (API stub)">
                </div>
                <div class="migasst-search-results" data-results></div>
            </div>
            <div class="migasst-row-actions">
                <button type="button" class="migasst-btn migasst-btn-primary migasst-btn-small" data-action="search-greeting">Search greeting</button>
                <button type="button" class="migasst-btn migasst-btn-ghost migasst-btn-small" data-action="search-query">Search query</button>
                <button type="button" class="migasst-btn migasst-btn-primary migasst-btn-small" data-action="save-manual">Save manual</button>
                <button type="button" class="migasst-btn migasst-btn-danger migasst-btn-small" data-action="skip-cluster">Skip</button>
            </div>
        </article>
    `).join('');
}

async function runClusterSearch(clusterId, mode) {
    const row = document.querySelector(`#migasst_search_list [data-cluster-id="${CSS.escape(clusterId)}"]`);
    const cluster = state.clusters.find((c) => c.clusterId === clusterId);
    if (!row || !cluster) {
        return;
    }
    const resultsEl = row.querySelector('[data-results]');
    const queryInput = row.querySelector('[data-field="query"]');
    if (resultsEl) {
        resultsEl.innerHTML = '<p class="migasst-row-meta">Searching…</p>';
    }
    try {
        const results = mode === 'query'
            ? await searchCharactersByQuery(String(queryInput?.value || cluster.greetingPreview || ''), { limit: 5 })
            : await searchCharactersByGreeting(cluster.greetingPreview || cluster.greeting || '', { limit: 5 });
        if (!resultsEl) {
            return;
        }
        if (!results.length) {
            resultsEl.innerHTML = '<p class="migasst-row-meta">No results (API stub returns empty until configured).</p>';
            return;
        }
        resultsEl.innerHTML = results.map((r, idx) => {
            const hitId = `${clusterId}:${idx}`;
            state.searchHits.set(hitId, {
                source: 'search',
                name: String(r.name || 'Unnamed').slice(0, 120),
                greeting: String(r.greeting || '').slice(0, 20000),
                definition: String(r.definition || '').slice(0, 100000),
                description: String(r.description || '').slice(0, 20000),
                imageUrl: r.imageUrl || null,
            });
            return `
            <div class="migasst-msg">
                <div class="migasst-msg-top"><span>${escapeHtml(r.name)}</span>
                <button type="button" class="migasst-btn migasst-btn-primary migasst-btn-small" data-action="apply-search" data-hit-id="${escapeHtml(hitId)}">Use</button></div>
                <div class="migasst-msg-body">${escapeHtml((r.greeting || '').slice(0, 240))}</div>
            </div>`;
        }).join('');
    } catch (error) {
        if (resultsEl) {
            resultsEl.innerHTML = `<p class="migasst-status is-error">${escapeHtml(error.message)}</p>`;
        }
    }
}

async function saveManualCharacter(clusterId, row) {
    const name = String(row.querySelector('[data-field="name"]')?.value || '').trim().slice(0, 120) || 'Unnamed';
    const definition = String(row.querySelector('[data-field="definition"]')?.value || '').slice(0, 100000);
    const description = String(row.querySelector('[data-field="description"]')?.value || '').slice(0, 20000);
    const greeting = String(row.querySelector('[data-field="greeting"]')?.value || '').slice(0, 20000);
    const cluster = state.clusters.find((c) => c.clusterId === clusterId);
    const imageInput = row.querySelector('[data-field="image"]');
    const imageFile = imageInput?.files?.[0];
    if (imageFile && imageFile.size > 4 * 1024 * 1024) {
        throw new Error('Manual character images must be smaller than 4 MB.');
    }
    const imageUrl = imageFile
        ? await readAsDataUrl(imageFile)
        : row.dataset.cardImage || null;
    state.matchOverrides.set(clusterId, {
        clusterId,
        action: 'manual',
        character: {
            source: 'manual',
            name,
            greeting: greeting || cluster?.greetingPreview || '',
            definition,
            description,
            imageUrl,
        },
    });
}

async function loadCardIntoSearchRow(file, row) {
    try {
        const card = await decodeCardMetadata(file);
        const isPng = file.type === 'image/png' || file.name.toLowerCase().endsWith('.png');
        const hasSmallImage = isPng && file.size <= 4 * 1024 * 1024;
        const fields = ['name', 'greeting', 'description', 'definition'];
        const values = [card.name, card.greeting, card.description, card.definition];
        fields.forEach((field, index) => {
            const input = row.querySelector(`[data-field="${field}"]`);
            if (input) {
                input.value = values[index];
            }
        });
        row.dataset.cardImage = hasSmallImage
            ? await readAsDataUrl(file)
            : '';
        toastr.success(`Loaded character card: ${card.name}`);
        if (isPng && !hasSmallImage) {
            toastr.info('Card details loaded; the PNG is too large to attach as an avatar. Choose a smaller image if needed.');
        }
    } catch (error) {
        toastr.error(error.message || 'Could not read character card.');
    }
}

async function confirmMatchesAndSearch() {
    if (!state.sessionId) {
        return;
    }
    // Default keep for confident export matches not overridden
    for (const cluster of state.clusters) {
        if (!state.matchOverrides.has(cluster.clusterId) && cluster.match && !cluster.needsSearch) {
            state.matchOverrides.set(cluster.clusterId, { clusterId: cluster.clusterId, action: 'keep' });
        }
    }
    const overrides = [...state.matchOverrides.values()];
    await apiFetch(`/session/${state.sessionId}/match/overrides`, {
        method: 'POST',
        body: { overrides },
    });
    renderSearchList();
    goToStep('search');
}

async function confirmSearchAndPlan() {
    if (!state.sessionId) {
        return;
    }
    const overrides = [...state.matchOverrides.values()];
    await apiFetch(`/session/${state.sessionId}/match/overrides`, {
        method: 'POST',
        body: { overrides },
    });
    const plan = await apiFetch(`/session/${state.sessionId}/plan`, { method: 'POST', body: {} });
    state.planItems = plan.items || [];
    renderImportList();
    const stats = document.getElementById('migasst_import_stats');
    if (stats && plan.summary) {
        stats.textContent = `${plan.summary.characters} characters · ${plan.summary.chats} chats · ${plan.summary.messages} messages`;
    }
    goToStep('import');
}

function renderImportList() {
    const list = document.getElementById('migasst_import_list');
    if (!list) {
        return;
    }
    list.innerHTML = state.planItems.map((item, i) => `
        <article class="migasst-row" data-cluster-id="${escapeHtml(item.clusterId)}" style="animation-delay:${Math.min(i, 12) * 25}ms">
            <div>
                <p class="migasst-row-title">
                    <span class="migasst-badge">${escapeHtml(item.matchSource)}</span>
                    ${escapeHtml(item.name)}
                </p>
                <p class="migasst-row-meta">${item.chatCount} chats · ${item.messageCount} messages${item.hasDefinition ? ' · has definition' : ''}${item.hasAvatar ? ' · avatar' : ''}</p>
                <p class="migasst-row-preview">${escapeHtml(item.firstMesPreview || '')}</p>
            </div>
            <div class="migasst-row-actions">
                <label class="migasst-check"><input type="checkbox" data-action="toggle-include" ${item.include !== false ? 'checked' : ''}> Include</label>
            </div>
        </article>
    `).join('');
}

async function runImport() {
    if (!state.sessionId) {
        return;
    }
    if (state.importCompleted) {
        goToStep('profiles');
        return;
    }
    const result = document.getElementById('migasst_import_result');
    const excludeClusterIds = state.planItems
        .filter((item) => {
            const row = document.querySelector(`#migasst_import_list [data-cluster-id="${CSS.escape(item.clusterId)}"] input[type="checkbox"]`);
            return row && !row.checked;
        })
        .map((item) => item.clusterId);

    setStatus(result, 'Materializing import payloads…');
    try {
        const data = await apiFetch(`/session/${state.sessionId}/import`, {
            method: 'POST',
            body: { excludeClusterIds },
        });
        state.importCompleted = true;

        // Best-effort import into SillyTavern via public character import endpoint when available.
        let imported = 0;
        const failures = [];
        const { Popup } = getContext();
        for (const payload of data.payloads || []) {
            try {
                await importCharacterPayload(payload);
                imported += 1;
            } catch (error) {
                failures.push(`${payload.character?.name || 'Character'}: ${error.message}`);
            }
        }

        setStatus(result, `Prepared ${data.count} package(s). Imported ${imported}${failures.length ? `; ${failures.length} failed: ${failures.join('; ')}` : ''}.`);
        if (Popup?.show?.text) {
            await Popup.show.text('Migration Assistant', `Prepared ${data.count} package(s). Imported ${imported}.`);
        }
        goToStep('profiles');
    } catch (error) {
        setStatus(result, error.message || 'Import failed.', true);
    }
}

async function importCharacterPayload(payload) {
    const form = new FormData();
    let file;
    let fileType;
    if (payload.avatarImage) {
        file = await createCharacterCardPng(payload.avatarImage, payload.character);
        fileType = 'png';
    } else {
        file = new Blob([JSON.stringify(payload.character)], { type: 'application/json' });
        fileType = 'json';
    }
    form.append('avatar', file, `${safeUploadName(payload.character.name)}.${fileType}`);
    form.append('file_type', fileType);
    const res = await fetch('/api/characters/import', {
        method: 'POST',
        headers: getRequestHeaders({ omitContentType: true }),
        body: form,
        credentials: 'same-origin',
    });
    if (!res.ok) {
        throw new Error(`Character import HTTP ${res.status}`);
    }
    const response = await res.json();
    if (response.error) {
        throw new Error('SillyTavern could not import this character card.');
    }
}

function canvasToPng(canvas) {
    return new Promise((resolve, reject) => {
        canvas.toBlob((blob) => {
            if (blob) {
                resolve(blob);
            } else {
                reject(new Error('Could not encode the selected image.'));
            }
        }, 'image/png');
    });
}

async function normalizeImageToPng(imageRef) {
    if (typeof imageRef !== 'string'
        || (!/^data:image\/(?:png|jpeg|webp|gif);base64,/i.test(imageRef) && !/^https?:\/\//i.test(imageRef))) {
        throw new Error('Only PNG or JPEG images can be used for avatars.');
    }
    const response = await fetch(imageRef);
    if (!response.ok) {
        throw new Error('Could not read the selected character image.');
    }
    const imageBlob = await response.blob();
    if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(imageBlob.type) || imageBlob.size > 12 * 1024 * 1024) {
        throw new Error('Character images must be valid images smaller than 12 MB.');
    }
    let bitmap;
    try {
        bitmap = await createImageBitmap(imageBlob);
    } catch {
        throw new Error('The selected file is not a supported image.');
    }
    if (!bitmap.width || !bitmap.height || bitmap.width * bitmap.height > 24_000_000) {
        bitmap.close();
        throw new Error('Character image dimensions are too large.');
    }
    const scale = Math.min(1, 1024 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext('2d');
    if (!context) {
        bitmap.close();
        throw new Error('Could not process the selected image.');
    }
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    return canvasToPng(canvas);
}

function makePngTextChunk(keyword, value) {
    const text = new TextEncoder().encode(`${keyword}\0${value}`);
    const type = new TextEncoder().encode('tEXt');
    const chunk = new Uint8Array(text.length + 12);
    const view = new DataView(chunk.buffer);
    view.setUint32(0, text.length);
    chunk.set(type, 4);
    chunk.set(text, 8);

    let crc = 0xffffffff;
    for (let index = 4; index < text.length + 8; index += 1) {
        crc ^= chunk[index];
        for (let bit = 0; bit < 8; bit += 1) {
            crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
        }
    }
    view.setUint32(text.length + 8, (crc ^ 0xffffffff) >>> 0);
    return chunk;
}

function encodeBase64(bytes) {
    let binary = '';
    const chunkSize = 0x8000;
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
    }
    return btoa(binary);
}

async function createCharacterCardPng(imageRef, character) {
    const image = await normalizeImageToPng(imageRef);
    const imageBytes = new Uint8Array(await image.arrayBuffer());
    const view = new DataView(imageBytes.buffer);
    let offset = 8;
    let endOfImage = -1;
    while (offset + 12 <= imageBytes.length) {
        const length = view.getUint32(offset);
        const type = new TextDecoder().decode(imageBytes.subarray(offset + 4, offset + 8));
        if (offset + length + 12 > imageBytes.length) {
            throw new Error('Processed image has invalid PNG data.');
        }
        if (type === 'IEND') {
            endOfImage = offset;
            break;
        }
        offset += length + 12;
    }
    if (endOfImage < 0) {
        throw new Error('Could not create a valid character card image.');
    }
    const metadata = safeCardPayload(normalizeCardData(character));
    const encoded = encodeBase64(new TextEncoder().encode(JSON.stringify(metadata)));
    const chunk = makePngTextChunk('chara', encoded);
    const combined = new Uint8Array(imageBytes.length + chunk.length);
    combined.set(imageBytes.subarray(0, endOfImage));
    combined.set(chunk, endOfImage);
    combined.set(imageBytes.subarray(endOfImage), endOfImage + chunk.length);
    return new File([combined], `${safeUploadName(metadata.data.name)}.png`, { type: 'image/png' });
}

function makeInitialsAvatar(name) {
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 512;
    const context = canvas.getContext('2d');
    if (!context) {
        throw new Error('Could not create a default persona image.');
    }
    context.fillStyle = '#064789';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = '#EBF2FA';
    context.font = '600 180px sans-serif';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    const initials = String(name).trim().split(/\s+/).slice(0, 2).map((part) => part[0] || '').join('').toUpperCase() || '?';
    context.fillText(initials, 256, 256, 420);
    return canvasToPng(canvas);
}

function renderProfileList() {
    const list = document.getElementById('migasst_profile_list');
    if (!list) {
        return;
    }
    list.innerHTML = state.profiles.map((profile) => `
        <article class="migasst-row migasst-profile-row" data-profile-id="${escapeHtml(profile.id)}">
            <div class="migasst-profile-fields">
                <label class="migasst-check"><input type="checkbox" data-field="include" ${profile.include ? 'checked' : ''}> Include this file</label>
                <label class="migasst-profile-type">Import as
                    <select class="migasst-input" data-field="type">
                        <option value="">Choose type</option>
                        <option value="character" ${profile.type === 'character' ? 'selected' : ''}>Character</option>
                        <option value="persona" ${profile.type === 'persona' ? 'selected' : ''}>Persona</option>
                    </select>
                </label>
                <input class="migasst-input" data-field="name" aria-label="Profile name" value="${escapeHtml(profile.card.name)}">
                <textarea class="migasst-textarea" data-field="description" aria-label="Description" placeholder="Description">${escapeHtml(profile.card.description)}</textarea>
                <textarea class="migasst-textarea" data-field="greeting" aria-label="Greeting" placeholder="Greeting">${escapeHtml(profile.card.greeting)}</textarea>
                <textarea class="migasst-textarea" data-field="definition" aria-label="Definition" placeholder="Definition / personality">${escapeHtml(profile.card.definition)}</textarea>
                <label class="migasst-file-picker">Optional picture
                    <input type="file" data-field="image" accept="image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp">
                </label>
                <p class="migasst-row-meta">${escapeHtml(profile.fileName)}${profile.imageDataUrl ? ' · embedded image found' : ''}</p>
            </div>
        </article>
    `).join('');
}

async function addProfileFiles(files) {
    const status = document.getElementById('migasst_profile_status');
    let added = 0;
    let totalBytes = state.profiles.reduce((total, profile) => total + (profile.fileSize || 0), 0);
    const errors = [];
    for (const file of files) {
        try {
            if (totalBytes + file.size > 100 * 1024 * 1024) {
                throw new Error('Optional profile files are limited to 100 MB per session.');
            }
            const card = await decodeCardMetadata(file);
            const imageDataUrl = file.type === 'image/png' || file.name.toLowerCase().endsWith('.png')
                ? await readAsDataUrl(file)
                : '';
            state.profiles.push({
                id: `${Date.now()}-${state.profiles.length}`,
                fileName: file.name,
                fileSize: file.size,
                card,
                imageDataUrl,
                include: true,
                type: '',
            });
            totalBytes += file.size;
            added += 1;
        } catch (error) {
            errors.push(`${file.name}: ${error.message}`);
        }
    }
    renderProfileList();
    if (added) {
        state.profilesImported = false;
    }
    if (state.step === 'profiles') {
        setNextLabel(state.profilesImported ? 'Done' : state.profiles.some((profile) => profile.include && profile.type) ? 'Import selected profiles' : 'Skip & finish');
    }
    setStatus(status, `${added} file(s) ready.${errors.length ? ` ${errors.join(' ')}` : ''}`, errors.length > 0);
}

async function importPersona(profile) {
    const avatarBlob = profile.imageDataUrl
        ? await normalizeImageToPng(profile.imageDataUrl)
        : await makeInitialsAvatar(profile.card.name);
    const fileName = `${Date.now()}-${profile.card.name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80) || 'persona'}.png`;
    const form = new FormData();
    form.append('avatar', new File([avatarBlob], fileName, { type: 'image/png' }));
    form.append('overwrite_name', fileName);
    const response = await fetch('/api/avatars/upload', {
        method: 'POST',
        headers: getRequestHeaders({ omitContentType: true }),
        body: form,
        credentials: 'same-origin',
    });
    if (!response.ok) {
        throw new Error(`Persona avatar upload failed (HTTP ${response.status}).`);
    }
    const result = await response.json();
    if (!result.path) {
        throw new Error('SillyTavern did not return the uploaded persona avatar path.');
    }
    const details = [profile.card.description, profile.card.definition, profile.card.scenario]
        .filter(Boolean)
        .join('\n\n');
    await initPersona(result.path, profile.card.name, details, '');
    await getUserAvatars(true, result.path);
}

async function importProfiles() {
    const result = document.getElementById('migasst_profile_status');
    const selected = state.profiles.filter((profile) => profile.include && profile.type);
    if (!selected.length) {
        finishProfiles('No optional profiles selected. Migration complete.');
        return;
    }
    setStatus(result, 'Importing selected profiles…');
    let imported = 0;
    const failures = [];
    for (const profile of selected) {
        try {
            if (!profile.card.name.trim()) {
                throw new Error('Profile name is required.');
            }
            if (profile.type === 'persona') {
                await importPersona(profile);
            } else {
                const character = safeCardPayload(profile.card);
                await importCharacterPayload({ character, avatarImage: profile.imageDataUrl || null });
            }
            imported += 1;
            profile.include = false;
        } catch (error) {
            failures.push(`${profile.card.name}: ${error.message}`);
        }
    }
    if (failures.length) {
        state.profilesImported = false;
        renderProfileList();
        setStatus(result, `Imported ${imported} profile(s). Retry failed items: ${failures.join('; ')}`, true);
        setNextLabel(state.profiles.some((profile) => profile.include && profile.type) ? 'Retry failed profiles' : 'Done');
    } else {
        finishProfiles(`Imported ${imported} profile(s).`);
    }
}

function finishProfiles(message, isError = false) {
    state.profilesImported = true;
    setStatus(document.getElementById('migasst_profile_status'), message, isError);
    setNextLabel('Done');
}

async function discardSession() {
    if (!state.sessionId) {
        closeWizard();
        return;
    }
    const { Popup } = getContext();
    const ok = Popup?.show?.confirm
        ? await Popup.show.confirm('Discard session?', 'Temporary parse data for this migration will be deleted.')
        : window.confirm('Discard migration session?');
    if (!ok) {
        return;
    }
    try {
        await apiFetch(`/session/${state.sessionId}`, { method: 'DELETE' });
    } catch {
        // ignore
    }
    state.sessionId = null;
    state.chats = [];
    state.clusters = [];
    state.planItems = [];
    state.profiles = [];
    state.profilesImported = false;
    state.importCompleted = false;
    state.chatOverrides.clear();
    state.matchOverrides.clear();
    closeWizard();
}

async function onNext() {
    try {
        if (state.step === 'upload') {
            if (state.sessionId) {
                goToStep('chats');
            }
            return;
        }
        if (state.step === 'chats') {
            await confirmChatsAndMatch();
            return;
        }
        if (state.step === 'match') {
            await confirmMatchesAndSearch();
            return;
        }
        if (state.step === 'search') {
            await confirmSearchAndPlan();
            return;
        }
        if (state.step === 'import') {
            await runImport();
            return;
        }
        if (state.step === 'profiles') {
            if (state.profilesImported) {
                closeWizard();
            } else {
                await importProfiles();
            }
        }
    } catch (error) {
        toastr.error(error.message || 'Step failed', 'Migration Assistant');
    }
}

function onBack() {
    const idx = STEPS.indexOf(state.step);
    if (idx > 0) {
        goToStep(STEPS[idx - 1]);
    }
}

function bindWizardEvents(root) {
    root.querySelector('#migasst_close')?.addEventListener('click', () => closeWizard());
    root.querySelector('#migasst_back')?.addEventListener('click', onBack);
    root.querySelector('#migasst_next')?.addEventListener('click', onNext);
    root.querySelector('#migasst_danger')?.addEventListener('click', discardSession);
    root.querySelector('#migasst_profiles_skip')?.addEventListener('click', () => {
        finishProfiles('Optional character and persona imports skipped.');
        closeWizard();
    });
    root.querySelector('#migasst_profile_files')?.addEventListener('change', (event) => {
        const files = Array.from(event.target.files || []);
        void addProfileFiles(files);
        event.target.value = '';
    });

    const drop = root.querySelector('#migasst_dropzone');
    const fileInput = root.querySelector('#migasst_file');
    drop?.addEventListener('dragover', (e) => {
        e.preventDefault();
        drop.classList.add('is-dragover');
    });
    drop?.addEventListener('dragleave', () => drop.classList.remove('is-dragover'));
    drop?.addEventListener('drop', (e) => {
        e.preventDefault();
        drop.classList.remove('is-dragover');
        const file = e.dataTransfer?.files?.[0];
        handleUpload(file);
    });
    fileInput?.addEventListener('change', () => handleUpload(fileInput.files?.[0]));

    root.querySelector('#migasst_chat_filter')?.addEventListener('input', () => renderChatList());
    root.querySelector('#migasst_chat_drawer_close')?.addEventListener('click', () => {
        const drawer = root.querySelector('#migasst_chat_drawer');
        if (drawer) {
            drawer.hidden = true;
        }
    });

    root.querySelector('#migasst_chat_list')?.addEventListener('click', (e) => {
        const btn = e.target.closest('button[data-action]');
        const row = e.target.closest('[data-chat-id]');
        if (!btn || !row) {
            return;
        }
        const chatId = row.getAttribute('data-chat-id');
        if (btn.dataset.action === 'inspect') {
            openChatDrawer(chatId);
        }
        if (btn.dataset.action === 'toggle-skip') {
            const current = state.chatOverrides.get(chatId) || { chatId, roles: [] };
            const chat = state.chats.find((c) => c.chatId === chatId);
            const nextSkip = !(current.skip ?? chat?.skip);
            state.chatOverrides.set(chatId, { ...current, skip: nextSkip });
            if (chat) {
                chat.skip = nextSkip;
            }
            renderChatList();
        }
    });

    root.querySelector('#migasst_msg_list')?.addEventListener('click', (e) => {
        const btn = e.target.closest('button[data-action="flip-role"]');
        const msg = e.target.closest('.migasst-msg');
        if (!btn || !msg) {
            return;
        }
        flipMessageRole(Number(msg.dataset.index));
    });

    root.querySelector('#migasst_match_list')?.addEventListener('click', (e) => {
        const btn = e.target.closest('button[data-action]');
        const row = e.target.closest('[data-cluster-id]');
        if (!btn || !row) {
            return;
        }
        const clusterId = row.getAttribute('data-cluster-id');
        const cluster = state.clusters.find((c) => c.clusterId === clusterId);
        if (btn.dataset.action === 'skip-cluster') {
            const current = state.matchOverrides.get(clusterId);
            if (current?.action === 'skip') {
                state.matchOverrides.delete(clusterId);
            } else {
                state.matchOverrides.set(clusterId, { clusterId, action: 'skip' });
            }
            renderMatchList();
        }
        if (btn.dataset.action === 'keep-match') {
            state.matchOverrides.set(clusterId, { clusterId, action: 'keep' });
            renderMatchList();
        }
        if (btn.dataset.action === 'pick-candidate') {
            const candidate = (cluster?.candidates || []).find((c) => c.key === btn.dataset.key);
            if (candidate) {
                state.matchOverrides.set(clusterId, {
                    clusterId,
                    action: 'replace',
                    character: {
                        key: candidate.key,
                        source: 'export',
                        name: candidate.name,
                        greeting: candidate.greetingPreview || cluster.greetingPreview,
                    },
                });
                renderMatchList();
            }
        }
    });

    root.querySelector('#migasst_search_list')?.addEventListener('click', async (e) => {
        const btn = e.target.closest('button[data-action]');
        const row = e.target.closest('[data-cluster-id]');
        if (!btn || !row) {
            return;
        }
        const clusterId = row.getAttribute('data-cluster-id');
        if (btn.dataset.action === 'search-greeting') {
            await runClusterSearch(clusterId, 'greeting');
        }
        if (btn.dataset.action === 'search-query') {
            await runClusterSearch(clusterId, 'query');
        }
        if (btn.dataset.action === 'save-manual') {
            try {
                await saveManualCharacter(clusterId, row);
                toastr.success('Manual character saved for this cluster');
                renderSearchList();
            } catch (error) {
                toastr.error(error.message || 'Could not save manual character.');
            }
        }
        if (btn.dataset.action === 'skip-cluster') {
            state.matchOverrides.set(clusterId, { clusterId, action: 'skip' });
            renderSearchList();
        }
        if (btn.dataset.action === 'apply-search') {
            const hit = state.searchHits.get(btn.dataset.hitId || '');
            if (!hit) {
                return;
            }
            state.matchOverrides.set(clusterId, {
                clusterId,
                action: 'replace',
                character: hit,
            });
            toastr.success('Search result applied');
        }
    });
    root.querySelector('#migasst_search_list')?.addEventListener('change', (event) => {
        const file = event.target.closest('[data-field="card"]')?.files?.[0];
        const row = event.target.closest('[data-cluster-id]');
        if (file && row) {
            void loadCardIntoSearchRow(file, row);
            event.target.value = '';
        }
    });
    root.querySelector('#migasst_profile_list')?.addEventListener('input', (event) => {
        const field = event.target.dataset.field;
        const row = event.target.closest('[data-profile-id]');
        const profile = state.profiles.find((item) => item.id === row?.dataset.profileId);
        if (!profile || !['name', 'description', 'greeting', 'definition'].includes(field)) {
            return;
        }
        if (field === 'name') {
            profile.card.name = event.target.value.slice(0, 120);
        } else {
            profile.card[field] = event.target.value;
        }
    });
    root.querySelector('#migasst_profile_list')?.addEventListener('change', async (event) => {
        const field = event.target.dataset.field;
        const row = event.target.closest('[data-profile-id]');
        const profile = state.profiles.find((item) => item.id === row?.dataset.profileId);
        if (!profile) {
            return;
        }
        if (field === 'type') {
            profile.type = event.target.value;
            const next = root.querySelector('#migasst_next');
            if (profile.include && profile.type) {
                state.profilesImported = false;
            }
            if (next) {
                setNextLabel(state.profilesImported ? 'Done' : state.profiles.some((item) => item.include && item.type) ? 'Import selected profiles' : 'Skip & finish');
            }
        } else if (field === 'include') {
            profile.include = event.target.checked;
            const next = root.querySelector('#migasst_next');
            if (profile.include && profile.type) {
                state.profilesImported = false;
            }
            if (next) {
                setNextLabel(state.profilesImported ? 'Done' : state.profiles.some((item) => item.include && item.type) ? 'Import selected profiles' : 'Skip & finish');
            }
        } else if (field === 'image') {
            const imageFile = event.target.files?.[0];
            if (imageFile) {
                try {
                    if (imageFile.size > 12 * 1024 * 1024) {
                        throw new Error('Images must be smaller than 12 MB.');
                    }
                    profile.imageDataUrl = await readAsDataUrl(imageFile);
                } catch (error) {
                    toastr.error(error.message || 'Could not read profile image.');
                }
            }
        }
    });
}

async function mountUi() {
    const settingsHost = document.getElementById('extensions_settings2') || document.getElementById('extensions_settings');
    if (!settingsHost) {
        console.warn('[migration-assistant] extensions settings panel not found');
        return;
    }

    ensureAssets();
    const settingsHtml = await fetch(`${EXTENSION_FOLDER}/settings.html`).then((r) => r.text());
    const wizardHtml = await fetch(`${EXTENSION_FOLDER}/wizard.html`).then((r) => r.text());
    const { DOMPurify } = SillyTavern.libs;
    settingsHost.insertAdjacentHTML('beforeend', DOMPurify.sanitize(settingsHtml, {
        FORBID_TAGS: ['link'],
    }));
    document.body.insertAdjacentHTML('beforeend', DOMPurify.sanitize(wizardHtml, {
        ADD_ATTR: ['data-step', 'data-panel', 'data-i18n', 'for'],
        FORBID_TAGS: ['link'],
    }));
    const wizard = document.getElementById('migasst_wizard');
    if (wizard) {
        wizard.hidden = true;
    }

    const openBtn = document.getElementById('migasst_open_wizard');
    openBtn?.addEventListener('click', openWizard);
    document.getElementById('migasst_theme_toggle')?.addEventListener('change', (event) => {
        applyTheme(event.target.checked ? 'dark' : 'light');
    });
    initializeTheme();
    bindWizardEvents(document.getElementById('migasst_wizard'));

    const status = document.getElementById('migasst_plugin_status');
    const alive = await probePlugin();
    if (status) {
        status.textContent = alive
            ? 'Server plugin connected.'
            : 'Server plugin not detected. Enable enableServerPlugins and install server-plugin/.';
    }
}

jQuery(async () => {
    try {
        await mountUi();
        console.log('[migration-assistant] UI extension loaded');
    } catch (error) {
        console.error('[migration-assistant] failed to load', error);
    }
});
