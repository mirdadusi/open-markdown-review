// Dependency-free profile identifiers: importing HTML/tokenization must not
// leave the protocol capability list dependent on module initialization order.
export const SANITIZED_HTML_CAPABILITY = 'sanitized-html-v1' as const;
export const SANITIZED_HTML_PROFILE = 'commonmark-gfm+sanitized-html-v1' as const;
export const SANITIZED_HTML_VERSION = 'omr-sanitized-html-v1' as const;
