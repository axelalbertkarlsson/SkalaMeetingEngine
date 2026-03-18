export interface SpellcheckRange {
  from: number;
  to: number;
  word: string;
  suggestions: string[];
}

export interface SpellcheckUpdate {
  docVersion: number;
  ranges: SpellcheckRange[];
}

export interface PersonalDictionary {
  version: 1;
  words: string[];
}

export interface SpellcheckToken {
  from: number;
  to: number;
  word: string;
}

export type SpellcheckWorkerRequest =
  | {
      type: "set-personal-dictionary";
      words: string[];
    }
  | {
      type: "check-tokens";
      docVersion: number;
      tokens: SpellcheckToken[];
    };

export type SpellcheckWorkerResponse = {
  type: "spellcheck-update";
  update: SpellcheckUpdate;
};