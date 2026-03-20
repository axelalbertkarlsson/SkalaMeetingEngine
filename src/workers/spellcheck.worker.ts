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
const swedishLexiconWords = Array.from(swedishLexicon);
const swedishPrefixIndex = createPrefixIndex(swedishLexiconWords);
const SUGGESTION_LIMIT = 8;
const PER_LANGUAGE_SUGGESTION_LIMIT = 4;

let personalWords = new Set<string>();

type SuggestionSource = "english" | "swedish";

interface SuggestionCandidate {
  suggestion: string;
  score: number;
}

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

function createPrefixIndex(words: string[]) {
  const index = new Map<string, string[]>();

  for (const word of words) {
    const shortPrefix = word.slice(0, 1);
    const longPrefix = word.slice(0, 2);

    if (shortPrefix) {
      const shortBucket = index.get(shortPrefix) ?? [];
      shortBucket.push(word);
      index.set(shortPrefix, shortBucket);
    }

    if (longPrefix) {
      const longBucket = index.get(longPrefix) ?? [];
      longBucket.push(word);
      index.set(longPrefix, longBucket);
    }
  }

  return index;
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

function uniqueSuggestions(suggestions: string[]) {
  const seen = new Set<string>();
  const unique: string[] = [];

  for (const suggestion of suggestions) {
    const key = suggestion.toLocaleLowerCase();
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    unique.push(suggestion);
  }

  return unique;
}

function getCharacterPairs(word: string) {
  const pairs = new Set<string>();
  for (let index = 0; index < word.length - 1; index += 1) {
    pairs.add(word.slice(index, index + 2));
  }
  return pairs;
}

function overlapScore(left: Set<string>, right: Set<string>) {
  let matches = 0;

  for (const value of left) {
    if (right.has(value)) {
      matches += 1;
    }
  }

  return matches;
}

function levenshteinDistance(left: string, right: string) {
  if (left === right) {
    return 0;
  }

  if (left.length === 0) {
    return right.length;
  }

  if (right.length === 0) {
    return left.length;
  }

  const previousRow = new Array(right.length + 1).fill(0);
  const currentRow = new Array(right.length + 1).fill(0);

  for (let column = 0; column <= right.length; column += 1) {
    previousRow[column] = column;
  }

  for (let row = 1; row <= left.length; row += 1) {
    currentRow[0] = row;

    for (let column = 1; column <= right.length; column += 1) {
      const cost = left[row - 1] === right[column - 1] ? 0 : 1;
      currentRow[column] = Math.min(
        currentRow[column - 1] + 1,
        previousRow[column] + 1,
        previousRow[column - 1] + cost
      );
    }

    for (let column = 0; column <= right.length; column += 1) {
      previousRow[column] = currentRow[column];
    }
  }

  return previousRow[right.length];
}

function scoreSuggestion(originalWord: string, suggestion: string, rank: number) {
  const normalizedSuggestion = normalizeWord(suggestion);
  let score = levenshteinDistance(originalWord, normalizedSuggestion);

  if (normalizedSuggestion[0] === originalWord[0]) {
    score -= 0.35;
  }

  if (normalizedSuggestion.startsWith(originalWord.slice(0, 2))) {
    score -= 0.2;
  }

  score += rank * 0.05;
  return score;
}

function rankSuggestions(word: string, suggestions: string[]) {
  const normalizedWord = normalizeWord(word);

  return uniqueSuggestions(suggestions)
    .map(
      (suggestion, index): SuggestionCandidate => ({
        suggestion,
        score: scoreSuggestion(normalizedWord, suggestion, index)
      })
    )
    .sort((left, right) => left.score - right.score || left.suggestion.localeCompare(right.suggestion, undefined, { sensitivity: "base" }));
}

function mergeSuggestionCandidates(...groups: SuggestionCandidate[][]) {
  const merged = new Map<string, SuggestionCandidate>();

  for (const group of groups) {
    for (const candidate of group) {
      const key = candidate.suggestion.toLocaleLowerCase();
      const existing = merged.get(key);

      if (!existing || candidate.score < existing.score) {
        merged.set(key, candidate);
      }
    }
  }

  return Array.from(merged.values()).sort(
    (left, right) => left.score - right.score || left.suggestion.localeCompare(right.suggestion, undefined, { sensitivity: "base" })
  );
}

function fallbackSwedishSuggestions(word: string) {
  const normalizedWord = normalizeWord(word);
  const prefixes = Array.from(
    new Set([normalizedWord.slice(0, 2), normalizedWord.slice(0, 1)].filter(Boolean))
  );
  const candidateSet = new Set<string>();

  for (const prefix of prefixes) {
    const bucket = swedishPrefixIndex.get(prefix);
    if (!bucket) {
      continue;
    }

    for (const candidate of bucket) {
      if (Math.abs(candidate.length - normalizedWord.length) > 2) {
        continue;
      }

      candidateSet.add(candidate);
    }
  }

  const originalPairs = getCharacterPairs(normalizedWord);

  return Array.from(candidateSet)
    .map((candidate, index) => {
      const distance = levenshteinDistance(normalizedWord, candidate);
      const pairOverlap = overlapScore(originalPairs, getCharacterPairs(candidate));
      let score = distance - pairOverlap * 0.12 + index * 0.001;

      if (candidate.startsWith(normalizedWord.slice(0, 3))) {
        score -= 0.35;
      }

      return {
        suggestion: candidate,
        score
      } satisfies SuggestionCandidate;
    })
    .filter((candidate) => candidate.score <= 2.5)
    .sort((left, right) => left.score - right.score || left.suggestion.localeCompare(right.suggestion, undefined, { sensitivity: "base" }))
    .slice(0, SUGGESTION_LIMIT);
}

function pushSuggestion(
  target: string[],
  seen: Set<string>,
  suggestions: SuggestionCandidate[],
  index: number
) {
  const candidate = suggestions[index];
  if (!candidate) {
    return;
  }

  const key = candidate.suggestion.toLocaleLowerCase();
  if (seen.has(key)) {
    return;
  }

  seen.add(key);
  target.push(candidate.suggestion);
}

function collectSuggestions(word: string) {
  const normalizedWord = normalizeWord(word);
  const englishSuggestions = rankSuggestions(word, [
    ...englishChecker.suggest(word),
    ...englishChecker.suggest(normalizedWord)
  ]);
  const swedishSuggestions = mergeSuggestionCandidates(
    rankSuggestions(word, [
      ...swedishChecker.suggest(word),
      ...swedishChecker.suggest(normalizedWord)
    ]),
    fallbackSwedishSuggestions(word)
  );

  const seen = new Set<string>();
  const balancedSuggestions: string[] = [];
  const sourceOrder: SuggestionSource[] =
    (swedishSuggestions[0]?.score ?? Number.POSITIVE_INFINITY) <
    (englishSuggestions[0]?.score ?? Number.POSITIVE_INFINITY)
      ? ["swedish", "english"]
      : ["english", "swedish"];

  for (let index = 0; index < PER_LANGUAGE_SUGGESTION_LIMIT; index += 1) {
    for (const source of sourceOrder) {
      pushSuggestion(
        balancedSuggestions,
        seen,
        source === "swedish" ? swedishSuggestions : englishSuggestions,
        index
      );

      if (balancedSuggestions.length >= SUGGESTION_LIMIT) {
        return balancedSuggestions;
      }
    }
  }

  const globalSuggestions = mergeSuggestionCandidates(englishSuggestions, swedishSuggestions);

  for (const candidate of globalSuggestions) {
    const key = candidate.suggestion.toLocaleLowerCase();
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    balancedSuggestions.push(candidate.suggestion);

    if (balancedSuggestions.length >= SUGGESTION_LIMIT) {
      break;
    }
  }

  return balancedSuggestions;
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
