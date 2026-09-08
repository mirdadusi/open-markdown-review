declare module 'pdfmake/build/pdfmake' {
  const pdfMake: { addVirtualFileSystem(fonts: unknown): void; createPdf(definition: unknown): { getBuffer(): Promise<Uint8Array> } };
  export default pdfMake;
}
declare module 'pdfmake/build/vfs_fonts' { const fonts: Record<string, string>; export default fonts; }
