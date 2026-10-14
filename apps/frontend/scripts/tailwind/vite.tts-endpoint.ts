import { readFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Plugin } from "vite";
import { EdgeTTS } from "node-edge-tts";
import { handleReelRequest } from "./vite.reel-endpoint.ts";

interface TtsPayload {
  text?: string;
  voice?: string;
  rate?: string;
  pitch?: string;
}

async function synthesizeWithRetry(
  tts: EdgeTTS,
  text: string,
  targetFile: string,
  maxRetries = 3,
): Promise<void> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await tts.ttsPromise(text, targetFile);
      return;
    } catch (err) {
      lastError = err;
      if (attempt < maxRetries) {
        await new Promise((resolve) => setTimeout(resolve, 300 * attempt));
      }
    }
  }

  throw lastError;
}

export function ttsEndpoint(): Plugin {
  return {
    name: "hub-william-tts-endpoint",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url ? req.url.split("?")[0] : "";

        if (req.method === "POST" && url === "/api/tts") {
          let body = "";

          req.on("data", (chunk) => {
            body += chunk;
          });

          req.on("end", async () => {
            const tempFile = join(tmpdir(), `hub-tts-${randomUUID()}.mp3`);

            try {
              const payload = (body ? JSON.parse(body) : {}) as TtsPayload;
              const {
                text,
                voice = "en-US-AriaNeural",
                rate = "0%",
                pitch = "0Hz",
              } = payload;

              if (!text || typeof text !== "string") {
                res.writeHead(400, { "Content-Type": "application/json" });
                res.end(
                  JSON.stringify({ message: "Text content is required." }),
                );
                return;
              }

              const tts = new EdgeTTS({
                voice,
                lang: voice.slice(0, 5),
                rate,
                pitch,
                outputFormat: "audio-24khz-48kbitrate-mono-mp3",
              });

              await synthesizeWithRetry(tts, text, tempFile);
              const audioBuffer = await readFile(tempFile);

              res.writeHead(200, {
                "Content-Type": "audio/mpeg",
                "Content-Length": audioBuffer.length.toString(),
                "Cache-Control": "no-cache",
              });
              res.end(audioBuffer);
            } catch (err: unknown) {
              const message =
                err instanceof Error ? err.message : "TTS Generation Failed";
              res.writeHead(500, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ message }));
            } finally {
              unlink(tempFile).catch(() => undefined);
            }
          });

          return;
        }

        if (handleReelRequest(req, res)) return;

        next();
      });
    },
  };
}
