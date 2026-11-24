// Workbooks made by hand for the tests of the XLSX reader (test/verify-0.8-xlsx.test.ts and
// test/timing/xlsx.timing.test.ts), and what they read as.
import JSZip from "jszip";
import { extractText } from "../src/extract.js";

export const S = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
export const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
export const RELS = 'xmlns="http://schemas.openxmlformats.org/package/2006/relationships"';

export async function zip(files: Record<string, string>): Promise<Uint8Array> {
  const archive = new JSZip();
  for (const [name, content] of Object.entries(files)) archive.file(name, content);
  return archive.generateAsync({ type: "uint8array", compression: "DEFLATE" });
}

/** A workbook of one sheet, "Data", with these shared strings and number formats (one cell style each, from 1). */
export async function workbook(sheetData: string, options: { strings?: string[]; formats?: Array<number | string> } = {}): Promise<Uint8Array> {
  const custom = (options.formats ?? []).flatMap((format, index) => typeof format === "string" ? [`<numFmt numFmtId="${164 + index}" formatCode="${format}"/>`] : []);
  const styles = (options.formats ?? []).map((format, index) => `<xf numFmtId="${typeof format === "string" ? 164 + index : format}"/>`);
  return zip({
    "xl/workbook.xml": `<workbook ${S}><sheets><sheet name="Data" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    "xl/_rels/workbook.xml.rels": `<Relationships ${RELS}><Relationship Id="rId1" Type="${REL}/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
    "xl/worksheets/sheet1.xml": `<worksheet ${S}><sheetData>${sheetData}</sheetData></worksheet>`,
    ...(options.strings ? { "xl/sharedStrings.xml": `<sst ${S}>${options.strings.map((text) => `<si><t xml:space="preserve">${text}</t></si>`).join("")}</sst>` } : {}),
    ...(options.formats ? { "xl/styles.xml": `<styleSheet ${S}><numFmts>${custom.join("")}</numFmts><cellXfs><xf numFmtId="0"/>${styles.join("")}</cellXfs></styleSheet>` } : {}),
  });
}

export const read = async (bytes: Uint8Array, maxTextBytes?: number) => extractText(bytes, { name: "w.xlsx", mimeType: "", format: "xlsx", maxTextBytes });
export const rowsOf = (text: string) => text.split("\n").filter((line) => line.startsWith("Row "));
