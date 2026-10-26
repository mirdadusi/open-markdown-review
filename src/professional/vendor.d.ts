declare module 'pdfmake/build/pdfmake' {
  const pdfMake: { addVirtualFileSystem(fonts: unknown): void; addFonts(fonts: unknown): void; createPdf(definition: unknown, options?: { bufferPages?: boolean }): { getBuffer(): Promise<Uint8Array>; getStream(): Promise<import('./pdfComments').BufferedPdf> } };
  export default pdfMake;
}
declare module 'pdfmake/build/vfs_fonts' { const fonts: Record<string, string>; export default fonts; }
