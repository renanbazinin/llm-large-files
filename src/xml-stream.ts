/**
 * A small XML reader for the parts of Office files: tags with their attributes, and the text
 * between them, from XML that may come in pieces as it is unpacked. It keeps one tag at a time, so
 * the memory it holds does not grow with the XML. It is not a validating parser: Office files are
 * machine-written, and what matters here is that a hostile one cannot make it slow or large.
 */

/** A tag is read up to this many characters; a longer one is refused: no tag of an Office file comes near. */
const MAX_TAG_CHARACTERS = 64 * 1024;

/** Attributes of a tag, by their full name (`w:val`, `r:id`). */
export type XmlAttributes = Record<string, string>;

export type XmlHandlers = {
  /** A start tag, or an empty one (`<w:br/>`), which gets no `close`. */
  open?(name: string, attributes: XmlAttributes, empty: boolean): void;
  close?(name: string): void;
  /** Text between tags, with its entities decoded. It may come in more than one piece. */
  text?(text: string): void;
};

/** Decodes the five XML entities and character references. */
export function decodeEntities(value: string): string {
  if (!value.includes("&")) return value;
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (match, entity: string) => {
    const lower = entity.toLowerCase();
    if (lower === "amp") return "&";
    if (lower === "lt") return "<";
    if (lower === "gt") return ">";
    if (lower === "quot") return "\"";
    if (lower === "apos") return "'";
    const code = lower.startsWith("#x") ? Number.parseInt(lower.slice(2), 16) : Number.parseInt(lower.slice(1), 10);
    return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
  });
}

/** White space, as XML and HTML count it between attributes. */
const isSpace = (code: number) => code === 32 || code === 9 || code === 10 || code === 13 || code === 12;

/**
 * The attributes in the inside of a tag, after its name: `name="value"` or `name='value'`, in one
 * pass. A regular expression backtracked from every position of a tag with no "=": a 64 K tag
 * took 6.5 s. A name without a value, or with an unquoted one (HTML's `href=x`), is read too.
 */
export function parseAttributes(inside: string): XmlAttributes {
  const attributes: XmlAttributes = Object.create(null) as XmlAttributes;
  const length = inside.length;
  let at = 0;
  while (at < length) {
    while (at < length && (isSpace(inside.charCodeAt(at)) || inside[at] === "/")) at++;
    const start = at;
    while (at < length && !isSpace(inside.charCodeAt(at)) && inside[at] !== "=" && inside[at] !== "/" && inside[at] !== ">") at++;
    const name = inside.slice(start, at);
    while (at < length && isSpace(inside.charCodeAt(at))) at++;
    if (inside[at] !== "=") {
      if (name) attributes[name] = "";
      if (at === start) at++;
      continue;
    }
    at++;
    while (at < length && isSpace(inside.charCodeAt(at))) at++;
    const quote = inside[at];
    let value: string;
    if (quote === "\"" || quote === "'") {
      const end = inside.indexOf(quote, at + 1);
      value = inside.slice(at + 1, end === -1 ? length : end);
      at = end === -1 ? length : end + 1;
    } else {
      const begin = at;
      while (at < length && !isSpace(inside.charCodeAt(at)) && inside[at] !== ">") at++;
      value = inside.slice(begin, at);
    }
    if (name) attributes[name] = decodeEntities(value);
  }
  return attributes;
}

/**
 * Reads XML given in pieces with `write`, and calls the handlers as tags and text go past.
 * Comments, processing instructions and declarations are skipped; the text of a CDATA section is
 * given as text. It reads in one loop, with no recursion, whatever the number of tags in a piece.
 */
export class XmlStream {
  private state: "text" | "tag" | "comment" | "cdata" = "text";
  /**
   * What is kept from the last piece, to be read again in front of the next one: the inside of a
   * tag read so far, the start of a "<!" that cannot be told yet, or the last two characters of a
   * comment or CDATA section, where its end mark may start.
   */
  private kept = "";
  /** In a tag: how much of `kept` has been scanned, and the quote of the attribute value it is in. */
  private scanned = 0;
  private quote = 0;

  constructor(private readonly handlers: XmlHandlers) {}

