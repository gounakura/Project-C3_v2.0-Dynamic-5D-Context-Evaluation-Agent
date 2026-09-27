import { GoogleGenAI, Type, FunctionDeclaration } from '@google/genai';
import * as dotenv from 'dotenv';
import * as readline from 'readline';

dotenv.config();

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  console.error('▲ エラー: .env ファイルに GEMINI_API_KEY を設定してください。');
  process.exit(1);
}

const ai = new GoogleGenAI({ apiKey });

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function callWithRetry<T>(fn: () => Promise<T>, retries = 5, defaultWaitMs = 3000): Promise<T> {
  try {
    return await fn();
  } catch (error: any) {
    const status = error?.status || error?.code;
    if ((status === 429 || status === 503 || error?.message?.includes('503')) && retries > 0) {
      console.warn(`\n⚠️ サーバー一時応答エラー(${status || '503'})を検知。${defaultWaitMs / 1000}秒後に自動再試行します... (残り${retries}回)`);
      await delay(defaultWaitMs);
      return callWithRetry(fn, retries - 1, defaultWaitMs * 1.5);
    }
    throw error;
  }
}

function askQuestion(query: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(query, answer => { rl.close(); resolve(answer); }));
}

// ----------------------------------------------------------------------
// MCP セキュリティ・ガードレール関数
// ----------------------------------------------------------------------
function isUrlAllowed(targetUrl: string): { allowed: boolean; reason?: string } {
  try {
    const parsed = new URL(targetUrl);
    const hostname = parsed.hostname.toLowerCase();
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { allowed: false, reason: 'http / https 以外のプロトコルは遮断されました。' };
    }
    const blockedPatterns = ['localhost', '127.0.0.1', '0.0.0.0', '169.254.169.254', '::1'];
    if (blockedPatterns.includes(hostname) || hostname.startsWith('192.168.') || hostname.startsWith('10.')) {
      return { allowed: false, reason: 'セキュリティ保護のため、内部ネットワーク接続は禁止されています (SSRF対策)。' };
    }
    return { allowed: true };
  } catch {
    return { allowed: false, reason: '無効なURLフォーマットです。' };
  }
}

function sanitizeFetchedContent(rawText: string): string {
  const injectionPatterns = [
    /ignore previous instructions/gi,
    /これまでの指示を(すべて|全て)? (無視|リセット)/gi,
    /system instruction/gi,
    /you are now a/gi
  ];
  let sanitized = rawText;
  for (const pattern of injectionPatterns) {
    sanitized = sanitized.replace(pattern, '[▲不審な命令語句をブロックしました]');
  }
  return sanitized;
}

// ----------------------------------------------------------------------
// Webフェッチ処理
// ----------------------------------------------------------------------
interface WebFetchResult {
  url: string;
  role: string;
  success: boolean;
  rawText: string;
  errorMessage?: string;
}

async function fetchDirectUrlText(targetUrl: string, role: string): Promise<WebFetchResult> {
  const roleLabel = role === 'main' ? '【メイン評価対象】' : '【比較対照ソース】';
  console.log(`\n🔍 ${roleLabel} ページへアクセス検証中: ${targetUrl}`);
  
  const urlCheck = isUrlAllowed(targetUrl);
  if (!urlCheck.allowed) {
    console.log(`[MCP Security Guard] アクセス拒否: ${urlCheck.reason}`);
    return { url: targetUrl, role, success: false, rawText: '', errorMessage: `SECURITY_BLOCK: ${urlCheck.reason}` };
  }

  try {
    const response = await fetch(targetUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language': 'ja, en-US;q=0.9,en;q=0.8'
      }
    });
    if (!response.ok) {
      return { url: targetUrl, role, success: false, rawText: '', errorMessage: `HTTP STATUS: ${response.status}` };
    }
    const html = await response.text();
    const cleanText = html
      .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
      .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
      .replace(/<[^>]+>/g, '')
      .replace(/\s+/g, ' ')
      .trim();

    if (cleanText.length < 50) {
      return { url: targetUrl, role, success: false, rawText: '', errorMessage: '有効なテキストが抽出できませんでした。' };
    }
    const safeText = sanitizeFetchedContent(cleanText).slice(0, 4000);
    return { url: targetUrl, role, success: true, rawText: safeText };
  } catch (err: any) {
    return { url: targetUrl, role, success: false, rawText: '', errorMessage: `接続エラー: ${err.message}` };
  }
}

// 一括フェッチ用統合MCPツール定義
const fetchUrlTextBatchDeclaration: FunctionDeclaration = {
  name: 'fetch_url_text_batch',
  description: 'メインURLおよび比較対照URL（指定がある場合）のウェブページコンテンツを一括取得してセキュリティ検証を行います。',
  parameters: {
    type: Type.OBJECT,
    properties: {
      mainUrl: { type: Type.STRING, description: '評価対象(メイン)のURL' },
      compareUrl: { type: Type.STRING, description: '比較対照のURL (任意・未指定時は空文字)' }
    },
    required: ['mainUrl']
  }
};

