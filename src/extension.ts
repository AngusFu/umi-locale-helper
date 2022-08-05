// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as fg from "fast-glob";
import { join } from "path";
import { TextDecoder } from "util";
import * as vscode from "vscode";

const SUPPORTED_LANGUAGES = ["javascript", "typescript", "typescriptreact"];

let cacheData = initCacheData();

const decorationType = vscode.window.createTextEditorDecorationType({
  overviewRulerLane: vscode.OverviewRulerLane.Right,
  after: { margin: "0 0 0 0.5rem" },
});
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
    ),
    registerWatcher(() => {
      collectData(["src/locales/zh-CN/**/*.ts", "src/locales/zh-CN.ts"]);
    }),
    vscode.window.onDidChangeActiveTextEditor(() => {
      updateDecorations();
    })
  );

  collectData(["src/locales/zh-CN/**/*.ts", "src/locales/zh-CN.ts"]);
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

  return new vscode.Disposable(() => {
    w1.dispose();
    w2.dispose();
  });
}

function updateDecorations() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;

  const { uri } = editor.document;
  if (/locale/.test(uri.path)) return;

  readFile(uri).then((content) => {
    editor.setDecorations(
      decorationType,
      getLocaleIdentifiers(content)
        .filter(([key]) => cacheData.get(key))
        .map(([key, index]) =>
          getMarkItem(
            new vscode.Range(
              editor?.document.positionAt(index),
              editor?.document.positionAt(index + key.length + 1)
            ),
            cacheData.get(key)!.value
          )
        )
    );
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

    const { index, file } = cacheData.get(localeId)!;

    return new vscode.Location(file, document.positionAt(index));
  }
}

async function collectData(pattern: string[]) {
  const newCache = initCacheData();

  return fg(pattern, {
    cwd: vscode.workspace.workspaceFolders![0].uri.fsPath,
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

      updateDecorations();
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

  return readFile(uri).then((content) =>
    getLocaleInfo(content).map(
      ([key, value, index]) => [key, { value, index, file: uri }] as const
    )
  );
}

function readFile(uri: vscode.Uri) {
  return vscode.workspace.fs
    .readFile(uri)
    .then((res) => new TextDecoder("utf-8").decode(res));
}

function getLocaleInfo(content: string) {
  const result: Array<[string, string, number]> = [];
  let tmp: RegExpExecArray | null = null;

  const kvRe =
    /\s+(['"])(?<key>(?:[\w-]+\.)+(?:[\w-]+))\1\s*:\s*(['"])(?<val>.*?)\3/g;

  while ((tmp = kvRe.exec(content))) {
    const { index, groups } = tmp;
    const { key, val } = groups!;

    result.push([key, val, index]);
  }

  return result;
}

function getMarkItem(range: vscode.Range, contentText: string) {
  const target: vscode.DecorationOptions = {
    range,
    renderOptions: {
      after: {
        contentText,
        color: "rgb(209 209 209 / 80%)",
        border: "1px dashed green",
      },
    },
  };

  return target;
}

function getLocaleIdentifiers(content: string) {
  const result: Array<[string, number]> = [];
  let tmp: RegExpExecArray | null = null;

  const re = /(['"])(?<key>(?:[\w-]+\.)+(?:[\w-]+))\1/g;

  while ((tmp = re.exec(content))) {
    const { index, groups } = tmp;
    const { key } = groups!;

    result.push([key, index]);
  }

  return result;
}

function initCacheData() {
  return new Map<
    string,
    {
      index: number;
      value: string;
      file: vscode.Uri;
    }
  >();
}
