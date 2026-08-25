import fs from "node:fs/promises";
import path from "node:path";
import {
  Presentation,
  PresentationFile,
  layers,
  shape,
  text,
} from "@oai/artifact-tool";

const TMP_DIR = "C:\\Users\\yonem\\Documents\\GitHub\\discord-bot-source\\presentation-build";
const FINAL_PPTX = "C:\\Users\\yonem\\Documents\\GitHub\\discord-bot-source\\discord-bot-implementation-report.pptx";

const W = 1280;
const H = 720;
const FONT = "Yu Gothic";
const FONT_MONO = "Consolas";

const C = {
  canvas: "#FFFFFF",
  ink: "#111318",
  muted: "#60646C",
  panel: "#F2F3F5",
  panelStrong: "#E6E8EC",
  rule: "#B8BCC4",
  accent: "#5865F2",
  accentDark: "#3642C9",
  accentLight: "#EEF0FF",
  good: "#2DA44E",
  warn: "#C98500",
  bad: "#D1242F",
  dark: "#17191F",
};

const sourceNotes = await fs.readFile(path.join(TMP_DIR, "source-notes.txt"), "utf8");

function sourceBlock(slideNumber) {
  const next = slideNumber + 1;
  const pattern = new RegExp(`Slide ${slideNumber}[^\\n]*\\n([\\s\\S]*?)(?=\\nSlide ${next}[^\\n]*\\n|$)`);
  return sourceNotes.match(pattern)?.[1]?.trim() ?? "[Sources]\n- Local repository and decisions recorded in this Codex task.";
}

function rich(value, size, { color = C.ink, bold = false, typeface = FONT, italic = false, line = 104000 } = {}) {
  return {
    runs: [{
      run: String(value),
      textStyle: { fontSize: `${size}px`, typeface, color, bold, italic },
    }],
    paragraphStyle: { lineSpacingPercent: line },
  };
}

function tx(name, value, left, top, width, height, size, {
  color = C.ink,
  bold = false,
  typeface = FONT,
  italic = false,
  align = "left",
  valign = "top",
  fit = "shrinkText",
  inset = 0,
  line = 104000,
} = {}) {
  return text([rich(value, size, { color, bold, typeface, italic, line })], {
    name,
    position: { left, top },
    width,
    height,
    style: {
      fontSize: `${size}px`,
      typeface,
      color,
      alignment: align,
      verticalAlignment: valign,
      autoFit: fit,
      wrap: "square",
      insets: { top: inset, right: inset, bottom: inset, left: inset },
    },
  });
}

function box(name, left, top, width, height, fill = C.panel, {
  geometry = "rect",
  lineFill = "none",
  lineWidth = 0,
} = {}) {
  return shape({
    name,
    geometry,
    fill,
    line: { style: "solid", fill: lineFill, width: lineWidth },
    position: { left, top },
    width,
    height,
  });
}

function rule(name, left, top, width, height = 0.5, fill = C.rule, weight = 1) {
  return shape({
    name,
    geometry: "straightConnector1",
    fill: "none",
    line: { style: "solid", fill, width: weight },
    position: { left, top },
    width,
    height,
  });
}

function dot(name, left, top, size = 12, fill = C.accent) {
  return box(name, left, top, size, size, fill, { geometry: "ellipse" });
}

function footer(slideNumber, label = "IMPLEMENTATION REPORT") {
  return [
    tx(`footer-label-${slideNumber}`, label, 48, 673, 420, 20, 12, { color: C.muted, bold: true, valign: "middle" }),
    tx(`footer-num-${slideNumber}`, String(slideNumber).padStart(2, "0"), 1187, 669, 48, 24, 13, { color: C.muted, align: "right", valign: "middle" }),
  ];
}

function header(slideNumber, title, kicker = "LONG-TERM OPERATIONS") {
  return [
    tx(`kicker-${slideNumber}`, kicker, 48, 34, 460, 24, 13, { color: C.accent, bold: true, valign: "middle" }),
    tx(`title-${slideNumber}`, title, 48, 67, 1110, 82, 40, { bold: true, line: 96000 }),
    rule(`header-rule-${slideNumber}`, 48, 155, 1184, 0.2, C.ink, 1),
  ];
}

