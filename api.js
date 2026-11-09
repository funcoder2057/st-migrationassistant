/**
 * Character search API facade.
 * All external character lookups go through this module.
 * Implementations are TBC — leave call bodies as stubs.
 *
 * Contract:
 *   Request  → first message / greeting text from a CharacterAI chat
 *   Response → image (.jpg | .png), greeting text, optional definition
 */

/**
 * @typedef {Object} CharacterSearchResult
 * @property {string} id
 * @property {string} name
 * @property {string} greeting
 * @property {string} [description]
 * @property {string} [definition]
 * @property {string} [imageUrl] data URL or remote URL ending in .jpg/.png
 * @property {number} [score]
 * @property {string} [source]
 */

/**
 * Search for characters matching a greeting / first message.
 * @param {string} greeting First message text from the chat
 * @param {object} [options]
 * @param {number} [options.limit]
 * @returns {Promise<CharacterSearchResult[]>}
 */
export async function searchCharactersByGreeting(greeting, options = {}) {
    const limit = options.limit ?? 5;
    void greeting;
    void limit;
    // TBC: call caibotlist (or equivalent) with the greeting text.
    // Expected response payload per hit:
    //   { id, name, greeting, description?, definition?, imageUrl (.jpg|.png) }
    return [];
}

/**
 * Fetch a single character definition by external id.
 * @param {string} characterId
 * @returns {Promise<CharacterSearchResult|null>}
 */
export async function fetchCharacterById(characterId) {
    void characterId;
    // TBC: resolve a character card by id from the search provider.
    return null;
}

/**
 * Search by free-text query (name / tags) for manual override flows.
 * @param {string} query
 * @param {object} [options]
 * @param {number} [options.limit]
 * @returns {Promise<CharacterSearchResult[]>}
 */
export async function searchCharactersByQuery(query, options = {}) {
    const limit = options.limit ?? 10;
    void query;
    void limit;
    // TBC: keyword search against the character index.
    return [];
}
