// Word files made by hand for the tests of the Office readers (test/verify-0.8-office.test.ts and
// test/timing/office.timing.test.ts): paragraphs, list levels, and the ZIP around them.
import JSZip from "jszip";
import { extractText } from "../src/extract.js";

export const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
export const p = (text: string, properties = "") => `<w:p>${properties ? `<w:pPr>${properties}</w:pPr>` : ""}<w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
export const listed = (numId: number, level: number, text: string) => p(text, `<w:numPr><w:ilvl w:val="${level}"/><w:numId w:val="${numId}"/></w:numPr>`);
export const lvl = (index: number, format: string, text: string, extra = "") => `<w:lvl w:ilvl="${index}"><w:start w:val="1"/><w:numFmt w:val="${format}"/>${extra}<w:lvlText w:val="${text}"/></w:lvl>`;

export async function zip(files: Record<string, string>, compression: "STORE" | "DEFLATE" = "STORE"): Promise<Uint8Array> {
  const archive = new JSZip();
  for (const [name, content] of Object.entries(files)) archive.file(name, content);
  return archive.generateAsync({ type: "uint8array", compression, compressionOptions: { level: 9 } });
}

export async function word(body: string, styles?: string, numbering?: string, compression: "STORE" | "DEFLATE" = "STORE"): Promise<Uint8Array> {
  return zip({
    "word/document.xml": `<w:document ${W}><w:body>${body}</w:body></w:document>`,
    ...(styles ? { "word/styles.xml": `<w:styles ${W}>${styles}</w:styles>` } : {}),
    ...(numbering ? { "word/numbering.xml": `<w:numbering ${W}>${numbering}</w:numbering>` } : {}),
  }, compression);
}

export const docxText = async (bytes: Uint8Array) => (await extractText(bytes, { name: "a.docx", mimeType: "", format: "docx" })).text;