function makeSlide(slideNumber, title, elements, notes, kicker) {
  const slide = deck.slides.add();
  slide.background.fill = C.canvas;
  const all = title ? [...header(slideNumber, title, kicker), ...elements, ...footer(slideNumber)] : elements;
  slide.compose(
    layers({ name: `implementation-slide-${slideNumber}`, width: "fill", height: "fill" }, all),
    { frame: { left: 0, top: 0, width: W, height: H }, baseUnit: 1 },
  );
  slide.speakerNotes.textFrame.setText(`${notes.trim()}\n\n${sourceBlock(slideNumber)}`);
  slide.speakerNotes.setVisible(true);
  return slide;
}

const deck = Presentation.create({ slideSize: { width: W, height: H } });

// 1 — title
makeSlide(1, null, [
  tx("cover-kicker", "DISCORD BOT / IMPLEMENTATION REPORT", 48, 42, 650, 30, 14, { color: C.accent, bold: true, valign: "middle" }),
  tx("cover-title", "長期運用基盤\n実装完了レポート", 48, 164, 850, 190, 62, { bold: true, line: 92000 }),
  tx("cover-subtitle", "/checkbot・30分reconciliation・安全な設定管理", 52, 392, 850, 44, 24, { color: C.muted, valign: "middle" }),
  rule("cover-rule", 48, 470, 790, 0.2, C.ink, 1),
  tx("cover-date", "2026.08  /  discord-voice-grouper", 52, 500, 590, 30, 16, { color: C.muted, valign: "middle" }),
  box("cover-bar-1", 1018, 128, 34, 430, C.accent),
  box("cover-bar-2", 1072, 225, 34, 333, C.accentLight),
  box("cover-bar-3", 1126, 325, 34, 233, C.panelStrong),
  tx("cover-num", "01", 1184, 670, 48, 22, 13, { color: C.muted, align: "right" }),
], "この資料は、今回選定した3機能の実装内容、安全設計、最終監査、検証結果を一つの運用ストーリーとして説明します。");

// 2 — decision
makeSlide(2, "3つの機能を、一つの運用基盤として実装", [
  tx("decision-big", "4 / 5 / 6", 48, 196, 340, 100, 54, { color: C.accent, bold: true, valign: "middle" }),
  tx("decision-caption", "診断・定期観測・安全な変更を\n切れ目なくつなぐ", 48, 306, 330, 92, 24, { bold: true, line: 112000 }),
  tx("decision-support", "単発の便利機能ではなく、\n1年規模の保守を支える仕組みにした。", 48, 438, 330, 84, 18, { color: C.muted, line: 116000 }),

  tx("d4-num", "04", 454, 190, 58, 34, 18, { color: C.accent, bold: true, valign: "middle" }),
  tx("d4-title", "/checkbot を /setup から分離", 532, 185, 650, 38, 25, { bold: true, valign: "middle" }),
  tx("d4-body", "権限と対象リソースだけを、変更せずに確認する。", 532, 228, 650, 28, 18, { color: C.muted }),
  rule("d4-rule", 454, 273, 730, 0.2, C.rule, 1),

  tx("d5-num", "05", 454, 302, 58, 34, 18, { color: C.accent, bold: true, valign: "middle" }),
  tx("d5-title", "reconciliation は30分ごと", 532, 297, 650, 38, 25, { bold: true, valign: "middle" }),
  tx("d5-body", "Discord上の実態と保存状態のずれを継続観測する。", 532, 340, 650, 28, 18, { color: C.muted }),
  rule("d5-rule", 454, 385, 730, 0.2, C.rule, 1),

  tx("d6-num", "06", 454, 414, 58, 34, 18, { color: C.accent, bold: true, valign: "middle" }),
  tx("d6-title", "設定変更を履歴・適用・復旧まで管理", 532, 409, 650, 38, 25, { bold: true, valign: "middle" }),
  tx("d6-body", "下書き、差分、transaction、適用job、rollbackを一貫化。", 532, 452, 650, 52, 18, { color: C.muted }),
], "ユーザー指定の優先順位4・5・6を、そのまま三層の運用基盤に落とし込みました。4位は独立コマンド、5位は30分間隔、6位は設定変更の全ライフサイクルが要点です。");

