# Design
You are designing a "Migration Assistant" tool for SillyTavern characters to be migrated and imported from CharacterAI data exports. Create a simple but effective UI which allows the user to check the plugin's import actions along the way. Checks should include sorting of chats, character matching and where else feels appropriate. Allow the user to manually override actions that it feels are incorrect.


## Spec & Docs
Before writing any code, read through the SillyTavern plugin doccumentation.

Using the methods written in this doccumentation is a **must** in order to create functional & effective code
https://docs.sillytavern.app/for-contributors/
https://docs.sillytavern.app/usage/st-script/
https://docs.sillytavern.app/for-contributors/server-plugins/
https://docs.sillytavern.app/for-contributors/i18n/

### Server Plugin
Utilise a server plugin to Parse JSON and manage any other compute intense or read/write operations. Ensure the plugin is secure from attacks, and is compatible with all SillyTavern implementations.

## API
An API will need to be used to search for Characters, make all api requests run through a single code file labeled api, leave actual calls to it blank as the implementation is TBC.

The API should only send the first message/greeting from a character, and should recieve a .jpg or .png, as well as greeting text and possibly a definition.

## Parsing
Importing will require the Parsing of a large JSON file.
``{
  "chat_id": "00e1febd-6cac-42de-b35d-826f3e606b96",
  "candidate_id": "cmpl-0216c7bc81290d7abd4447e62d14b2cc",
  "raw_content": "bot message"
  "create_time": "2026-01-16 20:54:47.461967+00:00",
  "tti_image_rel_path": null
}``
This is a Character message.

``{
  "chat_id": "00e1febd-6cac-42de-b35d-826f3e606b96",
  "candidate_id": "752e4023-56ea-4af8-96fc-ea8a29cc460d",
  "raw_content": "user message",
  "create_time": "2026-01-16 21:27:26.431165+00:00",
  "tti_image_rel_path": null
}``
This is a user message

Where possible, attempt to disinguish between user & bot messages and sort accordingly.

### Rules
Each JSON string will follow the following rules:
- chat_id sorts it into each individual chat
- create_time is when the message was made, sort by oldest-newest
- raw_content is the actual message
- the first message in a chat is always the Greeting

The upload stage must accept either the complete ZIP or only `message.json`; character and user files are optional. Missing characters can be matched from SillyTavern PNG/JSON cards or completed manually. Card metadata must be parsed as data, projected onto supported fields, and never evaluated as code. After the chat import, provide a skippable stage where users can import profile files as characters or SillyTavern personas.

# Colours
- #064789 for normal, interactable buttons such as continue buttons or actively selected buttons/menu options
- #DE1A1A for dangerous buttons, such as override or delete options
- #EBF2FA as a light background
    - use #011502 for contrasting with this colour
- #000000 as a dark background
    - use #444444ba for subtle borders and surfaces, and #EBF2FA for readable text and stronger contrast.