import { invoke } from "@tauri-apps/api/core";
import type { PersonalDictionary } from "../models/spellcheck";

const LOCAL_STORAGE_KEY = "spellcheck.personalDictionary";

function createDefaultPersonalDictionary(): PersonalDictionary {
  return {
    version: 1,
    words: []
  };
}

function normalizeWord(word: string) {
  return word.trim().toLocaleLowerCase();
}

function normalizeWords(words: string[]) {
  return Array.from(new Set(words.map(normalizeWord).filter(Boolean))).sort((left, right) =>
    left.localeCompare(right, undefined, { sensitivity: "base" })
  );
}

function isTauriRuntime() {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function readFromLocalStorage(): PersonalDictionary {
  if (typeof window === "undefined") {
    return createDefaultPersonalDictionary();
  }

  const raw = window.localStorage.getItem(LOCAL_STORAGE_KEY);
  if (!raw) {
    return createDefaultPersonalDictionary();
  }

  try {
    const parsed = JSON.parse(raw) as PersonalDictionary;
    return {
      version: 1,
      words: normalizeWords(Array.isArray(parsed.words) ? parsed.words : [])
    };
  } catch {
    return createDefaultPersonalDictionary();
  }
}

function writeToLocalStorage(words: string[]) {
  if (typeof window === "undefined") {
    return createDefaultPersonalDictionary();
  }

  const dictionary: PersonalDictionary = {
    version: 1,
    words: normalizeWords(words)
  };

  window.localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(dictionary));
  return dictionary;
}

export async function loadPersonalDictionary(): Promise<PersonalDictionary> {
  if (!isTauriRuntime()) {
    return readFromLocalStorage();
  }

  try {
    const dictionary = await invoke<PersonalDictionary>("spellcheck_load_personal_dictionary");
    return {
      version: 1,
      words: normalizeWords(dictionary.words)
    };
  } catch (error) {
    console.error("[spellcheck] Failed to load personal dictionary", error);
    throw error;
  }
}

export async function addPersonalDictionaryWord(word: string): Promise<PersonalDictionary> {
  if (!isTauriRuntime()) {
    const dictionary = readFromLocalStorage();
    return writeToLocalStorage([...dictionary.words, word]);
  }

  try {
    const dictionary = await invoke<PersonalDictionary>("spellcheck_add_personal_word", { word });
    return {
      version: 1,
      words: normalizeWords(dictionary.words)
    };
  } catch (error) {
    console.error("[spellcheck] Failed to add personal dictionary word", { word, error });
    throw error;
  }
}

export async function removePersonalDictionaryWord(word: string): Promise<PersonalDictionary> {
  if (!isTauriRuntime()) {
    const normalizedWord = normalizeWord(word);
    const dictionary = readFromLocalStorage();
    return writeToLocalStorage(dictionary.words.filter((entry) => entry !== normalizedWord));
  }

  try {
    const dictionary = await invoke<PersonalDictionary>("spellcheck_remove_personal_word", { word });
    return {
      version: 1,
      words: normalizeWords(dictionary.words)
    };
  } catch (error) {
    console.error("[spellcheck] Failed to remove personal dictionary word", { word, error });
    throw error;
  }
}