// 3 — architecture
makeSlide(3, "診断 → 観測 → 変更の3層で長期運用を支える", [
  box("arch-rail", 48, 190, 8, 382, C.accent),
  tx("arch-1-tag", "01  DIAGNOSE", 82, 188, 220, 32, 14, { color: C.accent, bold: true, valign: "middle" }),
  tx("arch-1-title", "/checkbot", 82, 224, 250, 42, 30, { bold: true }),
  tx("arch-1-body", "必要権限・チャンネル・ロール・機能別依存を\n読み取り専用で検証", 350, 216, 760, 62, 20, { color: C.muted, line: 112000 }),
  rule("arch-1-rule", 82, 292, 1090, 0.2, C.rule, 1),

  tx("arch-2-tag", "02  OBSERVE", 82, 316, 220, 32, 14, { color: C.accent, bold: true, valign: "middle" }),
  tx("arch-2-title", "30分reconciliation", 82, 352, 300, 42, 30, { bold: true }),
  tx("arch-2-body", "保存設定とDiscord上の実態を比較し、\n観測結果と安全な修復候補を永続化", 430, 344, 680, 62, 20, { color: C.muted, line: 112000 }),
  rule("arch-2-rule", 82, 420, 1090, 0.2, C.rule, 1),

  tx("arch-3-tag", "03  CHANGE", 82, 444, 220, 32, 14, { color: C.accent, bold: true, valign: "middle" }),
  tx("arch-3-title", "/setup + /config", 82, 480, 300, 42, 30, { bold: true }),
  tx("arch-3-body", "変更を下書き・履歴・差分・適用job・\nrollbackとして追跡可能にする", 430, 472, 680, 62, 20, { color: C.muted, line: 112000 }),
  tx("arch-close", "READ-ONLY", 1120, 220, 100, 22, 12, { color: C.muted, bold: true, align: "right" }),
  tx("arch-close2", "CONTROLLED WRITE", 1040, 502, 180, 22, 12, { color: C.accent, bold: true, align: "right" }),
], "3機能は独立していますが、運用上は順序があります。まず診断し、次に定期観測し、必要なときだけ管理された書き込みへ進みます。");

// 4 — checkbot
makeSlide(4, "/checkbot は、変更せずに実行可能性を診断する", [
  box("checkbot-command-bg", 48, 193, 465, 146, C.dark),
  tx("checkbot-command-label", "COMMAND", 74, 213, 180, 22, 12, { color: "#AEB4C0", bold: true }),
  tx("checkbot-command", "/checkbot feature:all", 74, 255, 400, 46, 27, { color: "#FFFFFF", bold: true, typeface: FONT_MONO, valign: "middle" }),
  tx("checkbot-note", "設定は変更しない / 結果はephemeral", 74, 307, 400, 22, 14, { color: "#AEB4C0" }),

  tx("checkbot-point-1", "1", 570, 188, 28, 28, 15, { color: C.accent, bold: true, valign: "middle" }),
  tx("checkbot-point-1-title", "管理者だけが実行", 610, 184, 520, 30, 22, { bold: true }),
  tx("checkbot-point-1-body", "ManageGuild必須・サーバー内限定・DM無効。", 610, 218, 550, 28, 17, { color: C.muted }),
  rule("checkbot-r1", 570, 257, 610, 0.2, C.rule, 1),

  tx("checkbot-point-2", "2", 570, 276, 28, 28, 15, { color: C.accent, bold: true, valign: "middle" }),
  tx("checkbot-point-2-title", "全対応機能を横断", 610, 272, 520, 30, 22, { bold: true }),
  tx("checkbot-point-2-body", "機能別の権限、対象channel/role、依存設定を確認。", 610, 306, 570, 48, 17, { color: C.muted }),
  rule("checkbot-r2", 570, 365, 610, 0.2, C.rule, 1),

  tx("checkbot-point-3", "3", 570, 384, 28, 28, 15, { color: C.accent, bold: true, valign: "middle" }),
  tx("checkbot-point-3-title", "機能差を正しく判定", 610, 380, 520, 30, 22, { bold: true }),
  tx("checkbot-point-3-body", "例：callwait通知はManageMessages必須、promptは不要。", 610, 414, 570, 48, 17, { color: C.muted }),

  rule("checkbot-status-rule", 48, 510, 1132, 0.2, C.ink, 1),
  dot("status-ok", 54, 544, 12, C.good),
  tx("status-ok-label", "正常", 76, 536, 95, 28, 17, { bold: true, valign: "middle" }),
  dot("status-warn", 226, 544, 12, C.warn),
  tx("status-warn-label", "警告・未設定", 248, 536, 150, 28, 17, { bold: true, valign: "middle" }),
  dot("status-bad", 448, 544, 12, C.bad),
  tx("status-bad-label", "実行不能", 470, 536, 120, 28, 17, { bold: true, valign: "middle" }),
  dot("status-unknown", 636, 544, 12, C.rule),
  tx("status-unknown-label", "確認不能", 658, 536, 120, 28, 17, { bold: true, valign: "middle" }),
  tx("status-next", "長い結果はfeature指定で個別確認", 850, 536, 330, 28, 16, { color: C.muted, align: "right", valign: "middle" }),
], "管理者は /setup を始める前に /checkbot を実行できます。読み取り専用で、機能ごとに実行不能・警告・確認不能を分けて返します。DMでは登録されず、結果はephemeralです。");

