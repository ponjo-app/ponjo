// What the door of a doc checks (docs/architecture.md, The door): the level
// a call needs, and how a refusal says why.

/**
 * A call refused: `code` says why ('bad_input', 'not_found', 'read_only',
 * 'stale', 'forbidden'); or 'not_saved', an edit that landed but whose
 * file could not be written: it is written once it can be, and told then.
 */
export class DocError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/** What a call may need, each level allowing the ones before it. */
export const LEVELS = ['read', 'write', 'owner'];

/** Whether `who` ({ id, name, kind, level }) may make a call that needs `level`. */
export const can = (who, level) => LEVELS.indexOf(who?.level) >= LEVELS.indexOf(level);
