/**
 * Shared constants for Messenger Counter.
 *
 * CHAT_TYPES: Language-agnostic internal identifiers for conversation types.
 *   These are the values stored in group.type and used for all logic/filtering.
 *   Display labels are handled by the TRANSLATIONS object in App.jsx.
 *
 * REACTION_PATTERNS: Regex patterns to detect Facebook reaction messages.
 *   Facebook exports reaction messages as text content with specific phrases.
 */

// ─── Chat Type Constants ───────────────────────────────────────────────────
export const CHAT_TYPES = {
  INDIVIDUAL: 'individual',
  GROUP: 'group',
  DATING: 'dating',
  PAGE: 'page',
};

// ─── Reaction Pattern Detection ────────────────────────────────────────────
// Facebook encodes reaction messages differently depending on language.
// These patterns catch both decoded and raw (mojibake) variants.
export const REACTION_PATTERNS = [
  /đã bày tỏ cảm xúc.*về tin nhắn/i,           // Vietnamese decoded
  /reacted to.*message/i,                         // English decoded
  /b\u00c3\u00a0y t\u00e1\u00bb\u008f c\u00e1\u00ba\u00a3m x\u00c3\u00bac/i, // Vietnamese raw mojibake
];

// ─── Personal Reaction Prefixes ────────────────────────────────────────────
// Reaction messages that start with these prefixes belong to the account owner.
export const PERSONAL_REACTION_PREFIXES = [
  /^(Bạn|You)\s/i,
  /^(B\u00e1\u00ba\u00a1n|B\u00e1\xba\xa1n)\s/i,  // raw mojibake variants
];

// ─── Default / Fallback Display Values ────────────────────────────────────
// Used when a sender name is unavailable. Not language-dependent for logic.
export const UNKNOWN_SENDER = 'Unknown';

// Friendly display fallback per language — used in UI only, not in data
export const UNKNOWN_SENDER_DISPLAY = {
  vi: 'Người tham gia',
  en: 'Participant',
};

// ─── Dating Conversation Participant Name ──────────────────────────────────
// In Facebook dating exports, the "you" participant is labeled 'Bạn'.
// We normalize this to a language-agnostic sentinel for internal data use.
export const DATING_SELF_LABEL = 'Bạn';