// 5 — reconciliation
makeSlide(5, "30分ごとの観測と自動修復を、明確に分離した", [
  tx("recon-big", "30", 1007, 34, 104, 76, 56, { color: C.accent, bold: true, align: "right", valign: "middle" }),
  tx("recon-min", "MIN", 1120, 72, 66, 22, 14, { color: C.accent, bold: true, valign: "middle" }),
  rule("recon-line", 84, 330, 1070, 0.2, C.ink, 2),

  dot("recon-dot-1", 79, 322, 17, C.accent),
  tx("recon-stage-1", "OBSERVE", 55, 206, 180, 26, 13, { color: C.accent, bold: true, align: "center" }),
  tx("recon-title-1", "読み取り専用で\n現状を収集", 43, 242, 205, 60, 20, { bold: true, align: "center", line: 106000 }),
  tx("recon-body-1", "Discord APIと保存状態を比較", 43, 352, 205, 46, 16, { color: C.muted, align: "center" }),

  dot("recon-dot-2", 309, 322, 17, C.accent),
  tx("recon-stage-2", "CANDIDATE", 278, 206, 180, 26, 13, { color: C.accent, bold: true, align: "center" }),
  tx("recon-title-2", "allowlistだけを\n修復候補化", 266, 242, 205, 60, 20, { bold: true, align: "center", line: 106000 }),
  tx("recon-body-2", "観測・理由・actionKeyを保存", 266, 352, 205, 46, 16, { color: C.muted, align: "center" }),

  dot("recon-dot-3", 539, 322, 17, C.accent),
  tx("recon-stage-3", "PREFLIGHT", 508, 206, 180, 26, 13, { color: C.accent, bold: true, align: "center" }),
  tx("recon-title-3", "最新状態で\n再確認", 496, 242, 205, 60, 20, { bold: true, align: "center", line: 106000 }),
  tx("recon-body-3", "対象・権限・必要性を確定", 496, 352, 205, 46, 16, { color: C.muted, align: "center" }),

  dot("recon-dot-4", 769, 322, 17, C.accent),
  tx("recon-stage-4", "REPAIR", 738, 206, 180, 26, 13, { color: C.accent, bold: true, align: "center" }),
  tx("recon-title-4", "lease / fencingで\n一度だけ実行", 726, 242, 205, 60, 20, { bold: true, align: "center", line: 106000 }),
  tx("recon-body-4", "結果不明は再実行せず停止", 726, 352, 205, 46, 16, { color: C.muted, align: "center" }),

  dot("recon-dot-5", 999, 322, 17, C.accent),
  tx("recon-stage-5", "POSTFLIGHT", 968, 206, 180, 26, 13, { color: C.accent, bold: true, align: "center" }),
  tx("recon-title-5", "drift消失を\n再検証", 956, 242, 205, 60, 20, { bold: true, align: "center", line: 106000 }),
  tx("recon-body-5", "残存・不明ならappliedにしない", 956, 352, 205, 46, 16, { color: C.muted, align: "center" }),

  box("recon-stop-bg", 48, 472, 1132, 86, C.accentLight),
  tx("recon-stop-label", "FAIL-SAFE", 76, 490, 122, 26, 14, { color: C.accent, bold: true, valign: "middle" }),
  tx("recon-stop", "API不明・対象欠落・権限不足・Discord結果不明 → 自動修復せず BLOCK", 210, 482, 920, 42, 20, { bold: true, valign: "middle" }),
  tx("recon-stop-sub", "blocked / circuit_open は手動確認まで粘着し、次の30分観測で勝手に復活しない。", 210, 524, 920, 26, 15, { color: C.muted }),
], "reconciliation本体は30分ごとの読み取り専用観測です。修復は別jobに分離し、allowlist、最新preflight、lease・fencing、postflightという複数のゲートを通過した場合だけ実行します。");

