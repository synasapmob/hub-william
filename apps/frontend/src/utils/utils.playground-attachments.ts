import type { PlaygroundAttachment } from "@/services/playground";

export const PLAYGROUND_FILE_LIMIT = 5 * 1024 * 1024;
export const PLAYGROUND_FILE_ACCEPT =
  ".png,.jpg,.jpeg,.webp,.gif,.pdf,.txt,.md,.csv,.json,.yaml,.yml,.xml,.html,.css,.js,.ts,.tsx,.jsx,.py,.rs,.sql,.log";
const textExtensions = new Set([
  "txt",
  "md",
  "csv",
  "json",
  "yaml",
  "yml",
  "xml",
  "html",
  "css",
  "js",
  "ts",
  "tsx",
  "jsx",
  "py",
  "rs",
  "sql",
  "log",
]);

async function pdfText(data: ArrayBuffer) {
  const [pdf, worker] = await Promise.all([
    import("pdfjs-dist"),
    import("pdfjs-dist/build/pdf.worker.min.mjs?url"),
  ]);
  pdf.GlobalWorkerOptions.workerSrc = worker.default;
  const loading = pdf.getDocument({
    data: new Uint8Array(data),
    useWasm: false,
  });
  try {
    const document = await loading.promise;
    const pages: string[] = [];
    let length = 0;
    for (let number = 1; number <= document.numPages; number += 1) {
      const page = await document.getPage(number);
      const content = await page.getTextContent();
      const text = content.items
        .map((item) =>
          "str" in item ? item.str + (item.hasEOL ? "\n" : " ") : "",
        )
        .join("");
      length += text.length;
      if (length > PLAYGROUND_FILE_LIMIT)
        throw new Error(
          "This PDF contains too much text. Upload a smaller document.",
        );
      pages.push(`Page ${number}\n${text}`);
      page.cleanup();
    }
    if (!pages.some((page) => page.replace(/^Page \d+\n/, "").trim()))
      throw new Error(
        "This PDF has no readable text. Upload images of the pages or a text-based PDF.",
      );
    const result = pages.join("\n\n");
    if (new TextEncoder().encode(result).byteLength > PLAYGROUND_FILE_LIMIT)
      throw new Error(
        "This PDF contains too much text. Upload a smaller document.",
      );
    return result;
  } finally {
    await loading.destroy();
  }
}

function imageType(bytes: Uint8Array) {
  if (
    [137, 80, 78, 71, 13, 10, 26, 10].every(
      (value, index) => bytes[index] === value,
    )
  )
    return "image/png";
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255)
    return "image/jpeg";
  const header = new TextDecoder().decode(bytes.slice(0, 12));
  if (header.startsWith("GIF87a") || header.startsWith("GIF89a"))
    return "image/gif";
  if (header.startsWith("RIFF") && header.slice(8) === "WEBP")
    return "image/webp";
  return null;
}

export default async function readPlaygroundAttachment(
  file: File,
): Promise<PlaygroundAttachment> {
  if (!file.size || file.size > PLAYGROUND_FILE_LIMIT)
    throw new Error(`${file.name}: choose a nonempty file up to 5 MB.`);
  const data = await file.arrayBuffer();
  const bytes = new Uint8Array(data);
  const mediaType = imageType(bytes);
  if (mediaType) {
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 32768)
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
    return {
      kind: "image",
      name: file.name,
      media_type: mediaType,
      data: btoa(binary),
    };
  }
  const extension = file.name.split(".").at(-1)?.toLowerCase() ?? "";
  if (extension === "pdf") {
    try {
      return { kind: "text", name: file.name, text: await pdfText(data) };
    } catch (error) {
      throw new Error(
        `${file.name}: ${error instanceof Error ? error.message : "The PDF could not be read."}`,
        { cause: error },
      );
    }
  }
  if (!textExtensions.has(extension))
    throw new Error(`${file.name}: use an image, PDF or supported text file.`);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new Error(
      `${file.name}: save this file as UTF-8 text before uploading.`,
      { cause: error },
    );
  }
  if (!text.trim() || text.includes("\0"))
    throw new Error(`${file.name}: this file does not contain readable text.`);
  return { kind: "text", name: file.name, text };
}
