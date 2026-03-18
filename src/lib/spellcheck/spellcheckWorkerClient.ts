import type {
  SpellcheckToken,
  SpellcheckUpdate,
  SpellcheckWorkerRequest,
  SpellcheckWorkerResponse
} from "../../models/spellcheck";

export class SpellcheckWorkerClient {
  private readonly worker: Worker;

  constructor(onUpdate: (update: SpellcheckUpdate) => void) {
    this.worker = new Worker(new URL("../../workers/spellcheck.worker.ts", import.meta.url), {
      type: "module"
    });

    this.worker.onmessage = (event: MessageEvent<SpellcheckWorkerResponse>) => {
      if (event.data.type === "spellcheck-update") {
        onUpdate(event.data.update);
      }
    };

    this.worker.onerror = (event) => {
      console.error("[spellcheck] Worker error", event);
    };
  }

  setPersonalDictionary(words: string[]) {
    this.postMessage({
      type: "set-personal-dictionary",
      words
    });
  }

  checkTokens(docVersion: number, tokens: SpellcheckToken[]) {
    this.postMessage({
      type: "check-tokens",
      docVersion,
      tokens
    });
  }

  dispose() {
    this.worker.terminate();
  }

  private postMessage(message: SpellcheckWorkerRequest) {
    this.worker.postMessage(message);
  }
}