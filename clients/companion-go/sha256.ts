// Build-target primitive, not a second implementation of protocol semantics.
// The shared bytes module still owns digest names, canonical bytes and checks.
// Only its SHA-256 algorithm import is bound to Go's standard crypto library.
declare const __sha256: (bytes: Uint8Array) => ArrayBuffer;
export const sha256 = (bytes: Uint8Array): Uint8Array => new Uint8Array(__sha256(bytes));
