import nspell from "nspell";
import enUsAff from "../generated/spellcheck/en-US.aff?raw";
import enUsDic from "../generated/spellcheck/en-US.dic?raw";
import svAff from "../generated/spellcheck/sv.aff?raw";
import svDic from "../generated/spellcheck/sv.dic?raw";
import type {
  SpellcheckRange,
  SpellcheckUpdate,
  SpellcheckWorkerRequest,
  SpellcheckWorkerResponse
} from "../models/spellcheck";

const englishChecker = nspell(enUsAff, enUsDic);
const swedishChecker = nspell(svAff, svDic);
const swedishLexicon = createDictionaryWordSet(svDic);
const SUGGESTION_LIMIT = 6;

let personalWords = new Set<string>();

function normalizeWord(word: string) {
  return word.trim().toLocaleLowerCase();
}

function createDictionaryWordSet(dictionarySource: string) {
  return new Set(
    dictionarySource
      .split(/\r?\n/)
      .slice(1)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => line.split(/[\/\t\s]/)[0]?.toLocaleLowerCase())
      .filter((word): word is string => Boolean(word))
  );
}

function isCorrect(word: string) {
  const normalizedWord = normalizeWord(word);

  return (
    personalWords.has(normalizedWord) ||
    englishChecker.correct(word) ||
    englishChecker.correct(normalizedWord) ||
    swedishLexicon.has(normalizedWord)
  );
}

function collectSuggestions(word: string) {
  const normalizedWord = normalizeWord(word);
  const suggestions = [
    ...englishChecker.suggest(word),
    ...swedishChecker.suggest(word),
    ...englishChecker.suggest(normalizedWord),
    ...swedishChecker.suggest(normalizedWord)
  ];

  const seen = new Set<string>();
  const uniqueSuggestions: string[] = [];

  for (const suggestion of suggestions) {
    const key = suggestion.toLocaleLowerCase();
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    uniqueSuggestions.push(suggestion);

    if (uniqueSuggestions.length >= SUGGESTION_LIMIT) {
      break;
    }
  }

  return uniqueSuggestions;
}

function handleSetPersonalDictionary(words: string[]) {
  personalWords = new Set(words.map(normalizeWord).filter(Boolean));
}

function handleCheckTokens(docVersion: number, tokens: Array<{ from: number; to: number; word: string }>) {
  const ranges: SpellcheckRange[] = [];

  for (const token of tokens) {
    if (isCorrect(token.word)) {
      continue;
    }

    ranges.push({
      from: token.from,
      to: token.to,
      word: token.word,
      suggestions: collectSuggestions(token.word)
    });
  }

  const update: SpellcheckUpdate = {
    docVersion,
    ranges
  };

  const response: SpellcheckWorkerResponse = {
    type: "spellcheck-update",
    update
  };

  self.postMessage(response);
}

self.onmessage = (event: MessageEvent<SpellcheckWorkerRequest>) => {
  const message = event.data;

  if (message.type === "set-personal-dictionary") {
    handleSetPersonalDictionary(message.words);
    return;
  }

  if (message.type === "check-tokens") {
    handleCheckTokens(message.docVersion, message.tokens);
  }
};