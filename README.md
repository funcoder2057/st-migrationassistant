# Migration Assistant

SillyTavern extension + server plugin that migrates **CharacterAI data exports** (`Username.zip` or `message.json`) into SillyTavern, with review checkpoints for chat sorting, character matching, and manual overrides.

## Components

| Path | Role |
|------|------|
| `manifest.json`, `index.js`, `style.css`, `*.html` | UI extension (wizard + settings entry) |
| `api.js` | Character search facade (calls left blank / TBC) |
| `server-plugin/` | Express plugin: zip extract, parse, match, import payloads |

## Install

### 1. UI extension

Copy or clone this repo into:

`SillyTavern/public/scripts/extensions/third-party/st-migrationasst`

Enable **Migration Assistant** under Extensions.

### 2. Server plugin

```bash
cp -r server-plugin SillyTavern/plugins/migration-assistant
cd SillyTavern/plugins/migration-assistant
npm install
```

In `config.yaml`:

```yaml
enableServerPlugins: true
```

Restart SillyTavern. The UI status line should read **Server plugin connected.**

## Workflow

1. **Upload** — `Username.zip` (contains `data/message.json`; character and user files are optional) or a standalone messages JSON file
2. **Chats** — review chats sorted by `chat_id` + `create_time`; flip speaker roles; skip chats
3. **Match** — confirm greeting clusters vs export `character.json`
4. **Search** — match missing characters from PNG/JSON cards, search via `api.js` (stub), or enter details manually
5. **Import** — confirm plan; materialize ST character/chat payloads
6. **Optional profiles** — import PNG/JSON character cards as characters or personas; persona avatars and descriptions are saved to SillyTavern

Character cards can also be added to unmatched clusters during Search. PNG card metadata is parsed as JSON and projected onto an explicit allowlist; arbitrary extensions and executable fields are not imported. Manual entries accept a greeting, description, definition, and optional image.

The SillyTavern settings panel provides **Open Settings Page**, **Begin Migration**, and a **Resume Migration** button when a session is active. Closing the wizard leaves the migration intact; progress and review choices are saved in the browser so the wizard can resume after navigation or reload while the server session is available. **Cancel Migration** explicitly removes the temporary session and saved progress.

Work already running when the wizard is closed continues to its next user-input checkpoint. Chat and character imports record completed items so resuming does not intentionally repeat successful imports.

## API stub

`api.js` must remain the only module that talks to external character indexes. Implementations should:

- **Send** the chat greeting / first message
- **Receive** `.jpg` / `.png`, greeting text, optional definition

## Security notes

- Archives are validated against zip-slip, entry caps, and uncompressed size limits
- Only expected JSON + image paths are extracted into an OS temp session directory
- Sessions use 192-bit random IDs and a separate random browser key, and expire after 24 hours of inactivity
- JSON override bodies are size-capped and field-sanitized before use
- UI output is HTML-escaped; extension HTML is passed through DOMPurify
- Plugin routes rely on SillyTavern’s own `/api` authentication — keep ST behind a trusted network or basic auth as usual
- Do not commit CharacterAI export zips or extracted user data into this repository
