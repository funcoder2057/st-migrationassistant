# NOTE: Automated character import does NOT work yet. I am waiting on API development.
## I will update the plugin and state when this is added. Thanks for your patience.

# Migration Assistant

SillyTavern extension + server plugin that migrates **CharacterAI data exports** (`Username.zip` or `message.json`) into SillyTavern, with review checkpoints for chat sorting, character matching, and manual overrides.

## Components

| Path | Role |
|------|------|
| `manifest.json`, `index.js`, `style.css`, `wizard.html` | UI extension (native Extensions panel + wizard) |
| `api.js` | Character search facade (calls left blank / TBC) |
| `server-plugin/` | Express plugin: zip extract, parse, match, import payloads |

## Install

## Web Extension
1. In SillyTavern, open the "Extensions" menu
2. Click "Install extension"
3. Paste in ``https://github.com/funcoder2057/st-migrationassistant`` and ``main`` or another branch
4. Click either "Install for all users" or "Install just for me", depending on your needs.

## Server Plugin
1. In 'Releases', download the st-migrationassistant.zip release
2. Extract it into the plugins folder
3. Ensure ServerPlugins are enabled in ``config.yaml`` in SillyTavern's configs
4. Restart the Server

## Workflow

1. **Upload** — `Username.zip` (contains `data/message.json`; character and user files are optional) or a standalone messages JSON file
2. **Chats** — review chats sorted by `chat_id` + `create_time`; flip speaker roles; skip chats
3. **Match** — confirm greeting clusters vs export `character.json`
4. **Search** — match missing characters from PNG/JSON cards, search via `api.js` (stub), or enter details manually
5. **Import** — confirm the plan and choose per character whether to create a new card or send its chats to an existing SillyTavern character
6. **Optional profiles** — import PNG/JSON character cards as characters or personas; persona avatars and descriptions are saved to SillyTavern

Character cards can also be added to unmatched clusters during Search. PNG card metadata is parsed as JSON and projected onto an explicit allowlist; arbitrary extensions and executable fields are not imported. Manual entries accept a greeting, description, definition, and optional image.

The SillyTavern **Extensions** panel provides a persistent light/dark switch, **Begin Migration**, and a **Resume Migration** button when a session is active. Dark mode uses the documented black canvas with `#EBF2FA` content surfaces and brighter blue accents for legibility. Begin and Resume open a full-size SillyTavern popup with the wizard ready at the saved step. Closing the wizard leaves the migration intact; progress and review choices are saved in the browser so the wizard can resume after navigation or reload while the server session is available. If SillyTavern restarts and loses its in-memory session, the wizard returns to Upload and asks you to upload the export again. **Cancel Migration** explicitly removes the temporary session and saved progress.

Work already running when the wizard is closed continues to its next user-input checkpoint. Actions lasting over five seconds show a spinner and a status message; if work continues, the message changes every five minutes. On the first upload screen, the spinner appears beside the export drop area. Characters and their chats are saved through SillyTavern's own import and chat-save APIs; completed items are recorded so resuming does not intentionally repeat successful imports. Choosing an existing character saves chats there without importing or modifying its character card.

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
