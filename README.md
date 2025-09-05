FreeNEP (Next Edit Prediction) VS Code 拡張

概要

- OpenAI 互換 API を用いて、エディタ内の「次の編集」を予測します。
- 入力が止まると、予測位置にインラインでプレビューを表示します。
- Tab を1回押すとカーソルが予測位置へジャンプ、もう1回押すと提案を適用します。Esc で破棄できます。

特徴

- ホバープレビュー: 予測された変更はホバーで詳細表示。Tab は 2 段階で適用。
- アイドル検知: 入力停止から一定時間後に自動でモデルに問い合わせ。
- OpenAI 互換 API: npm の `openai` パッケージを使用。Base URL と API キーは拡張のサイドバーで設定。
- ログ保存: レスポンスに editable region が含まれる場合のみ、入力/出力と採否を 1 リクエスト 1 ファイルで保存。
- 活動中表示: 推論実行中はアクティビティバーの NEP ビューにバッジと “Generating…” を表示。

プレビュー表示のモード

- 変更のプレビューはホバーで表示します。既定では「Before / After」を別々のコードブロックで表示します（`minoshiro.previewHoverMode: "split"`）。
- 統合 diff で見たい場合は、設定で `minoshiro.previewHoverMode` を `"diff"` にすると、`Changes (diff)` と `After` を表示します。
- 自動でホバーを開くには `minoshiro.autoShowPreview` を有効化し、`minoshiro.autoShowPreviewDelayMs` で遅延を調整できます。

モデル入出力仕様（minoshiro-NEP-v1-sft 準拠）

- System プロンプト（モデルカード推奨の固定文言）
  You are a code completion assistant. Your job is to rewrite the excerpt provided by the user, analyzing their edits and suggesting appropriate edits within the excerpt, taking into account the cursor's position.
  The region where you can suggest the next edit is between <|editable_region_start|> and <|editable_region_end|>. Please predict the next edit between these tags and write the code that will fit within that region after the edits are applied.

- User メッセージ構成
  - 直近編集履歴（markdown の diff）を “### User Edits:” の後に記載。
  - 現在のコード断片を “### Currently User Code:” の後に、`<|editable_region_start|>` と `<|editable_region_end|>` で囲んで渡します。
  - カーソル位置は `<|user_cursor_is_here|>` を挿入して明示します。

- モデル出力
  - 任意の `<think>...</think>` を含む場合があります（拡張側で無視）。
  - 重要なのは `<|editable_region_start|>` と `<|editable_region_end|>` の間に出力される「編集適用後のコード」。
  - 拡張側は入力 region と出力 region の差分から「最初の変更ハンク」を次の編集として推定し、ジャンプ/適用を行います。

設定（Activity Bar > NEP > Settings）

- `minoshiro.apiBaseUrl`: OpenAI 互換 Base URL（例: `https://api.openai.com/v1`）。
- API キー: サイドバーで入力し、VS Code Secret Storage に安全に保存。
- `minoshiro.model`: モデル名（既定: `minoshiro-NEP-v1-sft`）。
- `minoshiro.editHistoryLimit`: モデルに送る直近の編集 diff 件数（既定 10）。
- `minoshiro.idleDelayMs`: 入力停止から問い合わせまでの遅延（既定 1000ms）。
- `minoshiro.logDirectory`: ログ保存先ディレクトリ（未指定時は拡張のグローバル領域）。
- `minoshiro.autoShowPreview`: 提案の詳細ホバーを自動表示（既定: 有効）。
- `minoshiro.autoShowPreviewDelayMs`: ホバー自動表示の遅延。
- `minoshiro.previewHoverMode`: `split`（Before/After を個別表示）/ `diff`（統合 diff 表示）。

使い方

- 左のアクティビティバーの `NEP` を開き、`Settings` で Base URL と API キー、モデル名などを設定。
- コードを編集して手を止めると、モデルへの問い合わせが走り、ホバーでプレビューが表示されます（自動表示を無効にしている場合は、対象位置にマウスを置くかコマンド `Editor: Show Hover` を実行）。
- Tab: 提案が表示中のみ有効。
  - 1回目: 予測開始位置へジャンプ。
  - 2回目: その変更（挿入/置換）を適用。
- Esc: 提案を破棄。

ログ（1 リクエスト 1 JSON）

- 保存項目（成功時のみファイル作成）:
  - `events`: モデルへ渡した直近編集履歴（markdown の diff）。
  - `input_context`: モデルへ渡した現在のファイル情報（パス/言語ID/カーソル/全文、`region` にはマーカー入り断片）。
  - `output_context`: モデルからの生出力（文字列全体）。
  - `eval`: 採用可否（`"accepted" | "rejected" | "pending"`）。

インストール / ビルド / 実行

- 依存関係の導入: `npm install`
- ビルド: `npm run compile`
- デバッグ実行: VS Code で本フォルダを開き、F5 で Extension Development Host を起動。
- 初回起動後、NEP サイドバーから設定してください。

既知の制限・注意点

- 初回の差分は前スナップショットが空のため大きくなる場合があります（以降は増分）。
- モデルが editable region を返さなかった場合は提案なしとして扱います。
- 大規模ファイルでは推論時間が伸びることがあります。必要に応じて region をカーソル近傍に絞る最適化を追加可能です。

ライセンス

- 本リポジトリのコードは `LICENSE` を参照してください。