async function executeTool(name: string, args: any) {
  console.log(`\n[MCP Server Action] ツール "${name}" を一括実行中...`);
  if (name === 'fetch_url_text_batch') {
    const mainResult = await fetchDirectUrlText(args.mainUrl, 'main');
    let compareResult: WebFetchResult | null = null;
    
    if (args.compareUrl && args.compareUrl.startsWith('http')) {
      compareResult = await fetchDirectUrlText(args.compareUrl, 'compare');
    }
    
    return {
      status: 'success',
      mainData: mainResult,
      compareData: compareResult
    };
  }
  throw new Error(`未知のツール: ${name}`);
}

async function runAgent() {
  console.log('\n==================================================');
  console.log(' 🛡️ C3: 超立方体5次元コンテキスト評価エージェント v2.1');
  console.log(' (自律軸確定後の動的ウエイト入力＆加重平均スコア算出機能)');
  console.log('==================================================\n');

  // 1. メインURL入力
  console.log('1. 評価したい「メイン(自社等)」のプレスリリース/記事 URL を入力してください。');
  const mainUrlInput = await askQuestion('> ');
  const mainUrl = mainUrlInput.trim();
  if (!mainUrl.startsWith('http')) {
    console.error('▲ 正しいURLを入力してください。');
    process.exit(1);
  }

  // 2. 比較URL入力
  console.log('\n2. 比較したい「対照(競合他社など)」のURLを入力してください。');
  console.log(' (空欄のまま[Enter]を押すと、内部知識から競合他社を自動指定します)');
  const compareUrlInput = await askQuestion('> ');
  const compareUrl = compareUrlInput.trim();

  // 3. 評価水準レベルの選択
  console.log('\n3. 評価指標の全体的レベル(厳格度)を選択してください:');
  console.log('   [A] Hard    : 厳格監査モード (法的リスクや根拠欠如を厳しく追及)');
  console.log('   [B] Neutral : 標準評価モード (業界水準に基づく客観的評価・デフォルト)');
  console.log('   [C] Soft    : ポジティブ評価モード (強みや独自性を前向きに評価)');
  const strictnessInput = (await askQuestion('選択 [A/B/C] (デフォルト: B): ')).trim().toUpperCase();
  let strictnessMode = 'Neutral (標準評価)';
  let strictnessPrompt = '標準的な基準で客観的に評価してください。';
  if (strictnessInput === 'A') {
    strictnessMode = 'Hard (厳格監査)';
    strictnessPrompt = '非常に厳しい基準で審査してください。わずかなリスクや根拠不足も妥協せず厳しくスコアに反映させてください。';
  } else if (strictnessInput === 'C') {
    strictnessMode = 'Soft (ポジティブ評価)';
    strictnessPrompt = 'ポジティブな側面や加点要素を積極的に評価し、成長・改善を促す前向きなスコア付けを行ってください。';
  }

  const systemInstructionStep1 = `あなたは企業広報・コンプライアンス・マーケティング戦略および情報科学を専門とする最高級 AI エージェントです。

【ミッション】
指定されたURLの内容を取得後、固定3軸に加え、このテキストの文脈から**独自に生成すべき2つの評価軸（軸4および軸5）を定義**してJSON形式で回答してください。

【評価軸ルール】
1. 固定軸1: コンプライアンス健全性
2. 固定軸2: 商業的・マーケティング訴求力
3. 固定軸3: 透明性・エビデンス性
4. 自律軸4: 解析テキストの業界・背景から導く特有の評価視点（例: 『地域社会・防災レジリエンス適合性』など）
5. 自律軸5: 解析テキストの課題・目的に合わせた評価視点（例: 『事業拡張・実装スケーラビリティ』など）

必ず以下のJSON形式のテキストのみを出力してください。
\`\`\`json
{
  "axis1": "コンプライアンス健全性 (固定)",
  "axis2": "商業的・マーケティング訴求力 (固定)",
  "axis3": "透明性・エビデンス性 (固定)",
  "axis4": "あなたが命名した自律軸4の名称",
  "axis4_desc": "軸4の簡単な説明",
  "axis5": "あなたが命名した自律軸5の名称",
  "axis5_desc": "軸5の簡単な説明"
}
\`\`\``;

  const chat = ai.chats.create({
    model: 'gemini-3.6-flash',
    config: {
      systemInstruction: systemInstructionStep1,
      tools: [{ functionDeclarations: [fetchUrlTextBatchDeclaration] }]
    }
  });

  console.log('\n⚙️  Webページのテキストを取得し、LLMによる評価軸の分析・自動生成を行っています...');

  // API呼び出し 1回目：コンテンツ取得 ＋ 自律軸の分析定義
  let response = await callWithRetry(() => chat.sendMessage({
    message: `メインURL「${mainUrl}」および比較URL「${compareUrl}」を一括取得し、自律軸4と自律軸5を定義してください。`
  }));

  const candidate = response.candidates?.[0];
  const functionCall = candidate?.content?.parts?.find(part => part.functionCall)?.functionCall;

  let step1ResultText = '';
  if (functionCall) {
    const fetchResult = await executeTool(functionCall.name, functionCall.args);
    await delay(1000);

    const step1Response = await callWithRetry(() => chat.sendMessage({
      message: [{ functionResponse: { name: functionCall.name, response: fetchResult } }]
    }));
    step1ResultText = step1Response.text || '';
  } else {
    step1ResultText = response.text || '';
  }

  // JSON解析と軸名の抽出
  let axis4Name = '自律評価軸4 (地域・環境適合性等)';
  let axis4Desc = '文章の文脈から導かれた独自視点1';
  let axis5Name = '自律評価軸5 (事業拡張性・構造美等)';
  let axis5Desc = '文章の文脈から導かれた独自視点2';

  try {
    const jsonMatch = step1ResultText.match(/```json\s*([\s\S]*?)\s*```/) || step1ResultText.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[1] || jsonMatch[0]);
      if (parsed.axis4) axis4Name = parsed.axis4;
      if (parsed.axis4_desc) axis4Desc = parsed.axis4_desc;
      if (parsed.axis5) axis5Name = parsed.axis5;
      if (parsed.axis5_desc) axis5Desc = parsed.axis5_desc;
    }
  } catch (e) {
    // パース失敗時はデフォルト軸名を使用
  }

  // 4. 【改善点】5軸が出揃った状態を表示し、ユーザーにウエイト入力を促す
  console.log('\n==================================================');
  console.log(' 🎯 LLMがテキスト文脈から定義した「5次元評価空間」');
  console.log('==================================================');
  console.log(` 軸1 [固定]: コンプライアンス健全性 (1:リスク ～ 5:健全)`);
  console.log(` 軸2 [固定]: 商業的・マーケティング訴求力 (1:埋没 ～ 5:強力)`);
  console.log(` 軸3 [固定]: 透明性・エビデンス性 (1:無根拠 ～ 5:明確)`);
  console.log(` 軸4 [自律]: ${axis4Name} (${axis4Desc})`);
  console.log(` 軸5 [自律]: ${axis5Name} (${axis5Desc})`);
  console.log('--------------------------------------------------');
  console.log('各軸の重み(ウエイト)を入力してください。');
  console.log('※ 変更する場合は 5 つの数値をスペース区切りで入力（例: 1.0 0.8 1.0 0.5 0.6）');
  console.log('※ そのまま [Enter] を押すと【全軸 1.0】が適用されます。');
  
  const weightsInput = (await askQuestion('ウエイト設定 > ')).trim();
  
  let weights = [1.0, 1.0, 1.0, 1.0, 1.0];
  if (weightsInput.length > 0) {
    const parsedWeights = weightsInput.split(/\s+/).map(Number);
    if (parsedWeights.length === 5 && parsedWeights.every(n => !isNaN(n))) {
      weights = parsedWeights;
    } else {
      console.log('⚠️ 入力形式が無効なため、デフォルトウエイト [1.0 1.0 1.0 1.0 1.0] を使用します。');
    }
  }

  console.log(`\n⏳ 確定ウエイト [${weights.join(', ')}] に基づき、5次元評価レポートを出力しています...`);

  // 5. 確定した軸名とウエイトをもとに、最終レポートを一括生成（API呼び出し 2回目）
  const systemInstructionStep2 = `あなたは企業広報・コンプライアンス・マーケティング戦略および情報科学を専門とする最高級 AI エージェントです。

【評価水準方針】
現在の評価モード: **${strictnessMode}**
${strictnessPrompt}

【ミッション】
提示された文章に対し、以下の【確定した5次元評価軸】に基づいて厳格かつ詳細なコンテキスト評価レポートを作成してください。

【確定された5次元評価軸】
1. **軸1 [固定]**: コンプライアンス健全性 (1:重大リスクあり ～ 5:極めて健全) [ウエイト: ${weights[0]}]
2. **軸2 [固定]**: 商業的・マーケティング訴求力 (1:埋没 ～ 5:強力・高訴求) [ウエイト: ${weights[1]}]
3. **軸3 [固定]**: 透明性・エビデンス性 (1:無根拠 ～ 5:データ・ソース明確) [ウエイト: ${weights[2]}]
4. **軸4 [自律]**: ${axis4Name} (${axis4Desc}) [ウエイト: ${weights[3]}]
5. **軸5 [自律]**: ${axis5Name} (${axis5Desc}) [ウエイト: ${weights[4]}]

【出力フォーマット】
==================================================
【1. 多角分析ソース識別 & 超立方体5次元評価軸の定義】
■ メイン評価対象: [企業名・テーマ] (URL: ${mainUrl})
■ 比較対照アサイン: [URLまたはLLMが指定した競合企業名]
■ 評価モード: ${strictnessMode}

■ 本セッションにおける5次元評価空間の定義 & 設定ウエイト:
1. [固定] コンプライアンス健全性 : (1:リスク ～ 5:健全) [ウエイト: ${weights[0]}] - 景表法・誇大表現等の法的リスク
2. [固定] 商業的訴求力         : (1:埋没 ～ 5:強力) [ウエイト: ${weights[1]}] - 市場での魅力・顧客を惹きつける力
3. [固定] 透明性・エビデンス性   : (1:無根拠 ～ 5:明確) [ウエイト: ${weights[2]}] - 数値・客観的データによる裏付け
4. [自律] ${axis4Name} : (1 ～ 5段階) [ウエイト: ${weights[3]}] - ${axis4Desc}
5. [自律] ${axis5Name} : (1 ～ 5段階) [ウエイト: ${weights[4]}] - ${axis5Desc}
==================================================
【2. 一目でわかるビジュアル5次元比較対照表】
| 評価次元 / 軸 | メイン(自社・指定ページ) | 比較対照(競合他社/水準) | 判定スコア & コンテキスト差分 |
| :--- | :--- | :--- | :--- |
| **対象企業・サービス名** | [メイン企業名] | [競合企業名] | [対比設定] |
| **1. コンプライアンス** | [メインの状況] | [競合の状況] | [1~5点] + [理由解説] |
| **2. 商業的訴求力** | [メインの状況] | [競合の状況] | [1~5点] + [理由解説] |
| **3. 透明性・エビデンス** | [数値・データ提示の有無] | [競合のデータ開示状況] | [1~5点] + [理由解説] |
| **4. ${axis4Name}** | [メインの該当状況] | [競合の状況] | [1~5点] + [理由解説] |
| **5. ${axis5Name}** | [メインの該当状況] | [競合の状況] | [1~5点] + [理由解説] |
==================================================
【3. 定量加重スコア & 総合評価サマリー】
■ 各軸スコアとウエイト計算:
 - 軸1 (コンプライアンス) : [X点] × 重み ${weights[0]} = [計算値]
 - 軸2 (商業的訴求力)    : [X点] × 重み ${weights[1]} = [計算値]
 - 軸3 (透明性エビデンス) : [X点] × 重み ${weights[2]} = [計算値]
 - 軸4 (${axis4Name})     : [X点] × 重み ${weights[3]} = [計算値]
 - 軸5 (${axis5Name})     : [X点] × 重み ${weights[4]} = [計算値]

🎯 **加重平均・総合評価スコア: 【 X.XX / 5.00 点 】**
※（計算式: 各[獲得点×重み]の合計 ÷ 重みの総和 ${weights.reduce((a,b)=>a+b,0).toFixed(1)}）

■ 超立方体ポジショニング分析:
 [ 全体判定結果 ] 
 ※評価モード(${strictnessMode})およびウエイトバランスを踏まえた深い考察。

■ 実文章からの問題点・強調点直接引用:
・メイン記事の文言: 「[本文からそのまま抽出]」
・多角的解説: [競合と比較したリスク、データ根拠の有無、独自軸での強み・弱みの解説]
==================================================
【4. 役員・広報責任者向け改善アクションプラン】
[スコアを高め、リスクを抑えるための具体的修正案 (Before → After)]
==================================================
【5. 一次情報・深掘り検証用 Google 検索ショートカット】
■ 推奨検索キーワード: [企業名 + 競合名 + プレスリリース 等]
■ Google 検索用URL: https://www.google.com/search?q=[URL エンコードされた検索キーワード]
==================================================`;

  const reportChat = ai.chats.create({
    model: 'gemini-3.6-flash',
    config: { systemInstruction: systemInstructionStep2 }
  });

  const finalResponse = await callWithRetry(() => reportChat.sendMessage({
    message: `取得したコンテキストに基づき、決定した軸・ウエイトで5次元コンテキスト評価レポートを作成してください。`
  }));

  if (finalResponse.text) {
    console.log(`\n==================================================`);
    console.log(` 🛡️ 多次元(5次元超立方体)コンテキスト評価レポート`);
    console.log(`==================================================`);
    console.log(finalResponse.text);
  }

  console.log('\n--------------------------------------------------');
  console.log(' 🎉 5次元超立方体評価レポートの出力が完了しました。');
  console.log('--------------------------------------------------');
  process.exit(0);
}

runAgent().catch(err => {
  console.error('エラー:', err);
  process.exit(1);
});