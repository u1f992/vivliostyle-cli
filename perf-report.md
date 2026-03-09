# パフォーマンスレポート: JSDOM排除

## 概要

プロダクションコードから `@vivliostyle/jsdom` を排除し `hast`/`rehype` に置換することで、フルPDFビルドが**約19.5%高速化**した。

## 計測方法

- 13個のexampleプロジェクトを `node dist/cli.js build` で逐次ビルド（PDF出力）
- 各ブランチ10回実行
- 両ブランチを別worktreeとして同一マシン上で並行実行
- `time` コマンドの `real` 値（実時間）で計測

### 対象プロジェクト

asciidoc-processor, cmyk, customize-generated-content, customize-processor, local-theme, multiple-input-and-output, single-html, single-markdown, table-of-contents, theme-css, theme-preset, ts-config, workspace-directory

### 除外したプロジェクト

- `preflight`, `render-on-docker` — Docker必須
- `with-astro`, `with-eleventy` — 文書処理と関係のないフレームワーク統合のデモ

## 結果: フルPDFビルド（13プロジェクト）

| #   | eliminate-jsdom (s) | main (s) |
| --- | ------------------- | -------- |
| 1   | 26.29               | 32.53    |
| 2   | 26.83               | 32.53    |
| 3   | 26.23               | 32.47    |
| 4   | 26.33               | 32.67    |
| 5   | 26.44               | 32.70    |
| 6   | 26.17               | 32.57    |
| 7   | 26.16               | 32.66    |
| 8   | 26.12               | 32.98    |
| 9   | 26.22               | 32.53    |
| 10  | 26.09               | 32.82    |

|            | eliminate-jsdom | main   | 改善率 |
| ---------- | --------------- | ------ | ------ |
| **平均**   | 26.29s          | 32.65s | -19.5% |
| **中央値** | 26.23s          | 32.61s | -19.6% |
| **最速**   | 26.09s          | 32.47s |        |
| **最遅**   | 26.83s          | 32.98s |        |

## 環境

- Platform: Linux 6.17.0-14-generic
- Node.js: v22.x
- 両ブランチを同一マシン上の別worktreeで並行実行

## 変更内容

- プロダクションコードの `@vivliostyle/jsdom` 使用を全て `hast` ツリー操作（`rehype`, `hastscript`, `unist-util-visit`, `hast-util-to-html`）に置換
- `ResourceFetcher` クラスでJSDOMの `ResourceLoader` を代替（リモートリソース取得）
- `dompurify`, `w3c-xmlserializer` をプロダクション依存から削除
- `@vivliostyle/jsdom` は devDependencies に移動（テストのアサーション用のみ）
