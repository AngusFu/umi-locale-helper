// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import { TextDecoder } from "util";
import * as vscode from "vscode";
import { throttle } from "throttle-debounce";

const SUPPORTED_LANGUAGES = [
  "javascript",
  "javascriptreact",
  "typescript",
  "typescriptreact",
];

let cacheData = initCacheData();
let i18nFiles = [] as string[];

const decorationType = vscode.window.createTextEditorDecorationType({
  overviewRulerLane: vscode.OverviewRulerLane.Right,
  after: { margin: "0 0 0 0.5rem" },
});
// this method is called when your extension is activated
// your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {
  const workspaceUri = vscode.workspace.workspaceFolders![0].uri;

  // TODO make this configurable
  const glob = ["src/locales/zh-CN/**/*.ts", "src/locales/zh-CN.ts"];
  const patterns = glob.map((p) => new vscode.RelativePattern(workspaceUri, p));

  const onTextEditorChange = throttle(100, updateDecorations, {
    noLeading: false,
    noTrailing: false,
  });

  context.subscriptions.push(
    vscode.languages.registerDefinitionProvider(
      SUPPORTED_LANGUAGES,
      new LocaleDefinitionProvider()
    ),
    vscode.languages.registerHoverProvider(
      SUPPORTED_LANGUAGES,
      new LocaleHoverProvider()
    ),
    vscode.languages.registerReferenceProvider(
      SUPPORTED_LANGUAGES,
      new LocaleReferenceProvider()
    ),

    registerWatcher(patterns, () => {
      collectAndUpdate(patterns);
    }),

    vscode.window.onDidChangeActiveTextEditor(updateDecorations),
    vscode.window.onDidChangeVisibleTextEditors(updateDecorations),

    vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document === vscode.window.activeTextEditor?.document) {
        onTextEditorChange();
      }
    })
  );

  collectAndUpdate(patterns);
}

function registerWatcher(patterns: vscode.RelativePattern[], cb: () => any) {
  const watchers = patterns.map((p) =>
    vscode.workspace.createFileSystemWatcher(p)
  );
  watchers.forEach((watcher) => watcher.onDidChange(cb));

  return new vscode.Disposable(() =>
    watchers.forEach((watcher) => watcher.dispose())
  );
}

function collectAndUpdate(patterns: vscode.GlobPattern[]) {
  return collectData(patterns).then(() => {
    updateDecorations();
  });
}

