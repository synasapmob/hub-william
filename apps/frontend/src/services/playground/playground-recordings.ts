import type { PlaygroundVoiceTranscript } from "./playground-voice-events";

export interface PlaygroundRecording {
  id: string;
  ownerId: string;
  createdAt: number;
  duration: number;
  model: string;
  mimeType: string;
  stoppedAtLimit?: boolean;
  transcripts: PlaygroundVoiceTranscript[];
}
export interface PlaygroundRecordingFile extends PlaygroundRecording {
  blob: Blob;
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("Recording storage is unavailable in this browser."));
      return;
    }
    const request = indexedDB.open("hub.playground.recordings", 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      db.createObjectStore("recordings", {
        keyPath: ["ownerId", "id"],
      }).createIndex("owner", "ownerId");
      db.createObjectStore("files", { keyPath: ["ownerId", "id"] });
    };
    let blocked = false;
    request.onsuccess = () => {
      if (blocked) {
        request.result.close();
        return;
      }
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
    request.onerror = () => reject(request.error);
    request.onblocked = () => {
      blocked = true;
      reject(new Error("Close other Hub tabs to open recording storage."));
    };
  });
}

async function transaction<T>(
  mode: IDBTransactionMode,
  run: (tx: IDBTransaction, result: (value: T) => void) => void,
): Promise<T> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(["recordings", "files"], mode);
    let value: T;
    tx.oncomplete = () => {
      db.close();
      resolve(value);
    };
    tx.onabort = () => {
      db.close();
      reject(tx.error ?? new Error("Recording storage failed."));
    };
    tx.onerror = () => {}; // Abort owns rejection; never report success before commit.
    try {
      run(tx, (result) => {
        value = result;
      });
    } catch (error) {
      tx.abort();
      reject(error);
    }
  });
}

async function list(ownerId: string): Promise<PlaygroundRecording[]> {
  return transaction("readonly", (tx, result) => {
    const request = tx.objectStore("recordings").index("owner").getAll(ownerId);
    request.onsuccess = () =>
      result(
        (request.result as PlaygroundRecording[]).sort(
          (a, b) => b.createdAt - a.createdAt,
        ),
      );
  });
}
async function save(file: PlaygroundRecordingFile): Promise<void> {
  const { blob, ...recording } = file;
  return transaction("readwrite", (tx, result) => {
    tx.objectStore("recordings").put(recording);
    tx.objectStore("files").put({ ownerId: file.ownerId, id: file.id, blob });
    result(undefined);
  });
}
async function load(
  ownerId: string,
  id: string,
): Promise<PlaygroundRecordingFile> {
  return transaction("readonly", (tx, result) => {
    const metadata = tx.objectStore("recordings").get([ownerId, id]);
    const file = tx.objectStore("files").get([ownerId, id]);
    let ready = 0;
    const loaded = () => {
      if (++ready < 2) return;
      if (!metadata.result || !(file.result?.blob instanceof Blob)) {
        tx.abort();
        return;
      }
      result({
        ...metadata.result,
        blob: file.result.blob,
      } as PlaygroundRecordingFile);
    };
    metadata.onsuccess = loaded;
    file.onsuccess = loaded;
  });
}
async function remove(ownerId: string, id: string): Promise<void> {
  return transaction("readwrite", (tx, result) => {
    tx.objectStore("recordings").delete([ownerId, id]);
    tx.objectStore("files").delete([ownerId, id]);
    result(undefined);
  });
}
const playgroundRecordingsService = {
  queryKey: ["local-call-recordings"] as const,
  list,
  save,
  load,
  remove,
};
export default playgroundRecordingsService;
