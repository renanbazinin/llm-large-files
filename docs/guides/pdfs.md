# PDFs and other formats

This guide covers the files the library reads: the formats, what each needs installed, and what the
model gets from them. Most of it is about PDFs: rebuilt tables, the line that marks a page with a
picture, `view_pages`, which shows the model the real pages, scanned PDFs, and extractors of your
own, OCR among them. Exact signatures are in the [library reference](../reference/library.md).

## Formats

The readers of DOCX, PPTX, XLSX and PDF files are optional dependencies. Install the ones you need
on every server that ingests files:

```bash
npm install jszip              # DOCX, PPTX and XLSX
npm install unpdf              # PDF text (on Node 22, name a version: see below)
npm install @cantoo/pdf-lib    # PDF picture marks, page check, and view_pages
npm install unpdf@2 @napi-rs/canvas  # view_pages as images, for a model without PDF input (Node 24)
```

They are optional peer dependencies of the package: `jszip` ^3.10.0, `unpdf` ^1.4.0 || ^2.0.0,
`@cantoo/pdf-lib` ^2.11.1, and, since 0.99.9, `@napi-rs/canvas` ^0.1.69 || ^1.0.0
([Pages as images](#pages-as-images)).

Not every `unpdf` runs on every Node. unpdf 2 asks for Node 24, and on Node 24 and later
`npm install unpdf` installs it. On Node 22, install a version that runs there:

| Node | `unpdf` to install | Refused at the first PDF ([What is refused](#what-is-refused)) |
|---|---|---|
| 22 | 1.4.0, or 1.6.1 or a later 1.x: `npm install unpdf@1` | 1.5.0 to 1.6.0, which would stop the whole process |
| 24 and later | Any version from 1.4.0, 2.x included: `npm install unpdf` | None |

The 12 test PDFs of the package give the same text, pages, picture marks and page cuts with every
`unpdf` from 1.4.0 to 2.2.1, each on a Node it runs on. An app that installs unpdf 2 and goes
back to llm-large-files 0.5.0 must go back to unpdf 1 in the same command
(`npm install llm-large-files@0.5.0 unpdf@^1`): 0.5.0 does not accept unpdf 2, and npm stops with
`ERESOLVE`.

| Format | Detected by | Needs | What the text holds |
|---|---|---|---|
| `text` | Anything not below | | The file decoded as UTF-8, or as UTF-16 with a byte-order mark. Without the mark, only little-endian UTF-16 of mostly ASCII text is recognised. A file that is not UTF-8 is read in windows-1255, windows-1256, windows-1251, Shift_JIS or windows-1252 when its letters show which one (`meta.encoding`), and as UTF-8 otherwise ([Text encodings](#text-encodings)). Characters that are not valid are stored as U+FFFD (�) and counted (`meta.replacedCharacters`). |
| `log` | `.log`, `.out`, `.err`; or a `text` file in which at least 40% of the first 200 non-empty lines (5 at least) start with a timestamp or a level, or have the shape of an access log, a JSON log line, klog or logfmt | | As `text`, plus a log profile: levels, time range, most frequent errors. |
| `markdown` | `.md`, `.markdown`, `text/markdown` | | As `text`. Its `#` headings form the outline. |
| `json` | `.json`, `.jsonl`, `.ndjson`, `application/json` | | As `text`. Minified JSON becomes lines of at most 2,000 characters. |
| `csv` | `.csv`, `.tsv`, `text/csv` | | As `text`. |
| `pdf` | `.pdf`, `application/pdf` | `unpdf`; `@cantoo/pdf-lib` for picture marks, the page check and `view_pages` | A `--- Page N ---` line before each page, tables rebuilt as rows of cells, a line for a page without text and for a page with a picture ([PDF text](#pdf-text)). |
| `docx` | `.docx`, `.docm`, or the Word MIME type | `jszip` | The body, with headings as Markdown headings (`## 2.1 Rent`), list numbers as Word shows them and tables as rows of `\| cell \| cell \|  \|`; then the footnotes, endnotes, comments, headers and footers, in that order, each under a heading of its own. Text that Word hides comes after the text of its paragraph that shows, each of its lines starting `[Hidden text, not shown in the document]` ([DOCX and PPTX](#docx-and-pptx)). |
| `pptx` | `.pptx`, `.pptm`, or the PowerPoint MIME type | `jszip` | `## Slide N` before each slide, in the order of the slide show, with its tables and its speaker notes after `[Speaker notes]`; `## Slide N (hidden, not shown in the slide show)` for a slide that the slide show skips, `[No text on this slide]` for a slide without text. |
| `xlsx` | `.xlsx`, `.xlsm`, `.xltx`, `.xltm`, or the Excel MIME types | `jszip` | `## Sheet N: name` before each sheet, a `Columns: \| A \| B \|` line, then a line a row, `Row 12: \| East \| 2026-03-01 \| 1200.5 \|`, with the values Excel last computed, dates, times and percentages as Excel shows them. New in 0.8.0 ([XLSX and HTML](#xlsx-and-html)). |
| `html` | `.html`, `.htm`, `.xhtml`, `text/html`, `application/xhtml+xml` | | The text a browser shows: headings, lists, tables as rows of cells, `text (https://…)` for a link, the alt text of a picture; no scripts or styles. New in 0.8.0. |

`detectFormat(name, mimeType)` picks the format: a known extension first, then the MIME type, then
`text`. So `report` with no extension, sent as `application/pdf`, is a PDF, and `data.txt` sent as
`application/json` is JSON, since `.txt` is not one of the known extensions. XML, YAML and source
code are `text`; HTML is `html` since 0.8.0. The MIME type is compared whole:
`application/json; charset=utf-8` is not JSON. Send the bare type (or
`X-File-Type: application/json` to the upload route of `createDocumentHandlers`, which takes it
before `Content-Type`).

Whatever the format, the text is then made uniform: line breaks become `\n`, colour codes and other
control characters are removed, and lines longer than 2,000 characters are split, so every line can
be read by its number. Most characters that show nothing are removed too: tag characters, zero-width
spaces, word joiners, a soft hyphen inside a line, and the text-direction controls that reorder what
a person sees. Those that scripts and emoji need are kept: the marks of right-to-left text (U+200E,
U+200F, U+061C), the joiners of emoji and Persian, variation selectors, Hangul fillers, and the line
and paragraph separators (U+2028, U+2029). A crafted file can still carry text that a person does
not see in them ([Security](../security.md#characters-that-show-nothing) lists them all). In a text
with no other line break, such as a mainframe file converted to UTF-8, U+0085 (next line) ends a
line, except right after a character from U+0080 to U+00FF, where it is taken for half of a UTF-8
letter and removed; anywhere else it is removed with the other control characters. That is text in
UTF-8: the same export converted to ISO-8859-1 is read as windows-1252, where its byte 0x85 is "…",
and stays one long line, so convert it to UTF-8 instead. No other line break is added or removed,
but a line of more than 2,000 characters that lost some of these characters can be split into fewer
pieces than 0.5.0 split it, which moves the lines after it. Since 0.8.0 the text is also composed
(NFC): "e" and a combining accent become "é". Every format but log, JSON and CSV gets an outline
from its headings: Markdown `#` lines (`## Slide N` and `## Sheet N: name` among them; not in a
fenced code block, nor the comments of a text file that reads as code), chapter and numbered section
lines, and short lines in capitals; a PDF whose text gives fewer than 3 of these, from the lines set
in larger type than its body, when there are 3 or more ([PDF outline](#pdf-outline), new in
0.10.0). `meta.pages` is the number of pages of a PDF, of slides of a PPTX and of sheets of an
XLSX. [How it works](../how-it-works.md) follows ingest from there.

### Text encodings

A text, log, CSV, JSON or Markdown file that is not valid UTF-8 is read in the older encoding it
was saved in, when its letters show which one: Excel saves a Hebrew CSV in windows-1255, and an old
program writes in the code page of Windows. No text file is refused for its encoding. When no
encoding fits, the file is read as UTF-8, as 0.5.0 read every file that was not UTF-16, and each
character that is not valid is stored as U+FFFD (�).

| `meta.encoding` | Letters | Also read this way |
|---|---|---|
| `windows-1255` | Hebrew | ISO-8859-8 |
| `windows-1256` | Arabic | |
| `windows-1251` | Cyrillic | |
| `shift_jis` | Japanese, half-width katakana too (as in Japanese bank files) | |
| `windows-1252` | Western European | ISO-8859-1, as browsers read it |

How the encoding is chosen:

1. Each line is read as UTF-8. It counts as UTF-8 when it holds at least as many characters of
   more than one byte as characters that are not valid, as not UTF-8 when it holds more that are
   not valid, and as ASCII when it holds neither. A character cut in two by the start or the end
   of the file counts as UTF-8.
2. The file is UTF-8 when at least as many lines count as UTF-8 as count as not (ASCII lines count
   for neither), or when at most one line in 200 is not UTF-8 (ASCII lines counted): a log cut at a
   byte count, a part made by `split -b`, stray bytes, or a binary body that a log line holds. A
   byte-order mark always means UTF-8. Each character that is not valid becomes U+FFFD, and
   `meta.replacedCharacters` counts them.
3. A file whose only fault is emoji written as two halves of a surrogate pair (CESU-8, as an Oracle
   export in its UTF8 character set and Java's modified UTF-8 write them) is read as UTF-8, with
   its emoji.
4. Otherwise the encoding is chosen on the lines that are not UTF-8 and hold a letter (a byte of
   0xC0 or more), wherever they are in the file, up to 64 KB of them. Lines of signs alone
   (– ’ € °) choose only when no line has a letter. Shift_JIS is tried on the first 64 KB of the
   lines that are not UTF-8. An encoding fits when those lines read as words of its letters, with
   at most one word or sign in 50 that looks wrong. The first that fits, in the order of the table,
   is the one.
5. When no line holds a UTF-8 character, the whole file is read in that encoding. Otherwise each
   line that is valid UTF-8 is read as UTF-8, and the other lines in that encoding. A byte that the
   encoding does not have becomes U+FFFD and is counted.
6. When no encoding fits, the file is read as UTF-8, and its characters that are not valid are
   counted.

The model is told how the file was read. The card of a large file has the line
`This file is not in UTF-8. Its text was read as windows-1255: if its letters look wrong, ask the user to save it as UTF-8.`,
which goes on ` 1 character of it was not valid in windows-1255, and shows as �.` when a byte was
not in that encoding. A file read as UTF-8 with characters that are not valid gets
`3 characters of this file were not valid UTF-8, and show as �.` A file sent whole says the same in
its first frame line, after the count of lines: `, read as windows-1255` or
`, 3 characters not valid UTF-8, shown as �`. `toDocumentSummary` passes `encoding` and
`replacedCharacters` on, so the upload route of `createDocumentHandlers` answers with them, and
your page can show "read as windows-1255".

Such a file is read in steps of about a megabyte, with pauses for other requests, and stops when
the ingest's signal aborts. Decoding a 30 MB file all in windows-1255 took 0.27 to 0.28 s, in steps
of 15 ms at most. Files with lines in both encodings take longer: 0.35 to 0.37 s for a CSV of
windows-1255 rows with one UTF-8 row, and 0.50 to 0.53 s for a log whose lines take turns between
windows-1252 and UTF-8, with one windows-1252 line more than UTF-8 lines (30 MB each; Node 24,
Windows, a shared machine). With as many lines of each, that log is read as UTF-8, by rule 2. A
valid UTF-8 file is decoded in one step, as before.

What it gets wrong, as a rule:

- **Encodings it does not recognize** are read as UTF-8, with U+FFFD and the count: Greek
  (windows-1253), Turkish (windows-1254), Central European (windows-1250: Polish, Czech, Slovene),
  Icelandic, KOI8-R and KOI8-U, the DOS and OEM code pages (437, 850, 866), ISO-8859-5 and
  ISO-8859-6, EUC-JP, Chinese (GBK, Big5), Korean (EUC-KR) and Thai (windows-874).
- **Hungarian** in windows-1250 or ISO-8859-2 is read as windows-1252, with õ and û in place of ő
  and ű: a search for a word with ő or ű finds nothing.
- **Japanese with few or no kana**, such as a list of names, cities and addresses in kanji only, is
  not recognized as Shift_JIS, and is read as UTF-8 with U+FFFD.
- **ISO-8859-15** is read as windows-1252 when it has no œ: its € comes out as ¤. A file with
  words such as cœur or bœuf is most often read as UTF-8 instead, with U+FFFD for every letter
  that is not ASCII: in windows-1252, its œ is ½, and ½ between two letters does not fit. A file
  whose only characters that are not ASCII are ₪ amounts, with no Hebrew letter, is read as
  windows-1252 too, with ¤.
- **A short file can be read in a wrong encoding.** A line or two of Greek capitals comes out as
  windows-1251, "Dzień dobry." as windows-1252, "Straße" saved in DOS code page 850 as
  windows-1252 "Straáe", and a Thai name as windows-1256 or Shift_JIS. The rule of one line in 200
  counts lines, so the same holds for a file of fewer than 200 lines, or of one long line (minified
  JSON, or line ends that are a CR alone), whose few stray bytes happen to fit an encoding.
  `meta.encoding` names the encoding used. A few lines of half-width katakana in Shift_JIS can be
  read as UTF-8 with U+FFFD: pairs of their bytes are valid UTF-8 by chance, so some lines count as
  UTF-8 (rule 1).
- **A few words the encoding does not explain** can tip a file to UTF-8 with U+FFFD, when most of
  its lines that are not UTF-8 hold only signs: a Hebrew price list with a few rows such as
  לGoogle, or a windows-1252 CSV with an Icelandic name or two.
- **Lines in an older encoding inside a UTF-8 file** become U+FFFD and are counted, when the file
  is mostly UTF-8, or when at most one line in 200 is not UTF-8: Hebrew names in windows-1255 on
  0.4% of the lines of a log, or 10 lines with a Latin-1 "José" among 20,000.
- **Lines that are valid UTF-8 by chance**, in a file in an older encoding, are read as UTF-8: the
  half-width katakana name ﾏｻﾋｺ in Shift_JIS comes out as ϻ˺, and Weiß’ in windows-1252 as Weiߒ.
  This is rare, and most likely in a file of half-width katakana alone. In the same kind of file, a
  line with a UTF-8 character and a byte that is not valid is read in the older encoding.
- **Two readings of one file.** An editor that opens a file in an older encoding as UTF-8 shows its
  lines as �, while the model reads them in the older encoding. A person who checks the file there
  does not see what the model reads
  ([Security](../security.md#text-files-that-were-not-utf-8)). Lines that are valid UTF-8 read
  the same in both.

A Node.js built without full ICU may lack these encodings; a file is then read as UTF-8, with the
count. The builds of nodejs.org have them.

When letters look wrong, or show as �, ask the user to save the file as UTF-8 and upload it again:
in Excel, Save As "CSV UTF-8 (Comma delimited)"; in Notepad, Save As with the encoding UTF-8. A
document that 0.5.0 stored from a file in one of these encodings still holds U+FFFD: upload the
file again.

### DOCX and PPTX

- A text box is read once, after the paragraph it is anchored in. Word stores it twice, the second
  time for older programs.
- A heading of Word (a paragraph of a heading style, of the title style, or with an outline level)
  is a Markdown heading, `#` to `######`, also in a Hebrew document, whose styles keep English
  names. A numbered paragraph starts with the number Word shows: `2.1`, `(a)`, roman numerals,
  Hebrew letters and numerals, `-` for a bullet, and lists that restart. So "clause 2.2" can be
  searched, and the document has an outline.
- A table is a line a row, `| cell | cell |  |`, with its empty cells, as PDF tables are
  ([PDF tables](#pdf-tables)). A merged cell is followed by an empty cell for each column it
  covers, so every row keeps its columns. Until 0.8.0 a table came out one cell per line.
- Non-breaking hyphens and the characters of symbol fonts are kept: "555-0199" no longer reads
  "5550199".
- The footnotes, endnotes, comments, headers and footers come after the body, each under its own
  heading (`# Footnotes`, `# Endnotes`, `# Comments`, `# Header`, `# Footer`); a header or footer
  that repeats one already read is left out.
- The slides of a PPTX are numbered in the order of the slide show, the list in
  `ppt/presentation.xml`, not in the order of their part names: "Slide 5" is the fifth slide shown.
  A table of a slide is a line a row, and its speaker notes follow a line `[Speaker notes]`.
- Documents ingested before 0.8.0 keep the text they had until they are uploaded again.
- Text that Word hides (a run marked `<w:vanish/>`) is kept, after the text of its paragraph that
  shows, and each of its lines starts with `[Hidden text, not shown in the document]`, so the model
  can tell it from what a reader sees. A carriage return, a U+0085 or a line separator in it starts
  a new marked line, and a line longer than about 1,950 characters is cut into pieces, each marked.
  The text of a run inside a hidden run, such as the reading of a ruby, is marked too. The marks
  count toward `maxTextBytes`.
- A slide that the slide show skips keeps its text, under
  `## Slide 2 (hidden, not shown in the slide show)`.
- The mark is a hint, not a filter. Text without it can still be hidden from a reader: text hidden
  through a style, a hidden shape on a slide that shows, white or 1-point text, a text box inside a
  hidden run, tags written with a prefix other than `w:` or `p:`, a `show` value written as a
  character reference (`show="&#48;"`), and parts that nothing in the file refers to (an orphan
  header; an orphan slide only in a deck whose `ppt/presentation.xml` lists no slide). Of
  `mc:AlternateContent`, the `mc:Choice` is read, where Word may show the `mc:Fallback`. And a
  document's own text can write the mark. A `w:val` written as a character reference does the
  opposite: `<w:vanish w:val="&#48;"/>`, which Word reads as 0, marks text that Word shows.
- Pictures are not marked, and `view_pages` works on PDFs only. For a deck of charts, the PDF
  export of the deck lets the model look at the slides.

### XLSX and HTML

New in 0.8.0. An Excel workbook (`.xlsx`, `.xlsm`) is read with `jszip`, as a DOCX is. Each sheet,
in the order of the workbook, is a section:

```text
## Sheet 1: Sales
Columns: | A | B | C |
Row 1: | Region | Date | Amount |
Row 12: | East | 2026-03-01 | 1200.5 |
```

- A row keeps its number in the sheet, so an answer can name the row a person finds in Excel, and
  its empty cells up to its last value. Empty rows are left out; a sheet without a value says
  `[No values on this sheet]`, and a hidden sheet says ` (hidden sheet)` after its name.
- A cell holds the value Excel last computed for it; a formula Excel never computed is written as
  `=` and the formula. Dates and times follow their number formats, in the 1900 and the 1904 date
  systems (`2026-03-01`, `2026-03-01 14:30`), percentages read `12.5%`, and numbers have up to 15
  significant digits. Shared and inline strings are both read.
- Every row of every sheet is read, within `maxTextBytes`. A sheet past 52 columns lists them as
  `Columns: A to BZ`.

An HTML page (`.html`, `.htm`) is read as the text a browser shows. Scripts, styles, forms' option
lists and other content that is not read are dropped. Headings become Markdown headings, list
items `- item` or `1. item`, each table row `| cell | cell |`, a link `text (https://…)`, and a
picture its alt text. The page's title is a `#` heading when no heading holds it. Entities are
decoded, so "AT&T" written `AT&amp;T` is found. A page saved in an older encoding is read as a
text file is ([Text encodings](#text-encodings)). Until 0.8.0 an HTML file was `text`, tags and
all, and an XLSX was refused as a ZIP archive.

### What is refused

`files.ingest` throws an [`IngestError`](../reference/library.md#ingesterror) whose message is
meant for the user, with a `code` for your application. `createDocumentHandlers` answers it with
HTTP 422 and that message, with two exceptions:

- A file over `maxUploadBytes`, which the upload route refuses before reading it all: HTTP 413,
  `The file is larger than the 100 MB upload limit.` ([node reference](../reference/node.md)).
- A file of code `"unreadable"`: a damaged file, whose message is the reader's own (from pdf.js or
  jszip, and not written for a user), a DOCX or XLSX without its main part, and an error of an
  extractor of your own that the library does not know. Since 0.9.0 the upload route,
  `uploadAnswerOf` and `errorInfoOf` answer it in fixed words: `This file could not be read. It may
  be damaged, or not of the type its name says.` The message below stays on the error, for your
  log.

An application that wants other wording maps the codes itself
([`errorInfoOf`](./errors-and-reliability.md#your-users-words-errorinfoof)).

| What | Message |
|---|---|
| An empty file | `report.pdf is empty.` |
| A file over `maxUploadBytes` (100 MB by default) | `report.pdf is larger than the 100 MB upload limit.` |
| A gzip file, such as `app.log.gz` | `This file is gzip-compressed. Decompress it, then attach the text file inside.` |
| A ZIP archive, and the files other than DOCX, PPTX and XLSX that are ZIPs inside (ODT, ODS) | `This file is a ZIP archive. Extract it, then attach the text file you need.` |
| A Word, Excel or PowerPoint file of before 2007, an Outlook message, or an Office file with a password | `This is a Word, Excel or PowerPoint file of before 2007 (.doc, .xls, .ppt), an Outlook message (.msg), or an Office file protected by a password and stored that way. None of these can be read: save it as .docx, .xlsx, .pptx, PDF or text, without a password, and attach that.` |
| Any other binary file: images, audio | `This file looks binary, not text. Attach a text, log, PDF, Word, PowerPoint, Excel or HTML file.` |
| A file that holds no text once read | `report.docx did not contain any text.` |
| A DOCX, PPTX or XLSX that unpacks to more than 100 times its size (past the first 16 MB), or to more than 128 MB of XML | `This DOCX unpacks to more than …`, which ends `Save it as text or PDF, and attach that.` |
| A PDF of more than `maxPdfPages` pages (5,000 by default), before any page is read | `This PDF has 6,200 pages, more than the 5,000 read from one file. Split it, and attach the part you need.` |
| A PDF whose text passes `maxTextBytes` (100 MB by default, or `maxUploadBytes` when that is larger), counted page by page | `This PDF holds more than 100 MB of text, more than is kept from one file. Split it, and attach the part you need.` |
| A PDF whose page tree lists one page more than once | `This PDF lists the same page more than once. A file built that way can hold far more text than its size, so it is not read. Print it to a new PDF, and attach that.` |
| A PDF whose pages draw more than 100 times its size in text (past the first 16 MB), by painting forms inside forms | `This PDF draws more than 16 MB of text, over 100 times its size. A file that grows that much is not read: it may be built to exhaust the server.` |
| A PDF with a page that would hold the server while pdf.js reads it, found before any page is read (with `@cantoo/pdf-lib`; [Pages that would hold the server](#pages-that-would-hold-the-server)) | `Page 1 of this PDF draws far more than its file holds, and reading it would hold the server for a long time. A file built that way is not read: it may be built to exhaust the server. Print it to a new PDF, and attach that.` |
| A PDF whose pages are each within that limit, but together far past it | `This PDF draws far more than its file holds, and reading it would hold the server for a long time. A file built that way is not read: it may be built to exhaust the server. Print it to a new PDF, and attach that.` |
| A PDF with a page whose content is stored with a filter that only images use (JPEG, JPEG 2000, JBIG2, CCITT), or decodes to more than 64 MB through LZW, ASCII85, ASCIIHex or RunLength | `Page 1 of this PDF stores its content in a way that cannot be checked before it is read, so it is not read. Print it to a new PDF, and attach that.` |
| A DOCX or PPTX of more than 32 million characters of text | `This DOCX holds more than 32 million characters of text, more than is read from one file. Split it, and attach the part you need.` |
| A DOCX or PPTX whose text passes `maxTextBytes`, when that is below 32 million | `This DOCX holds more than 10 MB of text, more than is kept from one file. Split it, and attach the part you need.` |
| A DOCX or PPTX of more than 1,000,000 paragraphs with text, or of more than 1,000,000 paragraphs and table cells, empty ones included | `This DOCX has more than 1,000,000 paragraphs, more than a document holds. It may be built to exhaust the server, so it is not read.`, or `… paragraphs and table cells, …` |
| An XLSX of more than 2,097,152 different texts | `This XLSX has more than 2,097,152 different texts, more than a workbook holds. It may be built to exhaust the server, so it is not read.` |
| An XLSX whose text passes `maxTextBytes`, or 32 million characters | `This XLSX holds more text than is kept from one file. Split it, and attach the part you need.` (`… than is read from one file.` past 32 million characters) |
| A DOCX or PPTX with paragraphs nested more than 32 deep | `This DOCX nests paragraphs more than 32 deep, which no document does. It may be built to exhaust the server, so it is not read.` |
| A DOCX or PPTX of more than 20,000 parts, counted the way JSZip will read them, whatever count the file gives | `This DOCX has more than 20,000 parts, more than an Office document has. It may be built to exhaust the server, so it is not read.` |
| A DOCX or PPTX with more than 80,000 extra fields, or more than 8 MB of names, comments and extra-field data that JSZip would turn into text or go through byte by byte | `This DOCX lists its parts in a way that no Office program does: reading the list would take far more memory or time than an Office document needs. It may be built to exhaust the server, so it is not read.` |
| A DOCX or PPTX whose ZIP64 end record says it is longer than its fields, which JSZip would read in a loop without end | `This DOCX ends with a ZIP64 record that cannot be read, and reading it could hold the server without end. It may be built to exhaust the server, so it is not read.` |
| A file of any format whose text, from an extractor of your own or the text extractor, passes `maxTextBytes` | `notes.txt holds more than 100 MB of text, more than is kept from one file. Split it, and attach the part you need.` |
| A file that takes longer than `ingestTimeoutMs` to read (2 minutes by default) | `report.pdf took too long to read (more than 2 min). Split it, or save it as plain text, and attach that.` |
| A PDF without text on any page | See [Scanned PDFs](#scanned-pdfs). |
| A PDF that needs a password to open | `This PDF is protected by a password, so it cannot be read. Open it, print it to a new PDF without the password, and attach that.` Until 0.8.0, `No password given`, the message of pdf.js. |
| A damaged PDF | The message of pdf.js, such as `Invalid PDF structure.` Code `"unreadable"`: the upload route answers in fixed words (above). |
| A damaged DOCX, PPTX or XLSX, or one that is not a ZIP | The message of jszip, such as `Can't find end of central directory : is this a zip file ? …` Code `"unreadable"`: the upload route answers in fixed words. |
| A DOCX without `word/document.xml` | `This DOCX does not contain word/document.xml.` Code `"unreadable"`: the upload route answers in fixed words. |
| A PPTX without slides | `This PPTX does not contain any slides.` |
| An XLSX without `xl/workbook.xml`, or without sheets | `This XLSX does not contain xl/workbook.xml.` (code `"unreadable"`: the upload route answers in fixed words), `This XLSX does not contain any sheets with cells.` |
| A DOCX, PPTX or XLSX without `jszip` installed | `Reading DOCX, PPTX and XLSX files needs the optional dependency "jszip".` |
| A PDF without `unpdf` installed | `Reading PDF files needs the optional dependency "unpdf".` |
| A PDF, with `unpdf` 1.5.0 to 1.6.0 on Node 22 or 23, which would stop the whole process at the first PDF (0.5.0 did stop) | `The unpdf installed would stop the whole server at the first PDF file on Node 22, so PDF files are not read. Install unpdf 1.6.1 or later, or run Node 24 or later.` |

A missing dependency, or an `unpdf` that does not run on your Node, is your server's fault, but it
reaches the user as a 422, a file that cannot be read. Install the dependencies wherever the upload
route runs, in versions that run on its Node ([Formats](#formats)). The messages name the major
version of Node only.

The numbers in the messages are your limits: `maxPdfPages`, `maxTextBytes` and `ingestTimeoutMs` of
`createLargeFiles` ([`LargeFilesOptions`](../reference/library.md#largefilesoptions)). A size below
1 MB is given in KB, and below 1 KB in B; a time below a second in ms, below 2 minutes in s, and
from there in min. An Office message says `PPTX` for a presentation and `XLSX` for a workbook. An
Office file is refused past 32 million characters of text even when `maxTextBytes` is larger. The
ZIP directory of a DOCX, PPTX or XLSX is read before JSZip reads it, the way JSZip will read it,
record by record: the count of parts that the file gives is not used, and the parts are not counted
past 20,000 ([Security](../security.md#uploads)).

What the user can do:

- **A long PDF, or one with a lot of text:** split it (by chapters, by year), and attach the part
  the question is about. If such files are expected, raise `maxPdfPages` or `maxTextBytes`; the
  text is then searched as any other.
- **A file that took too long:** split it, or save it again as plain text (or, for a PDF, print it
  to a new PDF), and attach that. A server that is busy reads slower: if files that should pass
  are refused, raise `ingestTimeoutMs`, and check how many ingests run at once
  ([Deployment](./deployment.md#uploads-and-ingest)).
- **A PDF that lists a page more than once, or an Office file that nests, repeats or splits its
  content past what a program writes:** these are built to exhaust a server, not written by Word,
  PowerPoint or a PDF printer. If one comes from a real program, opening it there and saving it
  again, or printing it to a new PDF, writes it the usual way.
- **A PDF with a page that would hold the server:** the same. If your users' real files are
  refused this way, `createPdfExtractor({ checkPages: false })` reads them, and every page then
  takes as long as pdf.js needs (below).

### Pages that would hold the server

pdf.js reads the text of a page in one block: until it is done, no other request on the server is
answered, and neither `ingestTimeoutMs` nor a signal stops it. A page of a document takes a few
milliseconds. A page built to paint a form that paints another form, many times over, held the
server for 13 s to 2 minutes, from files of 2 to 21 KB
([measured](../measurements.md#the-server)).

With `@cantoo/pdf-lib` installed, the PDF extractor adds up what each page would make pdf.js run,
before pdf.js reads any page:

- the content of the page;
- each form the content paints, every time it is painted, with what the form paints in turn. pdf.js
  runs a form without text once, and skips its other paints: so does the count;
- the first time the file sets a font: its font program and maps, and every glyph program of a
  Type3 font, with the forms, patterns and shadings it paints. pdf.js does not decode an image to
  read text, so images count for nothing.

It reads the file without running it, and counts high where it cannot tell: any name written
before a paint may be the drawing painted, and anything that looks like a text operator makes a
form one with text. A byte of content counts one unit, a form painted for its text 640 more
(about 0.1 ms of pdf.js, which took 75 to 85 µs), and a form painted by a glyph 256 more. A page is
refused past 8,388,608 units, about 1 to 1.5 s of pdf.js, or past 32 times the size of the file
when that is more, and a file whose pages add up to more than four times that. What the check
looks through counts against that file budget too, 16 units for each entry of a resource
dictionary, so a file cannot make the check itself work long. The pages of the real documents
tested ran up to 11% of their limit. The count follows pdf.js 5.4, the version `unpdf` 1.4
bundles, and its cost was measured with that version only. Later versions of `unpdf` bundle pdf.js
5.6 (1.5 to 1.7), 6.1 (1.8), 6.4 (1.9 to 2.1) and 6.5 (2.2): what a page costs them was not
measured, and may be more.

What still holds the server while pdf.js reads a page:

- a page within the limit: up to about 1.5 s in a small file, and longer in a large one (a page of
  a 10 MB file may run 320 MB of content);
- any page, when `@cantoo/pdf-lib` is not installed or cannot read the file, when the file
  declares more than 150,000 objects, or with `checkPages: false`;
- a file built to be read one way by `@cantoo/pdf-lib` and another way by pdf.js.

Neither check looks at the memory an object takes. Both libraries build each object of the file in
one step: `@cantoo/pdf-lib` every object, and pdf.js the ones a page needs and every object of an
object stream it opens, such as the one that holds the catalog. A crafted object can take far more
heap than file: one array of one-digit numbers in a PDF of 16 MB ran a heap of 256 MB out of memory
at ingest, and 8 MB of empty dictionaries, packed with the catalog into an object stream unpacked
twice, ran a heap of 512 MB out of memory in pdf.js alone, with `checkPages: false` and
`pictures: false`, from a PDF of 759 bytes. What a stream unpacks to is held outside the heap: a PDF
of 1.6 KB whose object stream unpacks to 512 MB took 1.6 GB of memory with 20 MB of heap, and held
the server 6.1 to 6.4 s ([Security](../security.md#uploads)). Such files are not refused.

For uploads you do not trust, ingest in a process of its own, with a memory limit of its own as
well as a heap limit ([Deployment](./deployment.md#uploads-and-ingest)): only that process waits,
it can be stopped, and when it runs out of memory it stops alone.

## PDF text

The PDF extractor reads the text with `unpdf` (pdf.js) and writes each page under a line of its own.
Pages are separated by a blank line:

```text
--- Page 12 ---
[Picture on this page. This text cannot show it.]
Figure 3: sales by region.
| Region | Q1 | Q2 | Q3 | Q4 |
| EMEA | 80 |  | 95 | 101 |
```

- `--- Page N ---` starts every page, counting from 1. The model passes these numbers to
  `view_pages`.
- A page with no text at all is written as
  `[No text on this page. It may be a scan, a photo, or a chart.]`, so the model can say that it
  cannot see it instead of guessing.
- With `@cantoo/pdf-lib` installed, a page that shows a picture or a drawing gets the second line
  ([The line that marks a page](#the-line-that-marks-a-page)).
- Tables are rebuilt as rows of cells ([PDF tables](#pdf-tables)).
- The lines set in larger type than the body are the outline ([PDF outline](#pdf-outline)).

### PDF tables

A PDF stores no tables, only text at positions. Read in file order, a row with an empty cell looks
like a row without that column: `EMEA 80 95 101` under the headings `Q1 Q2 Q3 Q4`, and a model reads
95 as Q2. The PDF extractor finds tables by the position of their text and writes each row with its
cells marked, so the same row becomes `| EMEA | 80 |  | 95 | 101 |`. In a live test of 110
questions about single cells, half of them empty, the text in file order gave 44 right answers and
the rebuilt rows 110 ([measurements](../measurements.md)).

What it handles: empty cells, tables inside one column of a two-column page, right-to-left tables
(the first column is the rightmost), tables printed sideways, rotated pages, footnote marks,
headings that span columns, and cells whose text wraps onto several lines when the rows are visibly
spaced apart. A cell that mixes the two directions (a Latin name in a Hebrew table, a Hebrew phrase
in an English one) keeps each run of words in its reading order. Text that is not a table
(paragraphs, lists, columns of prose, justified text) is left as pdf.js gives it.

It is cautious: where the evidence for a table is weak, the text stays as it was. So:

- A table needs three columns. Two-column tables (key and value, a glossary) stay lines of text,
  which read correctly that way.
- When a cell wraps and the rows have no extra space between them, each line of the cell is a row
  of its own, with the other cells empty.
- Columns that are closer together than a word space on every line of the table stay together in
  one cell, on every row alike.
- A table whose text is stored column by column in the file is not rebuilt.
- Pictures and charts are not in the text. See [Pictures in PDFs](#pictures-in-pdfs).

The cell marks cost about one token per cell. The rules were tuned on PDFs made by Chrome and by
Word. To turn them off and get the text in the order pdf.js gives it, as version 0.1.0 read it,
replace the PDF extractor with one made by `createPdfExtractor`:

```ts
import { createLargeFiles, createPdfExtractor, FileDocumentStore } from "llm-large-files";

export const files = createLargeFiles({
  store: new FileDocumentStore("./data/large-files"),
  // Text in pdf.js order, without rebuilt tables, and without picture marks.
  extractors: { pdf: createPdfExtractor({ tables: false, pictures: false }) },
});
```

`tables: false` alone still writes the page lines, the line for a page without text, and the
picture marks. `pictures: false` leaves out the picture marks. `checkPages: false` turns off the
check of [pages that would hold the server](#pages-that-would-hold-the-server), which changes no
text. All three default to `true`
([`PdfExtractorOptions`](../reference/library.md#pdfextractoroptions)). With `pictures: false`
alone, `@cantoo/pdf-lib` still reads each PDF at ingest, for the page check, and the first PDF of a
process loads it, in one block of about 0.4 s. With `pictures: false` and `checkPages: false`,
ingest does not use it at all ([Deployment](./deployment.md#uploads-and-ingest)).

### PDF outline

The card and `get_document_overview` give the model an outline, headings with their line numbers,
and a search hit names the heading above it (`section`). The rules that find headings in a text
seldom find any in a PDF: pdf.js gives no blank line between paragraphs, and Hebrew has no capitals,
so an unnumbered Hebrew contract had no outline. Since 0.10.0 the PDF extractor finds the lines set
in larger type than the body, from the size pdf.js gives each piece of text, and `ingest` makes them
the outline of a PDF whose text gives fewer than 3 headings, when 3 or more of them are found in the
stored text. One or two are not an outline: a PDF with a title alone keeps the card and search hits
of 0.9.0. The card of a lease then starts its outline with:

```text
Outline (8 of 8 headings):
  L3 חוזה שכירות בלתי מוגנת
  L6   הצדדים לחוזה
  L9     פרטי השוכר
  L16   תקופת השכירות
```

- The body is the size most of the text is set in, table rows aside. A heading is a line at least
  15% larger, with three quarters of its characters in that size: the title, Word's Heading 1 and
  Heading 2 (16 and 13 points over 11), the `h1` to `h3` of a page printed by Chrome.
- A table row is a line with a gap of more than 3 times its type size between two of its pieces:
  cells, or a label and its value, whether the table was rebuilt or not (two columns, or
  `tables: false`). It counts for neither the body nor the headings, so a statement whose table is
  set smaller than its notes does not make its notes headings.
- Its level comes from its size. The sizes of several headings rank from the largest: 1, 2, then 3
  for all smaller ones. A size of one heading only, larger than all of those (a title, the lines of
  a cover page), is level 1, and the ranks then start at 2: a cover does not flatten the sections
  and subsections under it.
- Each heading is a line of the stored text, and points to it: `read_document` from that line
  starts at the heading. A heading set on several lines in a row is one entry, at its first line.
  A line above it on its page that reads the same (a contents list, a running header in small type)
  is passed over.
- Not headings: a line of more than 120 characters, or of fewer than 3 letters, or with more digits
  than letters (a bare amount, a date in digits, a page number); a table row; a running header or
  footer, which is a line found on 3 pages or more, or on 2 pages and at least half of them.
- A line that differs from those of other pages only by its numbers ("עמוד 3 מתוך 10", "Annual
  Report page 7") is a page number, and not a heading, when it is found on at least half of the
  pages, does not count up on one page (the same number in a page's header and its footer is one
  page number), and does not count as section numbers do. Section numbers count
  headings: each is the one before with one number 1 more, with pages without one between some of
  them ("פרק 1" to "פרק 5" on the odd pages). A page number counts pages, and skips those it is
  missing from: a header on the odd pages only reads "page 1", "page 3". Numbered headings several
  to a page ("Article 1" to "Article 18", 3 to a page; "סעיף 1" to "סעיף 20", 2 to a page above
  their titles) are always kept.
- No outline from sizes when more than 30% of the text is set larger than the body: the sizes then
  mark something else.

It adds no line to the text: the text of a PDF, its reads and its pages are those of 0.9.0, and its
search hits the same but for the `section` they now name. What it does not find: a heading in bold
type of the body's size (pdf.js does not say which text is bold), a heading less than 15% larger
than the body (Word's Heading 3, 12 points over 11), a heading repeated on 3 pages or more,
numbered chapters one to a page on pages in a row that are at least half the document ("Chapter 1"
to "Chapter 4" on pages 1 to 4 of 6: they count as a page number does), and headings a PDF keeps
only in its bookmarks or tags. What it can take for a heading: any other short line set large, such
as a caption, a date written with its month's name, or a total with its label ("Total due
12,500.00"); the header cell of a table that is not rebuilt when pdf.js gives it as a line of its
own; and a header row set large whose cells are closer than 3 times its type size, as in a narrow
table of two columns ("Field" and "Value"), which does not read as a table row. A PDF whose text
gives 3 headings or more (lines that start with `#`) keeps the outline of its text.

A PDF ingested before 0.10.0 keeps the outline it was given, most often none, until it is uploaded
again; the metadata does not say where an outline came from. The outline from sizes comes in
`ExtractedText.headings`: to keep the outline of the text alone, drop them in a wrapper.

```ts
import { createLargeFiles, defaultExtractors, FileDocumentStore, type Extractor } from "llm-large-files";

// The outline of 0.9.0: from the text alone.
const pdfWithoutSizes: Extractor = async (bytes, input) => {
  const { headings, ...extracted } = await defaultExtractors.pdf(bytes, input);
  return extracted;
};

export const files = createLargeFiles({
  store: new FileDocumentStore("./data/large-files"),
  extractors: { pdf: pdfWithoutSizes },
});
```

## Pictures in PDFs

The text of a PDF does not hold its photos, charts and diagrams. Asked about a bar chart from the
text alone, a model can only say that it cannot see it, or guess. Two things, both for PDFs only,
close that gap:

1. **A line in the text that says where the pictures are.** It needs `@cantoo/pdf-lib`.
2. **A tool, `view_pages`, that hands the model the real pages** as a small PDF, when it asks. It
   needs `@cantoo/pdf-lib` and the uploaded file itself, which is kept when you list `"pdf"` in
   `keepOriginals`: by the store, or, since 0.9.0, where your application keeps it
   ([below](#view_pages-from-your-own-uploads)).

```ts
import { createLargeFiles, FileDocumentStore } from "llm-large-files";

export const files = createLargeFiles({
  store: new FileDocumentStore(process.env.LARGE_FILES_DIR ?? "./data/large-files"),
  // view_pages cuts pages out of the uploaded file, so the store keeps it next to the text.
  keepOriginals: ["pdf"],
});
```

Nothing else changes in your code. `askGemini` and `askWithFiles` offer `view_pages` by themselves
for every PDF whose file is kept, when the model can be sent a file
([Which models can see pages](#which-models-can-see-pages)). A kept file takes disk space, up to
`maxUploadBytes`, until the document expires: [Storage](./storage.md) covers originals in your own
store, and [Security](../security.md) what to weigh before you keep them.

The options of this page, and where each is explained:

| Option | Default | What it does |
|---|---|---|
| `keepOriginals` (`createLargeFiles`) | `[]`: no file kept | List `"pdf"` to keep the uploaded file, which `view_pages` and scanned PDFs need ([above](#pictures-in-pdfs)). |
| `originals` (`createLargeFiles`) | none | Reads the uploads your application keeps, so the store keeps no copy ([`view_pages` from your own uploads](#view_pages-from-your-own-uploads)). New in 0.9.0. |
| `scannedPdfPages` (`createLargeFiles`) | 30 | The most pages a PDF without text may have to be accepted, when PDFs are kept. 0 refuses every one ([Scanned PDFs](#scanned-pdfs)). |
| `maxPdfPages`, `maxTextBytes`, `ingestTimeoutMs` (`createLargeFiles`) | 5,000 pages; 100 MB, or `maxUploadBytes` when that is larger; 120,000 ms | The most pages, text and time one file may take at ingest ([What is refused](#what-is-refused)). |
| `tables`, `pictures` (`createPdfExtractor`) | `true` | Rebuild tables; write the line that marks a page with a picture ([PDF tables](#pdf-tables), [The line that marks a page](#the-line-that-marks-a-page)). |
| `viewPages` (`askGemini`, `askWithFiles`) | `true` | Offer `view_pages` for the PDFs whose file is kept ([Limits and cost](#limits-and-cost)). |
| `toolFilePlacement` (`gemini()`, `askGemini`, `anthropic()`) | `"inside"` | Where the pages go in the request ([Where the pages go](#where-the-pages-go-toolfileplacement)). |
| `toolFilePlacement` (`openAiResponses()`) | `"none"` | Where the pages go, or nowhere, which turns `view_pages` off ([Which models can see pages](#which-models-can-see-pages)). New in 0.99.9. |
| `pdfInput` (`openAiCompatible()`) | `false` | Send the pages as a `file` part; without it, no `view_pages` ([Which models can see pages](#which-models-can-see-pages)). |
| `imageInput` (`openAiCompatible()`) | `false` | Send each page as a JPEG in an `image_url` part, for a model that reads images and no PDF ([Pages as images](#pages-as-images)). New in 0.99.9. |
| `documents` (`gemini()`, `askGemini`, `openAiCompatible()`, `openAiResponses()`, `anthropic()`) | none | The files the model reads as they are: a small visual file sent whole goes to it as the file too ([The file itself](#the-file-itself-for-small-visual-files)). New in 0.99.9. |
| `nativeDocuments` (`askGemini`, `askWithFiles`) | `true` | `false` sends text only for one question, though the models declare `documents` ([The file itself](#the-file-itself-for-small-visual-files)). New in 0.99.9. |
| `pageTokens` (`gemini()`, `openAiCompatible()`, `openAiResponses()`, `anthropic()`) | 530, 1,000, 1,000, 3,500 | What a page costs in input tokens ([Limits and cost](#limits-and-cost)). |

A PDF small enough to send whole can also go to the model as a file in your own message, in the
provider's own form ([Conversations](./conversations.md)). The model then sees every page.
`view_pages` is for the PDFs that are too large for that. Since 0.99.9 the library sends small
visual files that way itself, when the model declares `documents`
([The file itself](#the-file-itself-for-small-visual-files)).

### The line that marks a page

At ingest, a page that shows a picture or a drawing gets one line under its header:

```text
--- Page 12 ---
[Picture on this page. This text cannot show it.]
Figure 3: sales by region.
```

The words hold whether or not the model can look at the page later. A search for
`[Picture on this page` lists every such page.

What counts:

- **A picture:** the images on the page cover 3% of it or more, measured by the size they are shown
  at, not by their pixels. A logo covers about 1%. An image that is on 30% of the pages (and on
  three at least) is taken for a logo, a letterhead or a watermark, and does not count, whatever its
  size.
- **A drawing:** shapes filled in three or more colours, outside the tables. Greys, rules, dots and
  page backgrounds do not count, and neither does the shading of a table's cells.
- **A page that paints too much to be text:** drawing instructions larger than 2 MB (a map, a
  technical drawing), more than 20,000 images, or more than 16 MB of instructions once each form (a
  drawing kept apart and painted by name) is counted every time it is painted. Reading such a page
  stops there, so forms painted inside forms cannot hold the server.

What it gets wrong:

- Missed: a chart in one or two colours, and a chart or diagram drawn only with lines.
- Marked by mistake: a table with cells shaded in three colours, when the table itself was not
  recognised (a table of two columns, for example).

The mark is a hint. `view_pages` works on any page, marked or not, and the model is told to look
when a page mentions a figure too.

The pages are found from the structure of the file, without decoding any image, so it is cheap
([measurements](../measurements.md)). No page is marked, and the text is exactly that of version
0.2.0, when:

- `@cantoo/pdf-lib` is not installed;
- you turn it off with `createPdfExtractor({ pictures: false })`;
- the file declares more than 150,000 objects (reading it would take over two seconds), or more
  than about 60% of the free heap can hold;
- finding the pictures, once the file is read, took more than five seconds;
- `@cantoo/pdf-lib` cannot read the file;
- `@cantoo/pdf-lib` counts other pages than the text extractor did.

### `view_pages`

`view_pages(document_id, from_page, to_page)` cuts those pages out of the kept file and returns them
as one PDF, which goes to the model with the tool result. The model reads it like any PDF: text,
pictures and layout. `to_page` defaults to `from_page`. The result says what was shown:

```json
{ "document": "report.pdf", "pages": "12-14", "total_pages": 40, "file": "pages-12-14.pdf" }
```

When fewer pages were shown than asked, it has a `note` that says why, and `next_page` where to go
on, unless the pages the question may show ran out. The exact results and errors are in the
[tools reference](../reference/tools.md).

What the model is told:

- The system instruction lists the PDFs it can look at, with their page counts, and tells it to
  look when the answer depends on a picture, a chart, a diagram, a map, handwriting, a stamp or the
  layout, and not to use the tool to read text.
- The card of a searched PDF says that its text cannot show pictures.
- Search and read results of such a PDF say which page a line is on (`"page": 12` for a match,
  `"pages": "12-14"` for a passage or a read), since a page number is what `view_pages` takes.

It is offered for every PDF whose file is kept, also for one whose text is already in the prompt: a
slide deck of photos has little text, so its text fits, and without the tool the model would see
none of its slides. Such a PDF gets `view_pages` and no search tools.

A look shows up in your steps and in the result:

```ts
import { GoogleAuth } from "google-auth-library";
import { askGemini, vertexAi } from "llm-large-files/gemini";

// files: the library above. reportId: the ID that files.ingest returned. userId: who asks.
const auth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] });
const endpoint = vertexAi({
  project: process.env.GOOGLE_CLOUD_PROJECT!,
  location: "global",
  model: "gemini-3.5-flash-lite",
  accessToken: async () => (await auth.getAccessToken()) ?? "",
});

const result = await askGemini({
  files,
  endpoint,
  owner: userId,
  documentIds: [reportId],
  messages: [{ role: "user", text: "Which region has the tallest bar in the chart on page 12?" }],
  onStep: (step) => console.log(step), // "Look at report.pdf page 12"
});

// The pages the model looked at, for a list of sources under the answer.
const looked = result.evidence.filter((item) => item.tool === "view_pages");
```

A cut holds the pages asked for and little else. Copied the simple way, a contents page brings
along every page it links to. Here every other page is set to null before copying, and a page that
shares one list of images with the whole file (FPDF, TCPDF and jsPDF write PDFs that way) gets a
list of its own. Hidden layers stay hidden, rotated pages and links are kept, and a PDF encrypted
only to restrict printing or copying opens without a password. The cut is not encrypted.

Pages that cannot be shown get an error result, and the model answers from the text:

| Case | The model is told |
|---|---|
| `@cantoo/pdf-lib` is not installed | `report.pdf: Showing PDF pages needs the optional dependency "@cantoo/pdf-lib".` |
| The PDF needs a password to open | `report.pdf: This PDF needs a password to open, so its pages cannot be shown.` |
| The file is damaged | `report.pdf: This PDF could not be read to cut pages from it. It may be damaged.` |
| `@cantoo/pdf-lib` counts other pages than the text has | `report.pdf: The pages of this PDF could not be matched to its text (41 pages against 40), so they cannot be shown.` |
| The file declares more than 1,000,000 objects, or more than about 60% of the free memory can hold | `report.pdf: This PDF has 1,200,000 objects, too many to cut pages from it in memory.` |
| A page past the end | `report.pdf has 40 pages. There is no page 41.` |

What a look costs the server: the whole file is read into memory for every call. At the peak that
is about twice the size of the file, plus 1 to 1.6 KB for each object in it. A file built to
exhaust the server can take far more, because each object is built in one step and nothing checks
it before: a look at a PDF of 8 MB that is one array of one-digit numbers took 422 to 427 MB of
heap, and ran a heap of 256 MB (`--max-old-space-size=256`) out of memory; one of 16 MB ran a heap
of 512 MB out of memory, and took 984 MB on a heap of 2 GB. A look takes more than the ingest of
the same file did (232 to 244 MB for that 8 MB file), so a file that a process of its own ingested
can still stop the server that answers the question. What a stream unpacks to is outside the heap:
a look at a PDF of 1.6 KB whose object stream unpacks to 512 MB took 1.1 GB of the server's
memory. The check on the number of objects does not see such files, which declare few, and what
`@cantoo/pdf-lib` keeps after each look adds up from file to file
([Security](../security.md#reading-pdfs-for-pages-and-pictures)). For the documents of users you
do not trust, do not offer `view_pages` (`viewPages: false`), or keep no PDF originals. Peak memory
for real files is in [measurements](../measurements.md); [Deployment](./deployment.md) sizes
servers for it.

A look parses the file, copies the pages and writes the cut. It pauses after every 12 ms of that
work so that other requests get a turn, or after up to 40 ms where a pause itself takes long, as a
timer does on Windows. It cannot be stopped once it has started. Measured on Windows with Node 24,
a look at three pages of a 2,000-page PDF of 6.2 MB held the server for about 20 ms at a time
(19 to 48 ms on a busy machine), where 0.5.0 held it 159 to 177 ms. Some steps still run in one
block:

- one object of the file: about 0.1 to 0.35 s for each MB, by what it holds, and about 0.03 s for
  each MB of a stream whose length the file gives by reference. A crafted PDF of 16 MB with one
  array of numbers such as `1234.5` held the server 1.6 to 2.7 s at ingest and 1.7 to 2.5 s on each
  look, and 2.7 to 3.5 s on each look when its numbers were of one digit, on a heap that could hold
  it (that look took 984 MB);
- a stream unpacked to reach an object: 1.0 s for an object stream that unpacks to 512 MB;
- a cross-reference stream inside the file that declares many objects: 0.7 s for a million;
- a cross-reference table written as text: 0.15 s for 150,000 objects;
- the first look of a process, which loads `@cantoo/pdf-lib`: about 0.4 s, unless the
  server loads it when it starts ([Deployment](./deployment.md#uploads-and-ingest)).

A look runs on the server that answers the question, not where the file was ingested
([Deployment](./deployment.md#pages-of-pdfs)).

**Looks take their turns** (new in 0.9.0). Looks share the thread of your server, so more of them
at once do not finish sooner: six at once each took about four times as long, and held 352 MB more
than one. So one look runs at a time in a library, over all its questions, and the others wait in
order, before their PDF is loaded:

| Option (`createLargeFiles`) | Default | What it does |
|---|---|---|
| `maxConcurrentPageLooks` | 1 | How many looks run at once. `Infinity` for no limit, as before 0.9.0. |
| `pageLookWaitMs` | 30,000 | How long a look waits for its turn. Past it, it is not run. |

A look that waited too long tells the model "report.pdf: The pages cannot be looked at right now;
the server is busy. Answer from the text, or look again later.", and the question gets a
`page_looks_busy` notice ([events](../reference/events.md#noticecode-and-noticedisplay)). A
question that is stopped stops waiting at once, and loads nothing. A question stopped while its
PDF is read gives the turn back at once, and no pages are cut for it.

A look holds its turn while it reads the PDF from the store, for at most `ingestTimeoutMs` (2
minutes by default). Past it, the turn goes back, the next look runs, and the model reads "The
original file of report.pdf could not be read in time, so its pages cannot be shown. Answer from
the text." Give your store's `getOriginal` a time limit of its own: the read goes on.

How long a question can wait for turns:

- A look waits at most `pageLookWaitMs` (30 s) for its turn. A wait that ends with "busy" happens
  at most once in a tool turn: after a look of the turn was told the server is busy, the other
  looks of that turn do not wait. Each runs if a turn is free at that moment, and is told the
  server is busy if not.
- A look that gets its turn may still have waited for it up to `pageLookWaitMs`. So when other
  questions hold the turn all that time, a tool turn can wait up to `pageLookWaitMs` for each of its
  looks: 8 looks of 30 s, 4 minutes, with the defaults (`callsPerTurn` 8), and a question waits that
  in each tool turn that looks at pages.
- Lower `pageLookWaitMs`, or raise `maxConcurrentPageLooks`, for a chat that must answer sooner.

### `view_pages` from your own uploads

New in 0.9.0. When your application keeps each upload anyway, the store need not keep a second
copy of the PDF. Give the ingest where the file is (`original: { ref }`), and the library a reader
of your uploads (`originals`): `fileOriginals(root)` of `llm-large-files/node` reads them from a
folder.

```ts
import path from "node:path";
import { createLargeFiles, FileDocumentStore } from "llm-large-files";
import { fileOriginals } from "llm-large-files/node";

const VOLUME = process.env.DOCUMENTS_DIR!;

export const files = createLargeFiles({
  store: new FileDocumentStore(VOLUME, { scopes: { depth: 2 } }),
  keepOriginals: ["pdf"],
  originals: fileOriginals(VOLUME),
});

/** Ingests a PDF your upload route saved under <VOLUME>/<user>/<chat>/uploads/. */
export function ingestSaved(userId: string, chatId: string, uploadId: string, name: string) {
  const ref = `${userId}/${chatId}/uploads/${uploadId}`;
  return files.ingest({ name, source: { path: path.join(VOLUME, ref) }, original: { ref }, owner: userId, scope: [userId, chatId], id: uploadId });
}
```

- The model sees nothing of this: the ref is never in the prompt, the cards or the results.
- A look reads the file through the reader, within its turn and its time, as it reads a copy from
  the store. The metadata records the size and SHA-256 the file had at ingest, and the look
  compares them. A file that has changed since (saved again under the same name, cut short, edited)
  is not cut, and the model reads "report.pdf changed on the server since it was read. Attach it
  again to look at its pages.": its pages would not match the text the model has. A file that is
  gone reads as "The original file of report.pdf is no longer on the server, so its pages cannot
  be shown. Answer from the text."
- `files.delete` and the sweep never touch your upload. Remove it with its chat.
- A scanned PDF is accepted with a ref as with a copy in the store ([Scanned PDFs](#scanned-pdfs)),
  even over a store without `putOriginal`.
- [Storage](./storage.md#keeping-the-uploaded-files) has the rules for the ref and a reader of your
  own, and [Security](../security.md#originals-your-application-keeps) what `fileOriginals`
  refuses.

### Limits and cost

| Limit | Value | When it is reached |
|---|---|---|
| Pages per call | 5 (`MAX_VIEW_PAGES`) | The result has `next_page`, and a note that says to call again from there. |
| Bytes per call | What is left of `maxRequestBytes`, less a tenth kept free (256 KB at least), times 3/4 for base64 | Pages are left off the end of the call. A first page that does not fit by itself is an error, and the model answers from what it has. |
| Pages per question | Half of `reservedTokens`, divided by what a page costs: 60 on Gemini, 32 on an OpenAI-compatible model with `pdfInput`, 12 on Claude, with the default budget | `No more pages can be looked at for this question. Answer from the pages and the text you already have.` |

What a page costs is what the adapter declares as `pageTokens`, in input tokens: 530 for `gemini()`
(Gemini bills 520 to 532 a page, whatever is on it), 1,000 for `openAiCompatible()` and
`openAiResponses()`, and 3,500 for
`anthropic()`, a page's text and its picture, which the loop counts at Claude's `tokenScale` of 1.35.
Set `pageTokens` on the adapter (`gemini(endpoint, { pageTokens })`, `openAiCompatible({ pageTokens })`,
`anthropic({ pageTokens })`) when your model bills otherwise. `askGemini` has no such option: use
`askWithFiles` with `gemini()` for that. A smaller window means a smaller
`reservedTokens`, and fewer pages: [Costs and limits](./costs-and-limits.md) explains the budget.

Pages stay in the request until the question is answered, so every look makes each later request of
that question larger, and each of them bills the pages again. Only when the request runs short of
room are the older tool rounds, pages included, replaced by short stand-ins that say the pages are
no longer attached; when Claude takes part in the question, they never are ([How it works](../how-it-works.md)). Pages are not
sent with the next question: `toolTurns` keep only that the pages were shown. Turn the tool off for
one question with `viewPages: false` on `askGemini` or `askWithFiles`.

### Which models can see pages

The pages are a file. A model that cannot be sent one in a tool result does not get `view_pages`,
and with an [explorer model](./explorer-model.md), both models must be able to take the same kind
of file: the answering model reads the same pages. The kind is one small PDF, or, since 0.99.9,
each page drawn as an image ([Pages as images](#pages-as-images)).

| Adapter | How the pages are sent | Setting | `pageTokens` |
|---|---|---|---|
| `gemini()`, `askGemini` | Inside the function response (default), or in a user turn after it | `toolFilePlacement`: `"inside"` or `"beside"` | 530 |
| `anthropic()` | A `document` block inside the `tool_result` (default), or after the tool results in the same user turn, or not at all | `toolFilePlacement`: `"inside"`, `"beside"` or `"none"` | 3,500 |
| `openAiCompatible()` | Not at all (default); a `file` part in a user message after the tool messages; or each page as a JPEG `image_url` part there | `pdfInput: true`; `imageInput: true` (0.99.9) | 1,000 |
| `openAiResponses()` | Not at all (default), as an `input_file` part (a page drawn as an image: `input_image`) inside the `function_call_output`, or in a user message after the outputs | `toolFilePlacement`: `"inside"`, `"beside"` or `"none"` | 1,000 |
| An adapter of your own | As its `capabilities.toolFiles` says, of the kinds `capabilities.toolFileTypes` lists (left out: PDF) | `"inside"`, `"beside"` or `"none"` | `capabilities.pageTokens` |

```ts
import { askWithFiles } from "llm-large-files";
import { anthropic } from "llm-large-files/anthropic";
import { gemini, vertexAi } from "llm-large-files/gemini";
import { openAiCompatible } from "llm-large-files/openai";

// auth, files, reportId and userId as above. Any of the three adapters below can be the model
// (or the explorer): view_pages is offered for each.
// Gemini 2.5 does not see a file inside a function response: send the pages beside it.
const gemini25 = gemini(
  vertexAi({
    project: process.env.GOOGLE_CLOUD_PROJECT!,
    model: "gemini-2.5-flash-lite",
    accessToken: async () => (await auth.getAccessToken()) ?? "",
  }),
  { toolFilePlacement: "beside" },
);

// Claude: the pages go inside the tool result by default. "none" takes view_pages away.
const claude = anthropic({ model: "claude-opus-5-5", apiKey: process.env.ANTHROPIC_API_KEY! });

// An OpenAI-compatible model that reads PDF input. Without pdfInput, view_pages is not offered.
const gpt = openAiCompatible({
  model: process.env.OPENAI_MODEL!,
  apiKey: process.env.OPENAI_API_KEY!,
  pdfInput: true,
});

// Here Claude answers; gemini25 or gpt in its place works the same way.
const answer = await askWithFiles({
  files,
  model: claude,
  owner: userId,
  documentIds: [reportId],
  messages: [{ role: "user", text: "What does the stamp on the last page say?" }],
});
```

`pdfInput` is off by default because many servers behind the OpenAI API take no PDF at all, and a
tool message holds text only. Gemini's own OpenAI-compatible endpoint refuses the `file` part with
HTTP 400: use `gemini()` for Gemini. The page parts of `anthropic()` and of `pdfInput` follow the
request shapes of the providers' documentation; [measurements](../measurements.md) lists what has
been run live. The provider guides cover the rest of each setup: [Vertex AI and
Gemini](./vertex-and-gemini.md), [Claude](./anthropic.md), [OpenAI-compatible
endpoints](./openai-compatible.md).

### Where the pages go: `toolFilePlacement`

On Gemini:

| `toolFilePlacement` | What is sent | Gemini 3.5 Flash-Lite, Gemini API and Vertex AI | Gemini 2.5 Flash-Lite, Vertex AI |
|---|---|---|---|
| `"inside"` (default) | The PDF in the `parts` of its function response, which names it as `{ "$ref": "pages-12-14.pdf" }` | Works | Accepted and billed, but the model does not see the pages |
| `"beside"` | The function responses in one `user` turn, then the PDFs in a `user` turn of their own, each after a line that names it | Works | Works |

The table is from live checks ([measurements](../measurements.md)). Keep the default for Gemini 3
models, and use `"beside"` for Gemini 2.5: it takes a file inside a function response without an
error, bills its tokens, and then answers that it cannot see the page. For another model, ask it
once about a chart and check that it reads it.

With `"beside"`, the files get a turn of their own because Vertex AI refuses a turn in which anything
follows a function response (HTTP 400). `askGemini` takes the option for the model and its explorer
together:

```ts
import { askGemini, vertexAi } from "llm-large-files/gemini";

// auth, files, reportId and userId as above.
const result25 = await askGemini({
  files,
  endpoint: vertexAi({
    project: process.env.GOOGLE_CLOUD_PROJECT!,
    model: "gemini-2.5-flash-lite",
    accessToken: async () => (await auth.getAccessToken()) ?? "",
  }),
  owner: userId,
  documentIds: [reportId],
  messages: [{ role: "user", text: "What does the chart on page 3 show?" }],
  toolFilePlacement: "beside",
});
```

On Claude, `"inside"` puts a `document` block in the `tool_result` itself, and `"beside"` puts the
blocks after all the tool results of the turn, each after a line that names it: the Messages API
refuses text before a tool result. A tool file that is an image goes as an `image` block (since
0.99.9).

### Pages as images

Most servers behind the Chat Completions API (vLLM, DeepSeek, Ollama) read images and no PDF. Since
0.99.9, `view_pages` can draw each page as an image for them. The loop picks one kind of page for a
question, from what every model takes (`capabilities.toolFileTypes`):

1. One small PDF, when every model takes `"application/pdf"`. A model that does not say takes only
   that, as before 0.99.9.
2. Else a JPEG of each page, when every model takes `"image/jpeg"`. JPEG came out 14 to 34% smaller
   than PNG on the test PDFs, so more pages fit.
3. Else a PNG of each page, when every model takes `"image/png"`.
4. Else no `view_pages`.

`openAiCompatible({ imageInput: true })` takes PNG and JPEG; with `pdfInput` too, PDF comes first.
`openAiResponses()` with a `toolFilePlacement` takes all three. `gemini()` and `anthropic()` declare
no list, so they take PDF, which they read.

```ts
import { openAiCompatible } from "llm-large-files/openai";

// A vision model behind vLLM: pages go as JPEG images after the tool messages.
const model = openAiCompatible({
  baseUrl: "http://vllm.internal:8000/v1",
  model: "Qwen/Qwen3-VL-32B-Instruct",
  imageInput: true,
});
```

Drawing pages needs two optional dependencies, which run on Node 24 or later:

```bash
npm install unpdf@2 @napi-rs/canvas
```

`unpdf` 2 declares Node 24 or later. On Node 22, npm installs it with an `EBADENGINE` warning (an
error with `engine-strict`). It drew pages on Node 22.23.5 in our test, but unpdf does not support
that Node and CI does not run it there: on Node 22, use a model that takes PDF. With unpdf 1, which
Node 22 runs, each look answers the model with the error below, and the model answers from the text.
`@napi-rs/canvas` is a native binary for each platform: npm installs the one of the machine it runs
on ([Deployment](./deployment.md)).

The result names one file per page in `images`, in place of `file`:

```json
{ "document": "report.pdf", "pages": "2-3", "total_pages": 6, "images": ["page-2.jpg", "page-3.jpg"] }
```

Each page is drawn at 1,568 pixels on its longest side (`PAGE_IMAGE_SIDE`), Claude's standard
size, which the other providers take too. A JPEG has quality 0.85. Each image is one page: it costs
`pageTokens`, as a page of a PDF does. The limits of a look are those of a PDF cut
([Limits and cost](#limits-and-cost)): five pages a call, the bytes the request has room for, the
pages the question may show, and one look at a time in the library. Two more:

- **5 seconds a call.** A page is not started when the time so far and the slowest page so far would
  pass it. The result has `next_page` and the note `…: the others took too long to draw. Call
  view_pages from page N if you need them.`
- **40 million pixels an image.** pdf.js leaves an image of a page that has more blank: a scan of an
  A4 page at 600 dpi has 35 million.

Drawing holds the server's thread. On Node 24, with unpdf 2.1.0 and @napi-rs/canvas 1.1.0, the first
page of the process took 0.2 to 0.5 s after 0.55 to 0.6 s of loading, and later pages 0.09 to 0.18
s; the longest the event loop went without a turn was 0.37 s
([measurements](../measurements.md#pages-drawn-as-images-0999)). Timers and requests of other users
run between two pages. Turn `view_pages` off for files of users you do not trust
([Security](../security.md#reading-pdfs-for-pages-and-pictures)).

What a look at images answers when it cannot draw:

| Error | Why |
|---|---|
| `Showing pages as images needs the optional dependency "unpdf".` | unpdf is not installed |
| `Showing pages as images needs unpdf 2 or later, which runs on Node 24 or later.` | unpdf 1 is installed |
| `Showing pages as images needs the optional dependency "@napi-rs/canvas".` | The canvas is not installed |
| `The optional dependency "@napi-rs/canvas" is installed but could not be loaded (…). Reinstall it, or install a version this Node can run.` | A binary of another platform, or a broken install |
| `This PDF could not be read to draw its pages. It may be damaged.` | pdf.js cannot open the file |
| `Page N could not be drawn. It may be damaged.` | One page of the call failed |
| `Page N is 3 MB as an image, more than the 2 MB that fit in this request.` | The first page asked for does not fit |

Each starts with the file's name, and the others are those of a PDF cut. A missing dependency does
not take the tool away, as a missing `@cantoo/pdf-lib` does not: install it.

vLLM refuses a request with more images than `--limit-mm-per-prompt` allows (HTTP 400). A question
may hold its pages from several looks: start the server with a limit of at least the pages a
question may show (32 with the default budget and `pageTokens` of 1,000), or lower that number with
`budget.reservedTokens`.

### When `view_pages` is missing

The model gets `view_pages` for a PDF only when all of these hold:

- `keepOriginals` lists `"pdf"`, and the store has `putOriginal` and `getOriginal`, or (0.9.0)
  the document was ingested with `original` and the library has `originals`.
  `FileDocumentStore` and `MemoryDocumentStore` have both. Documents ingested before you turned it
  on have no file kept: upload them again. `meta.originalKept` says whether a document has one.
- Every model of the question can be sent a file: not `openAiCompatible()` without `pdfInput` or
  `imageInput`, not `openAiResponses()` without `toolFilePlacement`, not
  `anthropic({ toolFilePlacement: "none" })`. And all of them take one kind of file: with an
  explorer, `gemini()` (PDF) and `openAiCompatible({ imageInput: true })` (images) share none
  ([Pages as images](#pages-as-images)).
- The PDF is not sent to the model as the file itself: then it has every page already
  ([The file itself](#the-file-itself-for-small-visual-files)).
- The question does not set `viewPages: false`.
- In a loop of your own, you asked for it ([Your own tool loop](#your-own-tool-loop)).

The tool is offered without `@cantoo/pdf-lib` too, and then every call answers with the error above:
install it. The same holds for pages as images without unpdf 2 and `@napi-rs/canvas`. If the tool is offered and the model never calls it, the text may be enough. In a live
test, ten questions that the text answers led to no look at all ([measurements](../measurements.md)).
[Troubleshooting](../troubleshooting.md) has more symptoms.

## Scanned PDFs

A PDF without text on any page (a scan, or pages of photos) has nothing to search. When its file is
not kept, it is refused at ingest:

```text
This PDF has no text layer (it may be scanned). It needs OCR before it can be searched.
```

When its file is kept, the model can read it by looking at its pages, so a scan of up to
`scannedPdfPages` pages is accepted. Each page of its text is its `--- Page N ---` line and the line
for a page without text (with `@cantoo/pdf-lib`, the picture line too). That text is short, so it
usually goes into the prompt whole, and the model gets `view_pages` and no search tools. A longer
scan is refused:

```text
This PDF has no text layer (it may be scanned) and 31 pages. Without text it can only be read by looking at its pages, which works for up to 30 pages. It needs OCR first.
```

```ts
import { createLargeFiles, FileDocumentStore } from "llm-large-files";

export const files = createLargeFiles({
  store: new FileDocumentStore("./data/large-files"),
  keepOriginals: ["pdf"], // without it, every scan is refused
  scannedPdfPages: 30,    // the default. 0 refuses every scan.
});
```

`scannedPdfPages` has an effect only when PDFs are kept: by a store that can keep them, or (0.9.0)
by their ref, for an ingest with `original` in a library with `originals`. A PDF with
text on any page is always accepted, however many of its pages are scans: those pages say that they
have no text, and with the file kept the model can look at them.

Raising `scannedPdfPages` lets longer scans in, but the model still reads them five pages a call,
within the pages a question may show ([Limits and cost](#limits-and-cost)) and its tool turns, and
nothing in them can be searched. A long scan needs text: OCR it, at ingest or before
([OCR](#ocr)). A short scan can also go to the model as the file itself
([below](#the-file-itself-for-small-visual-files)).

## The file itself, for small visual files

Gemini, Claude and OpenAI's models read a PDF sent in a user turn: its text, pictures and layout.
Since 0.99.9, a small visual file sent whole can go to the model that way too, so the model sees its
pictures in the first request, without a look. It is off until the model declares it, with the
`documents` option of its adapter:

```ts
import { askGemini, geminiApi } from "llm-large-files/gemini";

// files, reportId and userId as above; the library keeps PDFs and decks (keepOriginals).
const result = await askGemini({
  files,
  endpoint: geminiApi({ apiKey: process.env.GEMINI_API_KEY!, model: "gemini-3.5-flash-lite" }),
  // On the Gemini API, decks too. On Vertex AI, list "pdf" only.
  documents: { formats: ["pdf", "pptx"] },
  owner: userId,
  documentIds: [reportId],
  messages: [{ role: "user", text: "What does the chart on page 2 show?" }],
});
```

| Adapter | Formats | Sent as |
|---|---|---|
| `gemini()`, `askGemini` | `"pdf"`; `"pptx"` on the Gemini API | `inlineData` of the file's type |
| `anthropic()` | `"pdf"` | A `document` block |
| `openAiCompatible()` | `"pdf"` | A `file` part |
| `openAiResponses()` | `"pdf"` | An `input_file` part |

`documents` takes `formats`, and two limits: `maxFileBytes` (default 4 MiB,
`DEFAULT_NATIVE_FILE_BYTES`) and `maxPages` (default 10, `DEFAULT_NATIVE_PAGES`; slides, for a
deck). With an explorer, both models must declare it: the formats they share and the smaller limits
are used. `nativeDocuments: false` on one question sends text only.

A file goes as itself when all of these hold:

- it is sent whole, not searched;
- its format is listed in `documents.formats`;
- its file is kept (`keepOriginals` lists its format) and can be read;
- it is visual: a PDF with a picture line or a page without text, or any deck;
- its text has no table the tools count (`aggregate_table`): a table is counted from its text;
- it is within `maxFileBytes` and `maxPages`;
- it fits in the room the plan leaves, after the text of the files sent whole and the cards, in the
  order of the plan.

So a log, a CSV, a text, Markdown, JSON, HTML, XLSX or DOCX file never goes, nor a PDF with no
picture. DOCX is left out: the library cannot tell a document with pictures from one without, the
Messages API and Chat Completions do not read it, and Vertex AI refused one with HTTP 400 on Gemini
3.1 and 3.5 Flash-Lite. An extractor of your own (OCR) that writes no picture line and no page
count sends no file.

The file never replaces the text. Line citations, counts and the tools work from the text, as
before. The file goes first in the turn that holds the documents' text, with this line right before
the text:

```text
The file attached above is "report.pdf", as it was uploaded. Look at it for its pictures, charts and layout. Cite and count from its text below.
```

Such a PDF gets no `view_pages`: the model has every page. A question over only such files is
answered in one request, without tools. Its evidence has an entry with `tool: "original"` and every
page, right after the entry of its text.

What it costs: each page again on every question of the chat, at `pageTokens` (about 530 tokens a
page on Gemini, 3,500 on Claude), and its bytes as base64. The files stay at the start of the
documents' turn, so a provider's prompt cache can reuse them. Vertex AI: list `"pdf"` only. It
refused an inline DOCX with HTTP 400 on Gemini 3.1 and 3.5 Flash-Lite, and Google documents Office
files on Vertex AI for Gemini 4 models only. The library does not ask again without the files: the
error is raised as it is ([Troubleshooting](../troubleshooting.md)).

## Custom extractors

An extractor turns the bytes of one format into text:
`(bytes, input) => Promise<{ text: string; pages?: number }>`. `input` has the file's `name`, its
`mimeType` and its `format`, and for a PDF, `scannedPages` ([below](#rules-for-a-pdf-extractor)).
Pass yours in `extractors`, by format. The other formats keep the built-in extractors, which
`defaultExtractors` holds, one per format ([`Extractor`](../reference/library.md#extractor),
[`defaultExtractors`](../reference/library.md#defaultextractors)).

`input` also carries the limits of the ingest, for your extractor to honour
([`ExtractInput`](../reference/library.md#extractinput)):

| Field | What it is | What to do with it |
|---|---|---|
| `signal` | Aborted after `ingestTimeoutMs` (2 minutes by default), or when the caller's `IngestInput.signal` aborts. Its `reason` is the error to throw. | Pass it to the work you start (`fetch(url, { signal: input.signal })`), and call `input.signal?.throwIfAborted()` between long steps. When it aborts, `ingest` stops waiting for your extractor and throws; work that does not look at the signal goes on in the background until it ends. |
| `maxTextBytes` | `maxTextBytes` of `createLargeFiles`: the most text kept from one file, in UTF-8 bytes. | Refuse the file as soon as your text passes it, with a message for the user. `ingest` refuses a larger text when you return it, but by then it is all in memory. |
| `maxPages` | `maxPdfPages` of `createLargeFiles`: the most pages read from one PDF. | In a PDF extractor, refuse a file with more pages before you read them. `ingest` does not check it for you. |

The built-in PDF, DOCX, PPTX and XLSX extractors honour all three, so an extractor that wraps one,
as the OCR example below does, gets them by passing `input` on. The text extractor decodes a valid
UTF-8 file in one step, and a file in another encoding in steps that stop when `signal` aborts; its
text is checked against `maxTextBytes` when it returns.

The ten formats are fixed: you can replace the extractor of a format, not add a format. A file of
another kind, such as XML, RTF or an OpenDocument file, is detected as `text`, so it goes to the
`text` extractor: check the name or the MIME type there ([Other formats](#other-formats)).

What the library does with what you return:

- The text is made uniform, as for the built-in extractors ([Formats](#formats)). A text that is
  empty is refused: `report.pdf did not contain any text.`
- `pages` becomes `meta.pages`, which the card, the system instruction and `toDocumentSummary` show.
- `encoding`, the older encoding your extractor read the file in, becomes `meta.encoding`. It is
  kept when it is a name such as `iso-8859-2`, and dropped when it names UTF-8 or UTF-16 (`utf-8`,
  `utf8`, `unicode`, `utf-16be`…), or is not such a name: a value that is not a string, is longer
  than 40 characters, or holds a character other than letters, digits, `.`, `_`, `:` and `-` (a
  space, say).
- `replacedCharacters`, a whole number above 0, becomes `meta.replacedCharacters`: the characters
  your extractor stored as U+FFFD. Both reach the card, the frame of a file sent whole, and
  `toDocumentSummary` ([Text encodings](#text-encodings)).
- A `text` file whose lines look like a log becomes `log`.
- `headings`, for a PDF, become its outline when its text gives fewer than 3 headings and 3 or more
  of them are found ([PDF outline](#pdf-outline)): each is looked for among the lines of its page,
  after the line `--- Page N ---`, by its text without spaces, past the `skip` lines of its page
  that read the same. New in 0.10.0.

An error you throw is the answer to the upload. `ingest` throws it as an `IngestError` with the
same message (and your error as `cause`), with the code its message gives
([`ingestErrorCodeOf`](../reference/library.md#ingesterrorcodeofmessage)). `createDocumentHandlers`
answers 422 with your message only when the message gives a code the library knows ("is protected
by a password", say). Any other message gives code `"unreadable"`, and since 0.9.0 the answer is
then 422 in fixed words: `This file could not be read. It may be damaged, or not of the type its
name says.` Your message stays on the error, for your log ([what is refused](#what-is-refused)). To
have your own words shown, throw `new IngestError(code, message)` with the code that fits
([`Extractor`](../reference/library.md#extractor)).

An error with a `status` (or `statusCode`) from 400 to 599 is answered with that status and your
message. A status of 413 is answered with the upload-limit message instead of yours. An error with
a Node system `code` and `syscall` (from `fs` or a socket) is answered 500, `Upload failed
(ENOENT).`, without its message. A value that is not an `Error`, such as a thrown string, is
answered 500 too: `Upload failed.` Write messages a user can read, and give a status when the fault
is on your side, such as an OCR service that is down.

### Rules for a PDF extractor

The tools find pages through the text, so a PDF extractor of your own must write it the way the
built-in one does:

1. **Start each page with a line `--- Page N ---`,** exactly that, on a line of its own, with N
   counting from 1 in page order. Only lines that continue the count are taken for pages. Search and
   read results take their page numbers from these lines, and the model passes them to
   `view_pages`. Without them, the model cannot tell which page a line is on.
2. **Return `pages`, the number of pages of the file.** `view_pages` refuses to cut a file in which
   `@cantoo/pdf-lib` counts another number, since a page number could then point at the wrong page.
   Without `pages`, that check is not made, and the card and the instruction give no page count.
3. **Honour `input.scannedPages`.** The library sets it on every PDF it ingests when PDFs are kept
   (`keepOriginals` lists `"pdf"`, and the store has `putOriginal` or the ingest gives `original`
   to a library with `originals`) and `scannedPdfPages` is above 0.
   It does not say that the file has no text: its value is `scannedPdfPages`, the most pages a PDF
   without any text may have. Unset, refuse a PDF in which you found no text. The library does not check
   this for you: page lines alone are text, so a scan your extractor lets through is stored even
   when the model can never see it.

The simplest way to keep all of this, and the rebuilt tables and picture marks, is to wrap
`createPdfExtractor()` and change only what you need, as the OCR example below does.

### OCR

The library does no OCR. To make scans searchable, wrap the built-in PDF extractor and fill in the
pages it found no text on with the text of your OCR service. Here `OCR_URL` is a service of your own
that takes a PDF and answers `{ "pages": ["text of page 1", "text of page 2", ...] }`; Document AI,
Textract or Tesseract can stand behind it.

```ts
import { createLargeFiles, createPdfExtractor, FileDocumentStore, type Extractor } from "llm-large-files";

/** The text of each page of a PDF, in page order, from your OCR service. */
async function recognizePages(pdf: Uint8Array, signal: AbortSignal | undefined): Promise<string[]> {
  const response = await fetch(process.env.OCR_URL!, {
    method: "POST",
    headers: { "Content-Type": "application/pdf" },
    body: Buffer.from(pdf),
    signal, // the ingest's time limit stops the request too
  });
  if (!response.ok) throw new Error(`The OCR service answered ${response.status}.`);
  const { pages } = (await response.json()) as { pages: string[] };
  return pages;
}

const builtIn = createPdfExtractor();
/** A page the built-in extractor found no text on: its line, the picture line if any, and the line that says it has no text. */
const PAGE_WITHOUT_TEXT =
  /^(--- Page (\d+) ---\n(?:\[Picture on this page\. This text cannot show it\.\]\n)?)\[No text on this page\. It may be a scan, a photo, or a chart\.\]$/gm;

const pdfWithOcr: Extractor = async (bytes, input) => {
  // Let a PDF without any text through for now: OCR may give it some.
  const extracted = await builtIn(bytes, { ...input, scannedPages: Number.MAX_SAFE_INTEGER });
  const blank = [...extracted.text.matchAll(PAGE_WITHOUT_TEXT)].length;
  if (blank === 0) return extracted;

  let recognized: string[];
  try {
    recognized = await recognizePages(bytes, input.signal);
  } catch (error) {
    // Stopped by the ingest's time limit or its caller: throw what stopped it.
    input.signal?.throwIfAborted();
    // With a status, the upload answers 503 and this message, not 422 and the service's own error.
    throw Object.assign(new Error("Text recognition is not available. Try again later.", { cause: error }), { status: 503 });
  }

  let filled = 0;
  const text = extracted.text.replace(PAGE_WITHOUT_TEXT, (page, header: string, number: string) => {
    const words = recognized[Number(number) - 1]?.trim();
    if (!words) return page;
    filled++;
    return `${header}${words}`;
  });
  // Nothing recognized in a PDF without any text: the built-in rules decide. It is refused, or
  // accepted when its pages can be shown.
  if (filled === 0 && blank === extracted.pages) return builtIn(bytes, input);
  // The rest as the built-in extractor returned it: `pages`, and the headings of the outline.
  return { ...extracted, text };
};

export const files = createLargeFiles({
  store: new FileDocumentStore("./data/large-files"),
  keepOriginals: ["pdf"],
  extractors: { pdf: pdfWithOcr },
});
```

What this keeps: the page lines, so search results still give page numbers; `pages`; the rebuilt
tables, the picture marks and the outline from type sizes of the pages that had text; and the
picture line over a scanned page, since the model can still look at it to check a stamp or a
signature. Only PDFs with a page without text go to the OCR service, and only those pages change. A
scan of any length is accepted once OCR found text in it.

OCR runs inside `files.ingest`, so the upload waits for it, and it counts toward `ingestTimeoutMs`
(2 minutes by default). For long scans, raise `ingestTimeoutMs` (0 sets no limit), run ingest in a
background job, and tell the user when the file is ready ([Web app](./web-app.md)).

### Other formats

A file the library does not know arrives at the `text` extractor. Since 0.8.0 HTML and XLSX have
extractors of their own. This one reads OpenDocument text (`.odt`) with a converter of yours, and
leaves every other file to the built-in extractor:

```ts
import { createLargeFiles, defaultExtractors, FileDocumentStore, type Extractor } from "llm-large-files";

// Assumed: odtToText() is your converter of OpenDocument text, with a package or a LibreOffice service.
declare function odtToText(bytes: Uint8Array, signal?: AbortSignal): Promise<string>;

const text: Extractor = async (bytes, input) => {
  // An .odt is a ZIP inside: the built-in extractor would refuse it as a ZIP archive.
  if (/\.odt$/i.test(input.name)) return { text: await odtToText(bytes, input.signal) };
  // The built-in extractor decodes UTF-8 and UTF-16, reads Hebrew, Arabic, Cyrillic, Japanese and
  // Western files in their older encodings, and refuses binary files.
  return defaultExtractors.text(bytes, input);
};

export const files = createLargeFiles({
  store: new FileDocumentStore("./data/large-files"),
  extractors: { text },
});
```

Its format stays `text`.

## Your own tool loop

`view_pages` returns a file, and a loop that dropped it would tell the model that pages are attached
when nothing is. So `files.tools()` declares it only when you say that your loop delivers files:
pass `viewPages: true` to `files.prepare()`, pass `prepared.viewable` as `viewPages` to
`files.tools()`, run calls with `executeWithFiles`, and send each file it returns with its tool
result, in your provider's form. `execute("view_pages", …)` answers with an error instead:
`The pages could not be shown: this application does not pass files from tools to the model. Answer from the text.`
Without limits, one call may use 3/8 of what is left of `maxRequestBytes` after 256 KB (3,651,696
bytes with the default of 10,000,000), and five pages. For a model without PDF input, pass
`pageImages: { format: "jpeg" }` to `files.tools()`: each page comes back as an image
([Pages as images](#pages-as-images)). `files.prepare({ nativeDocuments })` lists in `native` the
small visual files to send before their text ([The file itself](#the-file-itself-for-small-visual-files)).
[Your own adapter and loop](./own-adapter-and-loop.md) walks through it.
