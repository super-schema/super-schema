/** The bounds of the password rule, in a module of their own so a client component can state them without bundling the deny-list (src/lib/auth/password-policy.ts). */
export const PASSWORD_MIN_BYTES = 12;
/** bcrypt's own limit: it hashes the first 72 bytes only. */
export const PASSWORD_MAX_BYTES = 72;
