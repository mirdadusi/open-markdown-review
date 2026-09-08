// The project uses classic Node module resolution; this export is provided by
// Slidev's package exports but its root declaration has the same public types.
declare module '@slidev/parser/core' {
  export { parseSync, extractImagesUsage } from '@slidev/parser';
}