// 6 — setup
makeSlide(6, "/setup は30分TTLの下書きから、安全に確定する", [
  box("setup-ttl-bg", 966, 184, 214, 96, C.accent),
  tx("setup-ttl", "30 MIN", 996, 197, 154, 40, 31, { color: "#FFFFFF", bold: true, align: "center", valign: "middle" }),
  tx("setup-ttl-sub", "draft TTL", 996, 240, 154, 22, 14, { color: "#DDE1FF", align: "center" }),

  rule("setup-flow-line", 90, 366, 1042, 0.2, C.ink, 2),
  ...[
    { x: 88, n: "01", t: "開始", b: "guild全体で\nactive draftは1件" },
    { x: 292, n: "02", t: "選択", b: "機能ごとの項目を\n下書きへmerge" },
    { x: 496, n: "03", t: "確認", b: "keep / clearを含む\neffective値をreview" },
    { x: 700, n: "04", t: "CAS claim", b: "active → committingを\n原子的に取得" },
    { x: 904, n: "05", t: "再検証", b: "force fetchで削除・\n型変更を検出" },
  ].flatMap((s, i) => [
    dot(`setup-dot-${i}`, s.x, 357, 18, C.accent),
    tx(`setup-num-${i}`, s.n, s.x - 10, 300, 80, 24, 13, { color: C.accent, bold: true }),
    tx(`setup-title-${i}`, s.t, s.x - 10, 326, 150, 28, 20, { bold: true }),
    tx(`setup-body-${i}`, s.b, s.x - 10, 392, 170, 62, 16, { color: C.muted, line: 112000 }),
  ]),

  tx("setup-owner-title", "OWNER ISOLATION", 48, 194, 290, 24, 14, { color: C.accent, bold: true }),
  tx("setup-owner", "再開できるのは作成者だけ。\n別管理者は内容を参照・確定できない。", 48, 228, 420, 58, 19, { bold: true, line: 112000 }),

  box("setup-bottom", 48, 506, 1132, 72, C.panel),
  tx("setup-bottom-label", "COMMIT", 72, 526, 110, 22, 13, { color: C.accent, bold: true }),
  tx("setup-bottom-text", "claimed patchと保持中リソースを再検証 → versioned writerを1回だけ呼び出す", 190, 516, 930, 38, 19, { bold: true, valign: "middle" }),
  tx("setup-bottom-sub", "hidden / clear済みの値はfetch対象外。無効なら設定を書かずに停止する。", 190, 551, 930, 22, 15, { color: C.muted }),
], "下書きは30分で失効し、サーバー全体で一つだけです。確定時はCAS claimの後に、選択値と保持値をDiscordへforce fetchして再検証します。途中で削除・型変更されたリソースは書き込み前に検出されます。");

