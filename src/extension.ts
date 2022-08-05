// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as fg from "fast-glob";
import { join } from "path";
import { TextDecoder } from "util";
import * as vscode from "vscode";

const SUPPORTED_LANGUAGES = ["javascript", "typescript", "typescriptreact"];
const cleanupCallbacks = [] as Array<() => any>;

let cacheData = initCacheData();

export function deactivate() {
  cleanupCallbacks.forEach((f) => f());
}

// this method is called when your extension is activated
// your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.languages.registerDefinitionProvider(
      SUPPORTED_LANGUAGES,
      new LocaleDefinitionProvider()
    ),
    vscode.languages.registerHoverProvider(
      SUPPORTED_LANGUAGES,
      new LocaleHoverProvider()
    )
  );

  collectData(["src/locales/zh-CN/**/*.ts", "src/locales/zh-CN.ts"]);
  registerWatcher(() => {
    collectData(["src/locales/zh-CN/**/*.ts", "src/locales/zh-CN.ts"]);
  });
}

function registerWatcher(cb: () => any) {
  const w1 = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(
      vscode.workspace.workspaceFolders![0].uri,
      "src/locales/zh-CN/**/*.ts"
    )
  );
  const w2 = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(
      vscode.workspace.workspaceFolders![0].uri,
      "src/locales/zh-CN.ts"
    )
  );

  w1.onDidChange(cb);
  w2.onDidChange(cb);

  cleanupCallbacks.push(() => {
    w1.dispose();
    w2.dispose();
  });
}

class LocaleHoverProvider implements vscode.HoverProvider {
  provideHover(
    document: vscode.TextDocument,
    position: vscode.Position,
    _token: vscode.CancellationToken
  ) {
    const localeId = getLocaleId(document, position);
    if (!localeId || !cacheData.has(localeId)) return;

    const contents = new vscode.MarkdownString(cacheData.get(localeId)!.value);
    contents.isTrusted = true;

    return new vscode.Hover(contents);
  }
}

class LocaleDefinitionProvider implements vscode.DefinitionProvider {
  provideDefinition(document: vscode.TextDocument, position: vscode.Position) {
    const localeId = getLocaleId(document, position);
    if (!localeId || !cacheData.has(localeId)) return;

    const { line, file } = cacheData.get(localeId)!;

    return new vscode.Location(file, new vscode.Position(line, 0));
  }
}

async function collectData(pattern: string[]) {
  const newCache = initCacheData();

  return fg(pattern, {
    cwd: cwd(),
    onlyFiles: true,
  })
    .then((files) =>
      Promise.all(files.map((file) => collectLocaleInfoFromFile(file)))
    )
    .then((result) => {
      cacheData.clear();

      result.forEach((arr) =>
        arr.forEach(([key, value]) => newCache.set(key, value))
      );

      cacheData = newCache;
    });
}

function getLocaleId(document: vscode.TextDocument, position: vscode.Position) {
  const range = document.getWordRangeAtPosition(
    position,
    /(['"`])((?:[\w-]+\.)+(?:[\w-]+))\1/
  );
  if (range) {
    const text = document.getText(range);

    return text.replace(/^['"`]|['"`]$/g, "");
  }

  return null;
}

function collectLocaleInfoFromFile(relativePath: string) {
  const entry = join(
    vscode.workspace.workspaceFolders![0].uri.fsPath,
    relativePath
  );
  const uri = vscode.Uri.file(entry);

  return vscode.workspace.fs
    .readFile(uri)
    .then((res) => new TextDecoder("utf-8").decode(res))
    .then((content) =>
      getLocaleInfo(content).map(
        ([key, value, index, line]) =>
          [key, { value, index, line, file: uri }] as const
      )
    );
}

function getLocaleInfo(content: string) {
  let reTmp: RegExpExecArray | null = null;

  const brRe = /\n/g;
  const brIndexes: number[] = [];
  while ((reTmp = brRe.exec(content))) {
    brIndexes.push(reTmp.index);
  }

  const kvRe =
    /\s+(['"])(?<key>(?:[\w-]+\.)+(?:[\w-]+))\1\s*:\s*(['"])(?<val>.*?)\3/g;
  const tmpData: Array<[string, string, number, number]> = [];

  while ((reTmp = kvRe.exec(content))) {
    const { index, groups } = reTmp;
    const { key, val } = groups!;

    tmpData.push([key, val, index, 0]);
  }

  let cursor1 = 0;
  let cursor2 = 0;

  // eslint-disable-next-line no-constant-condition
  while (cursor1 < brIndexes.length && cursor2 < tmpData.length) {
    if (brIndexes[cursor1] < tmpData[cursor2][2]) {
      cursor1 += 1;
      continue;
    }
    // 这里假设的就是一行最多只有一条
    tmpData[cursor2][3] = cursor1 + 1;
    cursor2 += 1;
  }

  return tmpData;
}

function cwd() {
  return vscode.workspace.workspaceFolders![0].uri.fsPath;
}

function initCacheData() {
  return new Map<
    string,
    {
      line: number;
      index: number;
      value: string;
      file: vscode.Uri;
    }
  >();
}
