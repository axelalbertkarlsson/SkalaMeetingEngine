import path from "node:path";
import { rm, mkdir } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const workspaceRoot = process.cwd();
const sourceRoot = path.join(workspaceRoot, "src");
const outDir = path.join(workspaceRoot, ".tmp", "codex-terminal-tests");
const testEntry = path.join(sourceRoot, "components", "shell", "codexTerminalTransport.test.ts");

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

const compilerOptions = {
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  target: ts.ScriptTarget.ES2020,
  rootDir: sourceRoot,
  outDir,
  strict: true,
  skipLibCheck: true,
  isolatedModules: false,
  esModuleInterop: true,
  allowSyntheticDefaultImports: true
};

const program = ts.createProgram([testEntry], compilerOptions);
const emitResult = program.emit();
const diagnostics = ts.getPreEmitDiagnostics(program).concat(emitResult.diagnostics);

if (diagnostics.length > 0) {
  console.error(ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCanonicalFileName: (fileName) => fileName,
    getCurrentDirectory: () => workspaceRoot,
    getNewLine: () => "\n"
  }));
  process.exit(1);
}

const compiledTestPath = path.join(outDir, "components", "shell", "codexTerminalTransport.test.js");
const compiledModule = await import(pathToFileURL(compiledTestPath).href);
const tests = compiledModule.tests;

if (!Array.isArray(tests)) {
  console.error("Compiled test module did not export a tests array.");
  process.exit(1);
}

let failures = 0;
for (const testCase of tests) {
  try {
    testCase.run();
    console.log(`PASS ${testCase.name}`);
  } catch (error) {
    failures += 1;
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    console.error(`FAIL ${testCase.name}`);
    console.error(message);
  }
}

if (failures > 0) {
  process.exit(1);
}