// 7 — config lifecycle
makeSlide(7, "/config は、設定の履歴から適用・復旧まで追跡する", [
  tx("config-command-label", "OPERATIONS", 48, 192, 200, 24, 13, { color: C.accent, bold: true }),
  tx("config-command-1", "history  /  show  /  diff", 48, 228, 360, 32, 20, { typeface: FONT_MONO, bold: true }),
  rule("config-cr1", 48, 272, 360, 0.2, C.rule, 1),
  tx("config-command-2", "rollback", 48, 289, 360, 32, 20, { typeface: FONT_MONO, bold: true }),
  rule("config-cr2", 48, 333, 360, 0.2, C.rule, 1),
  tx("config-command-3", "apply_status  /  apply_retry", 48, 350, 360, 52, 18, { typeface: FONT_MONO, bold: true }),
  rule("config-cr3", 48, 410, 360, 0.2, C.rule, 1),
  tx("config-command-4", "reconcile_status", 48, 427, 360, 32, 18, { typeface: FONT_MONO, bold: true }),
  rule("config-cr4", 48, 471, 360, 0.2, C.rule, 1),
  tx("config-command-5", "repair_status  /  repair_retry", 48, 488, 370, 52, 18, { typeface: FONT_MONO, bold: true }),

  box("config-flow-bg", 470, 190, 710, 364, C.panel),
  tx("config-step1-tag", "01", 500, 217, 36, 22, 13, { color: C.accent, bold: true }),
  tx("config-step1", "MongoDB transaction", 548, 210, 300, 32, 22, { bold: true }),
  tx("config-step1b", "CASでrevisionを1回だけ進める", 548, 244, 420, 22, 16, { color: C.muted }),
  rule("config-fr1", 500, 281, 632, 0.2, C.rule, 1),

  tx("config-step2-tag", "02", 500, 299, 36, 22, 13, { color: C.accent, bold: true }),
  tx("config-step2", "canonical snapshot + diff", 548, 292, 360, 32, 22, { bold: true }),
  tx("config-step2b", "explicit nullを『未設定』と混同しない", 548, 326, 480, 22, 16, { color: C.muted }),
  rule("config-fr2", 500, 363, 632, 0.2, C.rule, 1),

  tx("config-step3-tag", "03", 500, 381, 36, 22, 13, { color: C.accent, bold: true }),
  tx("config-step3", "apply job", 548, 374, 250, 32, 22, { bold: true }),
  tx("config-step3b", "副作用を同期させ、失敗はstatus/retryへ残す", 548, 408, 520, 22, 16, { color: C.muted }),
  rule("config-fr3", 500, 445, 632, 0.2, C.rule, 1),

  tx("config-step4-tag", "04", 500, 463, 36, 22, 13, { color: C.accent, bold: true }),
  tx("config-step4", "rollback = 新しいrevision", 548, 456, 370, 32, 22, { bold: true }),
  tx("config-step4b", "preflight後に履歴を戻し、適用jobで再反映", 548, 490, 510, 22, 16, { color: C.muted }),

  tx("config-guard", "transaction非対応時は、履歴が空と誤認させず明示的に停止", 470, 572, 710, 30, 17, { color: C.bad, bold: true, align: "right" }),
], "設定はMongoDB transaction内でrevision、snapshot、diff、apply jobを整合させます。rollbackは過去の値へ直接巻き戻すのではなく、新しいrevisionとして記録し、再び適用jobを通します。");

// 8 — fail safe
makeSlide(8, "自動化は『不明なら止まる』を徹底した", [
  tx("safety-statement", "UNKNOWN ≠ OK", 48, 184, 520, 86, 52, { color: C.accent, bold: true, valign: "middle" }),
  tx("safety-sub", "成功を推測しない。再試行してよい瞬間も限定する。", 52, 270, 650, 34, 20, { color: C.muted }),

  tx("safety-allow-title", "実行してよい条件", 48, 350, 480, 34, 24, { bold: true }),
  rule("safety-allow-rule", 48, 394, 518, 0.2, C.good, 3),
  tx("safety-allow-1", "01  actionがallowlistにある", 48, 414, 500, 30, 18, { bold: true }),
  tx("safety-allow-2", "02  最新preflightがconfirmed", 48, 454, 500, 30, 18, { bold: true }),
  tx("safety-allow-3", "03  lease・fencing tokenが有効", 48, 494, 500, 30, 18, { bold: true }),
  tx("safety-allow-4", "04  postflightでdriftが消失", 48, 534, 500, 30, 18, { bold: true }),

  tx("safety-stop-title", "停止する条件", 664, 350, 480, 34, 24, { bold: true }),
  rule("safety-stop-rule", 664, 394, 516, 0.2, C.bad, 3),
  tx("safety-stop-1", "01  Discord APIの結果がunknown", 664, 414, 500, 30, 18, { bold: true }),
  tx("safety-stop-2", "02  target / permissionが欠ける", 664, 454, 500, 30, 18, { bold: true }),
  tx("safety-stop-3", "03  Discord呼び出し後にlease喪失", 664, 494, 500, 30, 18, { bold: true }),
  tx("safety-stop-4", "04  修復後も候補が残る", 664, 534, 500, 30, 18, { bold: true }),

  box("safety-center", 592, 368, 12, 208, C.panelStrong),
], "重要な原則は、unknownを正常扱いしないことです。Discordへの副作用が始まる前だけ限定的にretryし、開始後の結果不明・lease喪失はblockedへ落として人の判断を待ちます。");

