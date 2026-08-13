declare module "svg-to-pdfkit" {
  import PDFDocument from "pdfkit";
  interface Options {
    width?: number;
    height?: number;
    preserveAspectRatio?: string;
    assumePt?: boolean;
  }
  export default function SVGtoPDF(
    document: PDFDocument,
    svg: string,
    x?: number,
    y?: number,
    options?: Options,
  ): void;
}