function updateDecorations() {
  vscode.window.visibleTextEditors.forEach((editor) => {
    if (
      // filter out i18n files since they don't have to be annotated
      i18nFiles.indexOf(editor.document.uri.fsPath) > -1
    ) {
      return;
    }

    editor.setDecorations(
      decorationType,
      getLocaleIdentifiers(editor.document.getText())
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
    const wordRange = getWordRange(document, position);
    const localeId = wordRange && getLocaleId(document, wordRange);

    if (!localeId || !cacheData.has(localeId)) return;

    const contents = new vscode.MarkdownString(cacheData.get(localeId)!.value);
    contents.isTrusted = true;

    return new vscode.Hover(contents, wordRange);
  }
}

class LocaleDefinitionProvider implements vscode.DefinitionProvider {
  provideDefinition(document: vscode.TextDocument, position: vscode.Position) {
    const wordRange = getWordRange(document, position);
    const localeId = wordRange && getLocaleId(document, wordRange);

    if (!localeId || !cacheData.has(localeId)) return;

    const { pos, file } = cacheData.get(localeId)!;
    const targetLoc = new vscode.Location(file, pos);

    const ret: vscode.LocationLink[] = [
      {
        originSelectionRange: wordRange,

        targetUri: targetLoc.uri,
        targetRange: targetLoc.range,
      },
    ];

    return ret;
  }
}

class LocaleReferenceProvider implements vscode.ReferenceProvider {
  provideReferences(
    document: vscode.TextDocument,
    position: vscode.Position,
    context: vscode.ReferenceContext,
    token: vscode.CancellationToken
  ): vscode.ProviderResult<vscode.Location[]> {
    const localeId = getLocaleId(document, getWordRange(document, position));

    if (!localeId || !cacheData.has(localeId)) return null;

    const queryRe = `(['"])${localeId.replace(/\./g, "\\.")}(?:\\1)`;

    return vscode.commands
      .executeCommand(
        "workbench.action.findInFiles",
        {
          query: queryRe,
          replace: "",
          triggerSearch: true,
          preserveCase: true,
          isRegex: true,
          isCaseSensitive: true,
          matchWholeWord: true,
          useExcludeSettingsAndIgnoreFiles: true,
        },
        200
      )
      .then(async () => {
        const MAGIC_STR = "@@magic";
        const originalText = await vscode.env.clipboard.readText();
        await vscode.env.clipboard.writeText(MAGIC_STR);

        const start = Date.now();
        let searchResult = MAGIC_STR;

        while (searchResult && searchResult === MAGIC_STR) {
          if (Date.now() - start > 20) {
            vscode.window.showWarningMessage("Code searching timeout");
            break;
          }

          await wait(100);
          await vscode.commands.executeCommand("search.action.copyAll");

          const text = await vscode.env.clipboard.readText();
          if (text.trim()) {
            searchResult = text.trim();
          }
        }

        // recover clipboard
        await vscode.env.clipboard.writeText(originalText);

        if (!searchResult || searchResult === MAGIC_STR) {
          return [];
        }

        const lines = searchResult
          .split(/\n/)
          .map((line) => line.trim())
          .filter(Boolean);

        const [locations] = lines.reduce(
          ([locs, currentUri], line) => {
            if (/^\d+,\d+:/.test(line)) {
              if (currentUri) {
                const pos = line
                  .split(/[,:]/)
                  .slice(0, 2)
                  .map((el) => Number(el));

                locs.push(
                  new vscode.Location(
                    currentUri,
                    new vscode.Position(pos[0], pos[1])
                  )
                );
              }
            } else {
              currentUri = vscode.Uri.file(line);
            }

            return [locs, currentUri] as const;
          },
          [[] as vscode.Location[], null as vscode.Uri | null] as const
        );

        return locations;
      });
  }
}

async function collectData(patterns: vscode.GlobPattern[]) {
  const uris = await Promise.all(
    patterns.map((p) => vscode.workspace.findFiles(p))
  );
  const paths = uris.flat().map((uri) => uri.fsPath);
  const result = await Promise.all(
    [...paths].map((file) => collectLocaleInfoFromFile(file))
  );
  const newCache = initCacheData();
  result.forEach((arr) =>
    arr.forEach(([key, value]) => newCache.set(key, value))
  );
  cacheData.clear();

  i18nFiles = paths;
  cacheData = newCache;
}

function getLocaleId(
  document: vscode.TextDocument,
  range?: vscode.Range | null
) {
  if (range) {
    return document.getText(range).replace(/^['"`]|['"`]$/g, "");
  }

  return null;
}

function getWordRange(
  document: vscode.TextDocument,
  position: vscode.Position
) {
  return document.getWordRangeAtPosition(
    position,
    /(['"`])((?:[\w-]+\.)+(?:[\w-]+))\1/
  );
}

function collectLocaleInfoFromFile(fsPath: string) {
  const uri = vscode.Uri.file(fsPath);

  return readFile(uri).then((content) =>
    getLocaleInfo(content).map(
      ([key, value, pos]) => [key, { value, pos, file: uri }] as const
    )
  );
}

function readFile(uri: vscode.Uri) {
  return vscode.workspace.fs
    .readFile(uri)
    .then((res) => new TextDecoder("utf-8").decode(res));
}

function getLocaleInfo(content: string) {
  const result: Array<[string, string, vscode.Position]> = [];
  let tmp: RegExpExecArray | null = null;

  const kvRe =
    /\s+(['"])(?<key>(?:[\w-]+\.)+(?:[\w-]+))\1\s*:\s*(['"])(?<val>.*?)\3/g;

  while ((tmp = kvRe.exec(content))) {
    const { index, groups } = tmp;
    const { key, val } = groups!;

    result.push([key, val, findPosition(content, index)]);
  }

  return result;
}

function findPosition(content: string, index: number) {
  let tmp: RegExpExecArray | null = null;
  let currentLine = 0;

  const brRe = /\n/g;
  while ((tmp = brRe.exec(content))) {
    currentLine += 1;

    if (tmp.index >= index) {
      break;
    }
  }

  return new vscode.Position(currentLine, 2);
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
      pos: vscode.Position;
      value: string;
      file: vscode.Uri;
    }
  >();
}

function wait(timeout: number) {
  return new Promise((resolve) => setTimeout(resolve, timeout));
}