// 9 — audit fixes
makeSlide(9, "最終監査で9つの重大境界条件を閉じた", [
  tx("audit-intro", "正常系だけでなく、削除・競合・不明・明示的nullまで回帰テストに固定。", 48, 180, 1050, 30, 19, { color: C.muted }),

  box("audit-rail", 48, 238, 8, 336, C.accent),
  tx("audit-theme-1", "DATA", 80, 236, 130, 24, 13, { color: C.accent, bold: true }),
  tx("audit-text-1", "1  explicit nullをsnapshot / diff / rollbackで保持\n2  kokuchiEventTime変更をkokuchiとvc_dmの両方へ伝播", 222, 232, 930, 64, 18, { bold: true, line: 118000 }),
  rule("audit-r1", 80, 308, 1072, 0.2, C.rule, 1),

  tx("audit-theme-2", "DRIFT", 80, 325, 130, 24, 13, { color: C.accent, bold: true }),
  tx("audit-text-2", "3  status / profile / Oteboの保存channel driftを候補化し、postflightで厳密確認\n4  status-boardのtarget・message同時欠落はunsafeとして自動修復しない", 222, 320, 930, 70, 18, { bold: true, line: 118000 }),
  rule("audit-r2", 80, 402, 1072, 0.2, C.rule, 1),

  tx("audit-theme-3", "OUTCOME", 80, 419, 130, 24, 13, { color: C.accent, bold: true }),
  tx("audit-text-3", "5  VC DM / profile panelの削除失敗をapplied扱いしない\n6  profileは再試行に必要な状態を保持", 222, 414, 930, 64, 18, { bold: true, line: 118000 }),
  rule("audit-r3", 80, 490, 1072, 0.2, C.rule, 1),

  tx("audit-theme-4", "GUARD", 80, 507, 130, 24, 13, { color: C.accent, bold: true }),
  tx("audit-text-4", "7  callwait通知だけManageMessagesを要求\n8  /setup確定後にforce fetch再検証  /  9  DM無効・transaction非対応を明示", 222, 502, 930, 68, 18, { bold: true, line: 118000 }),
], "最終監査では、設定値の意味、機能間依存、保存先drift、Discord削除失敗、権限差、確定時競合、コマンド公開範囲、DB機能不足を重点的に確認しました。9つの境界条件をコードとテストの両方で閉じています。");

