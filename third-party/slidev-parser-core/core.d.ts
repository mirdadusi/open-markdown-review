/** OMR's narrow type surface for the unmodified upstream pure-parser module. */
export interface ParsedSlide {
  index: number;
  start: number;
  end: number;
  contentStart: number;
  frontmatterRaw?: string;
  frontmatterStyle?: string;
  note?: string;
}
export function parseSync(markdown: string, filepath: string, options: { preserveCR: boolean; noParseYAML: boolean }): { slides: ParsedSlide[] };
export function extractImagesUsage(content: string, frontmatter: Record<string, unknown>): string[];