  write(piece: string): void {
    const xml = this.kept + piece;
    const length = xml.length;
    // In a tag, the inside starts at 0 and has been scanned up to `scanned`.
    let tagStart = 0;
    let at = this.state === "tag" ? this.scanned : 0;
    this.kept = "";
    this.scanned = 0;
    while (at < length) {
      if (this.state === "text") {
        const start = xml.indexOf("<", at);
        if (start === -1) {
          // An entity cut at the end of the piece ("&am" + "p;") is read with the next piece.
          const amp = xml.lastIndexOf("&");
          const cut = amp >= at && length - amp <= MAX_ENTITY && !xml.includes(";", amp) ? amp : length;
          if (cut > at) this.handlers.text?.(decodeEntities(xml.slice(at, cut)));
          this.kept = xml.slice(cut);
          return;
        }
        if (start > at) this.handlers.text?.(decodeEntities(xml.slice(at, start)));
        const rest = xml.slice(start + 1, start + 9);
        if (rest.startsWith("!--")) {
          this.state = "comment";
          at = start + 4;
        } else if (rest.startsWith("![CDATA[")) {
          this.state = "cdata";
          at = start + 9;
        } else if (rest.length < 8 && (CDATA_START.startsWith(rest) || COMMENT_START.startsWith(rest))) {
          // Too little is known to tell a comment or CDATA from a tag: wait for the next piece.
          this.kept = xml.slice(start);
          return;
        } else {
          this.state = "tag";
          this.quote = 0;
          tagStart = start + 1;
          at = tagStart;
        }
        continue;
      }
      if (this.state === "comment" || this.state === "cdata") {
        const mark = this.state === "comment" ? "-->" : "]]>";
        const end = xml.indexOf(mark, at);
        const stop = end === -1 ? Math.max(at, length - 2) : end;
        if (this.state === "cdata" && stop > at) this.handlers.text?.(xml.slice(at, stop));
        if (end === -1) {
          this.kept = xml.slice(stop);
          return;
        }
        this.state = "text";
        at = end + 3;
        continue;
      }
      // In a tag: on to its ">", outside quotes.
      let end = at;
      for (; end < length; end++) {
        const code = xml.charCodeAt(end);
        if (this.quote !== 0) {
          if (code === this.quote) this.quote = 0;
        } else if (code === 34 || code === 39) {
          this.quote = code;
        } else if (code === 62) {
          break;
        }
      }
      if (end - tagStart > MAX_TAG_CHARACTERS) {
        throw new Error("The XML has a tag far longer than any Office file writes. It may be built to exhaust the server, so it is not read.");
      }
      if (end === length) {
        this.kept = xml.slice(tagStart);
        this.scanned = this.kept.length;
        return;
      }
      this.state = "text";
      at = end + 1;
      this.tagRead(xml.slice(tagStart, end));
    }
  }

  private tagRead(inside: string): void {
    const first = inside.charCodeAt(0);
    // <?xml ... ?> and <!DOCTYPE ...>: nothing to read.
    if (first === 63 || first === 33) return;
    if (first === 47) {
      this.handlers.close?.(inside.slice(1).trim());
      return;
    }
    const empty = inside.charCodeAt(inside.length - 1) === 47;
    const body = empty ? inside.slice(0, -1) : inside;
    const space = body.search(/\s/);
    const name = space === -1 ? body : body.slice(0, space);
    this.handlers.open?.(name, space === -1 ? (Object.create(null) as XmlAttributes) : parseAttributes(body.slice(space)), empty);
  }
}

/** The longest entity read: "&#x10FFFF;". */
const MAX_ENTITY = 10;
const COMMENT_START = "!--";
const CDATA_START = "![CDATA[";

/** Reads a whole piece of XML with `XmlStream`. */
export function readXml(xml: string, handlers: XmlHandlers): void {
  new XmlStream(handlers).write(xml);
}

/** The relationships of an Office part (`_rels/….rels`): target by ID, made absolute from `base`, the folder of the part. */
export function readRelationships(xml: string | undefined, base: string): Map<string, { target: string; type: string; external: boolean }> {
  const relationships = new Map<string, { target: string; type: string; external: boolean }>();
  if (!xml) return relationships;
  readXml(xml, {
    open(name, attributes) {
      if (name !== "Relationship" || !attributes.Id || !attributes.Target) return;
      const external = attributes.TargetMode === "External";
      relationships.set(attributes.Id, { target: external ? attributes.Target : resolvePart(base, attributes.Target), type: attributes.Type ?? "", external });
    },
  });
  return relationships;
}

/** A target of a relationship as a part name: `../notesSlides/notesSlide1.xml` from `ppt/slides` is `ppt/notesSlides/notesSlide1.xml`. */
export function resolvePart(base: string, target: string): string {
  if (target.startsWith("/")) return target.slice(1);
  const parts = base ? base.split("/") : [];
  for (const piece of target.split("/")) {
    if (piece === "..") parts.pop();
    else if (piece !== "." && piece !== "") parts.push(piece);
  }
  return parts.join("/");
}
