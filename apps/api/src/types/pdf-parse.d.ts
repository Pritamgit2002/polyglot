/**
 * pdf-parse ships no types. We only use `text`, so a narrow declaration is
 * better than pulling in an unmaintained @types package.
 */
declare module 'pdf-parse' {
  interface PdfParseResult {
    text: string;
    numpages: number;
    info: Record<string, unknown>;
  }
  function pdfParse(data: Buffer | Uint8Array): Promise<PdfParseResult>;
  export default pdfParse;
}
