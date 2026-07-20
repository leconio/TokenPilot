import { gunzipSync } from "node:zlib";

import type { FastifyInstance } from "fastify";
import secureJsonParse from "secure-json-parse";

import type { ApiConfiguration } from "./api-config.js";

class BodyParserError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = "BodyParserError";
  }
}

export function installPrivacySafeJsonParser(
  fastify: FastifyInstance,
  configuration: ApiConfiguration,
): void {
  fastify.removeContentTypeParser("application/json");
  fastify.addContentTypeParser(
    "application/json",
    { parseAs: "buffer", bodyLimit: configuration.maxCompressedBytes },
    (request, body, done) => {
      try {
        const encoding = request.headers["content-encoding"]?.toLowerCase() ?? "identity";
        const encoded = Buffer.isBuffer(body) ? body : Buffer.from(body);
        let decoded: Buffer;
        if (encoding === "gzip") {
          decoded = gunzipSync(encoded, { maxOutputLength: configuration.maxDecompressedBytes });
        } else if (encoding === "identity") {
          decoded = encoded;
        } else {
          throw new BodyParserError("Unsupported Content-Encoding", 415);
        }
        if (decoded.byteLength > configuration.maxDecompressedBytes) {
          throw new BodyParserError("Decompressed body is too large", 413);
        }
        done(
          null,
          secureJsonParse(decoded, null, { protoAction: "error", constructorAction: "error" }),
        );
      } catch (error) {
        if (error instanceof BodyParserError) {
          done(error);
          return;
        }
        const code = error instanceof Error && "code" in error ? error.code : undefined;
        done(
          new BodyParserError(
            code === "ERR_BUFFER_TOO_LARGE"
              ? "Decompressed body is too large"
              : "Invalid JSON body",
            code === "ERR_BUFFER_TOO_LARGE" ? 413 : 400,
          ),
        );
      }
    },
  );
}
