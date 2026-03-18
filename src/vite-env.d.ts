/// <reference types="vite/client" />

declare module "*.aff?raw" {
  const value: string;
  export default value;
}

declare module "*.dic?raw" {
  const value: string;
  export default value;
}

declare module "nspell" {
  interface NSpell {
    add(word: string): NSpell;
    correct(word: string): boolean;
    remove(word: string): NSpell;
    suggest(word: string): string[];
  }

  export default function nspell(aff: string | Uint8Array, dic: string | Uint8Array): NSpell;
}