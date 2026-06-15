import { Transform, TransformCallback } from "stream";
import { Parser } from "htmlparser2";

/**
 * 🛡️ Strictly limits the number of bytes allowed through the pipeline.
 * If the limit is exceeded, it gracefully outputs the final chunk and triggers a TCP teardown.
 */
export class ByteLimitTransform extends Transform {
  private bytesProcessed = 0;
  public isTruncated = false;

  constructor(private limitBytes: number, private onLimitReached: () => void) {
    super();
  }

  _transform(chunk: Buffer, encoding: BufferEncoding, callback: TransformCallback) {
    if (this.bytesProcessed >= this.limitBytes) {
      return callback(); // Drop chunk safely if already exceeded
    }

    const remaining = this.limitBytes - this.bytesProcessed;
    if (chunk.length > remaining) {
      this.bytesProcessed += remaining;
      this.isTruncated = true;
      this.push(chunk.subarray(0, remaining));
      this.onLimitReached(); // 🚨 Trigger socket destruction immediately
      return callback();
    }

    this.bytesProcessed += chunk.length;
    this.push(chunk);
    callback();
  }
}

/**
 * 🚀 High-performance, low-memory HTML to Text extractor.
 * Processes chunks via SAX events instead of building a massive DOM tree in RAM.
 */
export class HtmlTextExtractor extends Transform {
  private parser: Parser;
  private ignoredTagCount = 0;
  public title = "";
  public description = "";
  private isTitle = false;

  constructor() {
    super({ readableObjectMode: true });

    this.parser = new Parser({
      onopentag: (name, attribs) => {
        if (["script", "style", "noscript", "svg", "iframe", "nav", "footer"].includes(name)) {
          this.ignoredTagCount++;
        }
        if (name === "title") this.isTitle = true;
        if (name === "meta" && (attribs.name === "description" || attribs.property === "og:description")) {
          if (attribs.content) this.description = attribs.content;
        }
      },
      ontext: (text) => {
        if (this.isTitle) {
          this.title += text;
        } else if (this.ignoredTagCount === 0) {
          const clean = text.replace(/\s+/g, " ");
          if (clean.trim()) {
            this.push(clean + " "); // Push valid text directly down the stream pipeline
          }
        }
      },
      onclosetag: (name) => {
        if (["script", "style", "noscript", "svg", "iframe", "nav", "footer"].includes(name)) {
          this.ignoredTagCount = Math.max(0, this.ignoredTagCount - 1);
        }
        if (name === "title") this.isTitle = false;
      }
    });
  }

  _transform(chunk: Buffer, encoding: BufferEncoding, callback: TransformCallback) {
    this.parser.write(chunk.toString("utf8"));
    callback();
  }

  _flush(callback: TransformCallback) {
    this.parser.end();
    callback();
  }
}