// 10 — verification
makeSlide(10, "実装と監査を分離し、372件の回帰テストで確認", [
  box("metric-1", 48, 190, 352, 238, C.panel),
  tx("metric-1-num", "372", 76, 224, 294, 94, 64, { color: C.accent, bold: true, valign: "middle" }),
  tx("metric-1-label", "FULL SUITE", 78, 322, 294, 26, 14, { color: C.accent, bold: true }),
  tx("metric-1-body", "全テスト合格", 78, 360, 260, 32, 21, { bold: true }),

  box("metric-2", 432, 190, 352, 238, C.panel),
  tx("metric-2-num", "173", 460, 224, 294, 94, 64, { color: C.ink, bold: true, valign: "middle" }),
  tx("metric-2-label", "RELATED TESTS", 462, 322, 294, 26, 14, { color: C.muted, bold: true }),
  tx("metric-2-body", "今回の関連テスト合格", 462, 360, 270, 32, 21, { bold: true }),

  box("metric-3", 816, 190, 364, 238, C.panel),
  tx("metric-3-num", "PASS", 844, 234, 308, 74, 50, { color: C.good, bold: true, valign: "middle" }),
  tx("metric-3-label", "STATIC CHECKS", 846, 322, 294, 26, 14, { color: C.muted, bold: true }),
  tx("metric-3-body", "lint / diff --check", 846, 360, 280, 32, 21, { bold: true }),

  rule("verify-loop", 91, 520, 1062, 0.2, C.ink, 2),
  ...[
    { x: 88, t: "5.6-luna max", b: "実装・修正" },
    { x: 344, t: "Primary audit", b: "独立レビュー" },
    { x: 600, t: "Reproduce", b: "欠陥を再現" },
    { x: 856, t: "Re-run", b: "全suiteで固定" },
  ].flatMap((s, i) => [
    dot(`verify-dot-${i}`, s.x, 511, 18, i === 3 ? C.good : C.accent),
    tx(`verify-title-${i}`, s.t, s.x - 8, 458, 210, 30, 18, { bold: true }),
    tx(`verify-body-${i}`, s.b, s.x - 8, 544, 210, 24, 15, { color: C.muted }),
  ]),
], "実装・修正は5.6-luna maxが担当し、監督役が受入条件の定義、独立レビュー、欠陥再現、再検証を行いました。関連173件、全372件、lint、diffチェックまで通過しています。");

// 11 — handoff
makeSlide(11, "コードレベルのリリースゲートは通過した", [
  box("handoff-pass-bg", 48, 188, 1132, 92, C.accent),
  tx("handoff-pass", "CODE-LEVEL GATE  /  PASSED", 76, 205, 820, 48, 33, { color: "#FFFFFF", bold: true, valign: "middle" }),
  tx("handoff-pass-sub", "重大な未解決欠陥は、最終レビューでは検出されていない。", 880, 214, 272, 40, 15, { color: "#E1E4FF", align: "right", valign: "middle" }),

  tx("handoff-next-title", "次の一手：staging smoke", 48, 322, 520, 38, 28, { bold: true }),
  tx("handoff-next-sub", "実Discord + replica set MongoDBで以下を確認", 48, 366, 580, 28, 17, { color: C.muted }),

  ...[
    "/checkbotの登録・ManageGuild・DM非表示",
    "30分観測、candidate作成、allowlist repair",
    "意図的な権限不足とAPI unknown時のBLOCK",
    "/setup確定直前の削除・型変更検出",
    "/config rollback・apply_status・retry",
  ].flatMap((item, i) => [
    box(`handoff-check-${i}`, 52, 414 + i * 39, 18, 18, C.canvas, { lineFill: C.ink, lineWidth: 1 }),
    tx(`handoff-item-${i}`, item, 86, 407 + i * 39, 560, 30, 17, { bold: i === 0, valign: "middle" }),
  ]),

  rule("handoff-divider", 690, 322, 0.2, 266, C.rule, 1),
  tx("handoff-limit-label", "RESIDUAL LIMITATION", 734, 326, 330, 24, 13, { color: C.bad, bold: true }),
  tx("handoff-limit", "実Discord / MongoDB stagingでの\n統合スモークは未実施", 734, 366, 410, 80, 28, { bold: true, line: 108000 }),
  tx("handoff-limit-body", "コード・単体/回帰テスト・静的検査は完了。\n本番投入前に外部境界だけを実環境で確認する。", 734, 466, 410, 84, 18, { color: C.muted, line: 116000 }),
  tx("handoff-decision", "READY FOR STAGING", 734, 566, 410, 28, 16, { color: C.accent, bold: true, align: "right" }),
], "この時点でコードレベルのゲートは通過しています。残る不確実性は、実DiscordとMongoDB replica setを接続した統合スモークです。ここを通過すれば本番リリース判断に進めます。");

const pptx = await PresentationFile.exportPptx(deck);
await pptx.save(FINAL_PPTX);

const inspection = await deck.inspect({
  kind: "slide,textbox,shape,notes",
  maxChars: 50000,
});
await fs.writeFile(
  path.join(TMP_DIR, "qa", "inspect.json"),
  JSON.stringify(inspection, null, 2),
  "utf8",
);

console.log(`Saved ${FINAL_PPTX}`);
console.log("Slides: 11");
