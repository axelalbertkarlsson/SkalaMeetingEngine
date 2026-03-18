import { mkdir, copyFile, access } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const outputDir = path.join(repoRoot, "src", "generated", "spellcheck");

const files = [
  {
    source: path.join(repoRoot, "node_modules", "dictionary-en-us", "index.aff"),
    target: path.join(outputDir, "en-US.aff")
  },
  {
    source: path.join(repoRoot, "node_modules", "dictionary-en-us", "index.dic"),
    target: path.join(outputDir, "en-US.dic")
  },
  {
    source: path.join(repoRoot, "node_modules", "dictionary-sv", "index.aff"),
    target: path.join(outputDir, "sv.aff")
  },
  {
    source: path.join(repoRoot, "node_modules", "dictionary-sv", "index.dic"),
    target: path.join(outputDir, "sv.dic")
  }
];

async function ensureInstalled(filePath) {
  try {
    await access(filePath, constants.R_OK);
  } catch {
    throw new Error(`Missing spellcheck source file: ${path.relative(repoRoot, filePath)}. Run npm install first.`);
  }
}

async function main() {
  await mkdir(outputDir, { recursive: true });

  for (const file of files) {
    await ensureInstalled(file.source);
    await copyFile(file.source, file.target);
  }
}

main().catch((error) => {
  console.error("[spellcheck] Failed to prepare dictionaries.");
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});