/** Portable ASCII identifier starting with a letter. */
export const IDENTIFIER_PATTERN = /^[A-Za-z][A-Za-z0-9._\x2d]*$/u;

/** Stable evidence identifier, also admitting namespace and path separators. */
export const STABLE_IDENTIFIER_PATTERN = /^[A-Za-z][A-Za-z0-9._:\x2f\x2d]*$/u;

// Repeated alphabet quartets exhaust V8's regexp stack on large bodies,
// including under JSON Schema's Unicode-set mode. Check alphabet and terminal
// padding separately, leaving an unconstrained fixed-width loop for length.
const PADDED_BASE64_PREFIX = String.raw`^(?!.*[^A-Za-z0-9+\x2f=])(?!.*=[^=])(?!.*===)`;

/** Padded base64 syntax, allowing nonzero pad bits and the empty encoding. */
export const PADDED_BASE64_PATTERN = new RegExp(
  `${PADDED_BASE64_PREFIX}(?:....)*$`,
);

/** Canonical padded base64, including zero pad bits and the empty encoding. */
export const CANONICAL_BASE64_PATTERN = new RegExp(
  `${PADDED_BASE64_PREFIX}(?!.*[^AQgw]==$)(?!.*[^AEIMQUYcgkosw048=]=$)(?:....)*$`,
);
