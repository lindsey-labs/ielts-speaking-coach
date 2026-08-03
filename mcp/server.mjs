import { createReadStream, promises as fs } from "node:fs";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(__dirname, "..");
const dataRoot = process.env.IELTS_SPEAKING_DATA_DIR
  ? path.resolve(process.env.IELTS_SPEAKING_DATA_DIR)
  : path.join(
      process.env.LOCALAPPDATA || path.join(os.homedir(), ".local", "share"),
      "IELTS Speaking Coach",
    );

const statePath = path.join(dataRoot, "state.json");
const reportsDir = path.join(dataRoot, "reports");
const recordingsDir = path.join(dataRoot, "recordings");
const dashboardPath = path.join(pluginRoot, "demo", "dashboard.html");
const bundledQuestionBankPaths = process.env.IELTS_SPEAKING_SAMPLE_BANK_ONLY === "1"
  ? [path.join(__dirname, "question-bank.sample.json")]
  : [
      path.join(__dirname, "question-bank-2026-may-aug.json"),
      path.join(__dirname, "question-bank.sample.json"),
    ];
const upgradePageConfigPath = path.join(__dirname, "upgrade-page.json");
const dashboardHost = "127.0.0.1";
const dashboardPort = Number(process.env.IELTS_SPEAKING_DASHBOARD_PORT || 43127);
const dashboardUrl = `http://${dashboardHost}:${dashboardPort}`;

async function readUpgradePageConfig() {
  const config = JSON.parse(await fs.readFile(upgradePageConfigPath, "utf8"));
  const websiteUrl = String(config.websiteUrl || "").trim();
  if (websiteUrl && !/^https:\/\//i.test(websiteUrl)) {
    throw new Error("升级页面地址必须使用 HTTPS");
  }
  return { websiteUrl };
}

const emptyState = () => ({
  schemaVersion: 3,
  learner: {
    displayName: "",
    createdAt: new Date().toISOString(),
  },
  currentSession: null,
  sessions: [],
  targets: [],
  issues: [],
  vocabulary: [],
  plan: null,
  questions: [],
  questionSources: [],
  settings: {
    recordingEnabled: false,
    recordingConsentAt: "",
  },
  questionCursor: {
    part1: 0,
    part2: 0,
    part3: 0,
  },
});

async function ensureWorkspace(displayName = "") {
  await fs.mkdir(reportsDir, { recursive: true });
  await fs.mkdir(recordingsDir, { recursive: true });
  try {
    await fs.access(statePath);
  } catch {
    const state = emptyState();
    state.learner.displayName = displayName;
    await writeJsonAtomic(statePath, state);
  }
  const state = await readState();
  let changed = false;
  if (!state.learner || typeof state.learner !== "object") {
    state.learner = { displayName: "", createdAt: new Date().toISOString() };
    changed = true;
  }
  if (typeof state.learner.displayName !== "string") {
    state.learner.displayName = "";
    changed = true;
  }
  if (!Array.isArray(state.questions)) {
    state.questions = [];
    changed = true;
  }
  if (!Array.isArray(state.questionSources)) {
    state.questionSources = [];
    changed = true;
  }
  if (!state.settings || typeof state.settings !== "object") {
    state.settings = { recordingEnabled: false, recordingConsentAt: "" };
    changed = true;
  }
  if (typeof state.settings.recordingEnabled !== "boolean") {
    state.settings.recordingEnabled = false;
    changed = true;
  }
  if (!state.schemaVersion || state.schemaVersion < 2) {
    state.schemaVersion = 3;
    changed = true;
  }
  if (!Array.isArray(state.issues)) {
    state.issues = [];
    changed = true;
  }
  if (!Array.isArray(state.vocabulary)) {
    state.vocabulary = [];
    changed = true;
  }
  if (!("plan" in state)) {
    state.plan = null;
    changed = true;
  }
  if (state.schemaVersion < 3) {
    state.schemaVersion = 3;
    changed = true;
  }
  let bundled;
  for (const candidate of bundledQuestionBankPaths) {
    try {
      bundled = JSON.parse(await fs.readFile(candidate, "utf8"));
      break;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  if (!bundled) throw new Error("No bundled or sample question bank is available.");
  const bundledSource = state.questionSources.find((source) => source.title === bundled.title);
  const shouldRefreshBundledBank = state.questions.length === 0
    || bundledSource?.importLevel !== bundled.importLevel
    || state.questions.some((question) => question.source === bundled.title && question.importLevel !== bundled.importLevel)
    || state.questions.some((question) => question.source === bundled.title && question.part === "Part 2" && String(question.prompt || "").startsWith("「"));
  if (shouldRefreshBundledBank) {
    const previousById = new Map(state.questions.map((question) => [question.id, question]));
    const expanded = expandBundledQuestionBank(bundled).map((question) => ({
      ...question,
      status: previousById.get(question.id)?.status || question.status,
    }));
    const externalQuestions = state.questions.filter((question) => question.source !== bundled.title);
    state.questions = [...expanded, ...externalQuestions];
    const sourceRecord = {
      title: bundled.title,
      sourceUrl: bundled.sourceUrl,
      importedAt: bundled.importedAt,
      importLevel: bundled.importLevel,
      questionCount: expanded.length,
    };
    state.questionSources = [sourceRecord, ...state.questionSources.filter((source) => source.title !== bundled.title)];
    changed = true;
  }
  if (state.plan && Number(state.plan.planVersion || 1) < 2 && state.questions.length) {
    state.plan = buildPracticePlan(state, {
      lengthDays: state.plan.lengthDays,
      weeklyTarget: state.plan.weeklyTarget,
      focus: state.plan.focus,
    }, state.plan.startDate);
    changed = true;
  }
  if (changed) await writeJsonAtomic(statePath, state);
  return state;
}

async function readState() {
  try {
    return JSON.parse(await fs.readFile(statePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") {
      return ensureWorkspace();
    }
    throw error;
  }
}

async function writeJsonAtomic(filePath, value) {
  const tempPath = `${filePath}.tmp`;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(tempPath, filePath);
}

function sessionId() {
  const date = new Date().toISOString().slice(0, 10);
  const suffix = Math.random().toString(36).slice(2, 7);
  return `${date}-${suffix}`;
}

function textResult(message, structuredContent = {}) {
  return {
    structuredContent,
    content: [{ type: "text", text: message }],
  };
}

function slug(value) {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 56);
}

function topicMeta(raw) {
  const match = raw.match(/^「([^」]+)」\s*(.+)$/);
  return {
    label: match?.[1] || "",
    topic: match?.[2] || raw,
  };
}

function expandBundledQuestionBank(bank) {
  const source = bank.title || "Imported question bank";
  const sourceUrl = bank.sourceUrl || "";
  const questions = [];
  for (const [index, entry] of (bank.part1 || []).entries()) {
    const raw = typeof entry === "string" ? entry : String(entry.raw || entry.topic || "");
    const meta = topicMeta(raw);
    const concreteQuestions = asArray(entry?.questions).map((item) => String(item).trim()).filter(Boolean);
    questions.push({
      id: `p1-${String(index + 1).padStart(3, "0")}-${slug(meta.topic)}`,
      part: "Part 1",
      topic: meta.topic,
      prompt: concreteQuestions[0] || raw,
      followups: concreteQuestions.slice(1),
      label: meta.label,
      source,
      sourceUrl,
      status: "new",
      importLevel: concreteQuestions.length ? "full-question" : (bank.importLevel || "topic-outline"),
    });
  }
  for (const [index, entry] of (bank.part23 || []).entries()) {
    const raw = typeof entry === "string" ? entry : String(entry.raw || entry.topic || "");
    const meta = topicMeta(raw);
    const part2Value = entry?.part2Questions || entry?.part2Question;
    const part2Questions = (Array.isArray(part2Value) ? part2Value : [part2Value])
      .map((item) => String(item || "").trim())
      .filter(Boolean);
    const part3Questions = asArray(entry?.part3Questions).map((item) => String(item).trim()).filter(Boolean);
    for (const [part, concreteQuestions] of [["Part 2", part2Questions], ["Part 3", part3Questions]]) {
      questions.push({
        id: `${part === "Part 2" ? "p2" : "p3"}-${String(index + 1).padStart(3, "0")}-${slug(meta.topic)}`,
        part,
        topic: meta.topic,
        prompt: concreteQuestions[0] || raw,
        followups: concreteQuestions.slice(1),
        label: meta.label,
        source,
        sourceUrl,
        status: "new",
        importLevel: concreteQuestions.length ? "full-question" : (bank.importLevel || "topic-outline"),
        note: part === "Part 3" ? "Part 2&3关联讨论主题" : "",
      });
    }
  }
  return questions;
}

function normalizeImportedQuestion(question, index, sourceName, sourceUrl) {
  const partValue = String(question.part || "").replace(/^([123])$/, "Part $1");
  if (!["Part 1", "Part 2", "Part 3"].includes(partValue)) {
    throw new Error(`第 ${index + 1} 道题的 Part 无效。`);
  }
  const suppliedQuestions = asArray(question.questions).map((item) => String(item).trim()).filter(Boolean);
  const prompt = String(question.prompt || question.question || suppliedQuestions[0] || "").trim();
  if (!prompt) throw new Error(`第 ${index + 1} 道题缺少题目内容。`);
  const topic = String(question.topic || prompt).trim();
  const followups = suppliedQuestions.length > 1
    ? suppliedQuestions.slice(1)
    : asArray(question.followups).map((item) => String(item).trim()).filter(Boolean);
  return {
    id: String(question.id || `${partValue.replace("Part ", "p")}-${Date.now()}-${index + 1}-${slug(topic)}`).slice(0, 120),
    part: partValue,
    topic: topic.slice(0, 300),
    prompt: prompt.slice(0, 1200),
    followups: followups.map((item) => item.slice(0, 500)).slice(0, 20),
    label: String(question.label || "").slice(0, 80),
    source: sourceName.slice(0, 200),
    sourceUrl: sourceUrl.slice(0, 1000),
    status: "new",
    importLevel: "full-question",
  };
}

function newestCompletedSession(state) {
  return state.sessions.find((session) => session.status === "completed") || null;
}

async function saveTrainingSelection({
  route,
  part,
  length = "standard",
  questionId = "",
  questionIds = [],
  planItemId = "",
  selectedReference = "",
  singleGoal = "",
}) {
  const state = await ensureWorkspace();
  const latest = newestCompletedSession(state);
  const planItem = planItemId
    ? state.plan?.items?.find((item) => item.id === planItemId)
    : null;
  if (planItemId && !planItem) throw new Error("找不到这一天的计划任务，请刷新计划后重试。");
  const selectedQuestion = questionId
    ? state.questions.find((question) => question.id === questionId)
    : null;
  if (route === "choose_question" && !selectedQuestion && !planItem) {
    throw new Error("请先从题库中选择一道题。");
  }
  const requestedQuestionIds = [...new Set(asArray(questionIds).map((item) => String(item)).filter(Boolean))];
  const completedQuestionIds = new Set(asArray(planItem?.completedQuestionIds));
  const availablePlanQuestionIds = asArray(planItem?.questionIds).filter((id) => !completedQuestionIds.has(id));
  const selectedPlanQuestionIds = planItem
    ? (requestedQuestionIds.length ? requestedQuestionIds : availablePlanQuestionIds)
    : [];
  if (planItem && !selectedPlanQuestionIds.length) throw new Error("请至少选择一道尚未完成的计划题目。");
  if (planItem && selectedPlanQuestionIds.some((id) => !availablePlanQuestionIds.includes(id))) {
    throw new Error("所选题目不属于今天尚未完成的计划，请刷新后重试。");
  }
  const plannedQuestions = Array.isArray(planItem?.questions)
    ? planItem.questions.filter((item) => selectedPlanQuestionIds.includes(item.id))
    : [];
  const plannedParts = [...new Set(plannedQuestions.map((item) => item.part))];
  const plannedReference = plannedQuestions.length
    ? plannedQuestions.map((item, index) => `${index + 1}. [${item.part}] ${item.selectedReference}`).join("\n")
    : "";
  const session = {
    id: sessionId(),
    route,
    part: planItem ? (plannedParts.length === 1 ? plannedParts[0] : "Full mock") : part,
    length,
    questionId: selectedPlanQuestionIds[0] || selectedQuestion?.id || "",
    questionIds: selectedPlanQuestionIds.length ? selectedPlanQuestionIds : (selectedQuestion ? [selectedQuestion.id] : []),
    planItemId: planItem?.id || "",
    selectedReference:
      plannedReference ||
      selectedQuestion?.prompt ||
      selectedReference ||
      (route === "continue_last_question" && latest
        ? latest.selectedReference || latest.part
        : ""),
    singleGoal: singleGoal || (plannedQuestions.length ? `完成今日计划的${plannedQuestions.length}个题目` : ""),
    status: "planned",
    startedAt: new Date().toISOString(),
  };

  state.currentSession = session;
  state.sessions.unshift(session);
  await writeJsonAtomic(statePath, state);
  return session;
}

function sendJson(response, statusCode, value) {
  const body = `${JSON.stringify(value)}\n`;
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  response.end(body);
}

function normalizeTranscript(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => ({
      sourceMessageId: String(item?.sourceMessageId || "").slice(0, 300),
      role: item?.role === "assistant" ? "assistant" : "user",
      text: String(item?.text || "").trim().slice(0, 20_000),
      status: item?.status === "streaming" ? "streaming" : "complete",
      capturedAt: String(item?.capturedAt || new Date().toISOString()),
    }))
    .filter((item) => item.text)
    .slice(-200);
}

function hasSubstantiveLearnerAnswer(transcript) {
  return asArray(transcript).some((turn) => {
    if (turn?.role !== "user") return false;
    const text = String(turn.text || "").trim();
    if (!text || text.startsWith("你现在是雅思口语考官。请直接开始一次")) return false;
    if (/SYNC_REQUEST_ID:|<<<IELTS_REVIEW_JSON:/i.test(text)) return false;
    return !/^(结束训练|end (the )?(training|practice))\W*$/i.test(text);
  });
}

async function checkpointDesktopSession({ sessionId: requestedId, transcript, chatUrl = "" }) {
  const state = await ensureWorkspace();
  const activeId = requestedId || state.currentSession?.id;
  if (!activeId) throw new Error("没有可以写入的训练记录。");
  const index = state.sessions.findIndex((item) => item.id === activeId);
  if (index < 0) throw new Error("找不到对应的训练记录。");
  const normalizedTranscript = normalizeTranscript(transcript);
  const existing = state.sessions[index];
  const checkpointed = {
    ...existing,
    status: existing.status === "completed" ? "completed" : "active",
    transcript: normalizedTranscript,
    transcriptUpdatedAt: new Date().toISOString(),
    chatUrl: String(chatUrl || existing.chatUrl || "").slice(0, 2_000),
  };
  state.sessions[index] = checkpointed;
  state.currentSession = checkpointed;
  await writeJsonAtomic(statePath, state);
  return { sessionId: activeId, transcriptCount: normalizedTranscript.length, transcriptUpdatedAt: checkpointed.transcriptUpdatedAt, chatUrl: checkpointed.chatUrl };
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function reportMarkdown(session, transcript, report) {
  const section = (title, items) => {
    const normalized = asArray(items);
    return `## ${title}\n\n${normalized.length ? normalized.map((item) => {
      if (typeof item === "string") return `- ${item}`;
      const original = item.original ? `原表达：${item.original}` : "";
      const improved = item.improved ? `建议：${item.improved}` : "";
      const reason = item.reason ? `原因：${item.reason}` : "";
      return `- ${[original, improved, reason].filter(Boolean).join("｜")}`;
    }).join("\n") : "- 本次未发现需要记录的项目。"}`;
  };
  const answerUpgrades = asArray(report.answer_upgrades);
  const answerUpgradeSection = answerUpgrades.length
    ? answerUpgrades.map((item, index) => `### 问题 ${index + 1}${item.question ? `：${item.question}` : ""}\n\n**我的原回答**\n\n${item.original_answer || "未记录"}\n\n**高分建议答案**\n\n${item.revised_answer || "未生成"}\n\n${asArray(item.changes).length ? `**主要修改**\n\n${asArray(item.changes).map((change) => `- ${change}`).join("\n")}` : ""}`).join("\n\n")
    : "这是一份旧版复盘，当时尚未生成完整回答改写。";
  const dialogue = transcript.map((turn) => `**${turn.role === "assistant" ? "Examiner" : "Learner"}**：${turn.text}`).join("\n\n");
  return `# IELTS Speaking 训练复盘\n\n- Session ID：${session.id}\n- Part：${session.part}\n- 题目：${session.selectedReference || "未记录"}\n- 完成时间：${new Date().toISOString()}\n\n## 总结\n\n${report.summary || "已完成本次训练。"}\n\n${section("必须纠正的表达", report.must_correct)}\n\n${section("更自然的表达", report.natural_upgrades)}\n\n${section("重复词和口头习惯", report.repeated_habits)}\n\n${section("逻辑与展开", report.logic_feedback)}\n\n${section("可升级词汇", report.vocabulary_upgrades)}\n\n## 回答建议\n\n${answerUpgradeSection}\n\n## 下一次可选复训目标\n\n${report.priority_target?.description || report.next_target || "本次不强制安排复训。"}\n\n## 完整对话\n\n${dialogue || "未捕获到对话文字。"}\n`;
}

function updateLearningIndexes(state, sessionIdValue, report) {
  const now = new Date().toISOString();
  const issueGroups = [
    ["must-correct", report.must_correct],
    ["naturalness", report.natural_upgrades],
    ["habit", report.repeated_habits],
    ["logic", report.logic_feedback],
  ];
  for (const [category, items] of issueGroups) {
    for (const item of asArray(items)) {
      const label = typeof item === "string" ? item : item.original || item.issue || item.reason || item.improved;
      if (!label) continue;
      const key = `${category}:${String(label).toLowerCase().slice(0, 160)}`;
      const existing = state.issues.find((entry) => entry.key === key);
      if (existing) {
        existing.count += 1;
        existing.lastSeenAt = now;
        if (!existing.sessionIds.includes(sessionIdValue)) existing.sessionIds.push(sessionIdValue);
      } else {
        state.issues.unshift({ key, category, label: String(label), count: 1, status: "new", firstSeenAt: now, lastSeenAt: now, sessionIds: [sessionIdValue] });
      }
    }
  }
  for (const item of asArray(report.vocabulary_upgrades)) {
    const term = typeof item === "string" ? item : item.improved || item.term || item.word;
    if (!term) continue;
    const key = String(term).toLowerCase().trim();
    const existing = state.vocabulary.find((entry) => entry.key === key);
    if (existing) {
      existing.count += 1;
      existing.lastSeenAt = now;
      if (!existing.sessionIds.includes(sessionIdValue)) existing.sessionIds.push(sessionIdValue);
    } else {
      state.vocabulary.unshift({ key, term: String(term), meaning: typeof item === "object" ? String(item.reason || item.meaning || "") : "", count: 1, familiarity: "new", nextReviewAt: now, firstSeenAt: now, lastSeenAt: now, sessionIds: [sessionIdValue] });
    }
  }
}

function markPlanItemCompleted(state, completed) {
  if (!state.plan || !Array.isArray(state.plan.items)) return;
  const matchingItem = state.plan.items.find((item) => item.status === "planned" && (
    (completed.planItemId && item.id === completed.planItemId) ||
    (completed.questionId && !Array.isArray(item.questionIds) && item.questionId === completed.questionId) ||
    (completed.selectedReference && item.selectedReference === completed.selectedReference)
  ));
  if (!matchingItem) return;
  const allQuestionIds = asArray(matchingItem.questionIds);
  const completedIds = new Set(asArray(matchingItem.completedQuestionIds));
  const sessionQuestionIds = asArray(completed.questionIds).length
    ? asArray(completed.questionIds)
    : (completed.questionId ? [completed.questionId] : allQuestionIds);
  sessionQuestionIds.filter((id) => allQuestionIds.includes(id)).forEach((id) => completedIds.add(id));
  matchingItem.completedQuestionIds = [...completedIds];
  matchingItem.completedQuestionCount = completedIds.size;
  matchingItem.lastCompletedAt = completed.completedAt;
  matchingItem.sessionIds = [...new Set([...asArray(matchingItem.sessionIds), completed.id])];
  if (allQuestionIds.length && completedIds.size >= allQuestionIds.length) {
    matchingItem.status = "completed";
    matchingItem.completedAt = completed.completedAt;
  } else {
    matchingItem.status = "planned";
  }
}

async function completeDesktopSession({ sessionId: requestedId, transcript, report, rawReport = "" }) {
  const state = await ensureWorkspace();
  const activeId = requestedId || state.currentSession?.id;
  if (!activeId) throw new Error("没有可以完成的训练记录。");
  const index = state.sessions.findIndex((item) => item.id === activeId);
  if (index < 0) throw new Error("找不到对应的训练记录。");
  const existing = state.sessions[index];
  const normalizedTranscript = normalizeTranscript(
    Array.isArray(transcript) && transcript.length ? transcript : existing.transcript,
  );
  const inputReport = report && typeof report === "object" ? report : {};
  const normalizedReport = {
    ...inputReport,
    answer_upgrades: normalizeAnswerUpgrades(inputReport.answer_upgrades),
  };
  if (hasSubstantiveLearnerAnswer(normalizedTranscript) && !normalizedReport.answer_upgrades.length) {
    throw new Error("复盘缺少完整的回答建议，已阻止保存并将自动重试。");
  }
  const safeReport = {
    ...normalizedReport,
    priority_target: derivePriorityTarget(normalizedReport, activeId),
  };
  const markdownPath = path.join(reportsDir, `${activeId}.md`);
  const jsonPath = path.join(reportsDir, `${activeId}.json`);
  if (
    existing.status === "completed" &&
    JSON.stringify(existing.report || {}) === JSON.stringify(safeReport)
  ) {
    return { session: existing, markdownPath, jsonPath, alreadySaved: true };
  }
  const markdown = reportMarkdown(existing, normalizedTranscript, safeReport);
  await fs.writeFile(markdownPath, markdown, "utf8");
  await writeJsonAtomic(jsonPath, { ...safeReport, transcript: normalizedTranscript, rawReport });
  const completed = {
    ...existing,
    status: "completed",
    completedAt: new Date().toISOString(),
    transcript: normalizedTranscript,
    report: safeReport,
    priorityTarget: safeReport.priority_target || null,
    markdownPath,
    jsonPath,
  };
  state.sessions.splice(index, 1);
  state.sessions.unshift(completed);
  state.currentSession = completed;
  markPlanItemCompleted(state, completed);
  updateLearningIndexes(state, activeId, safeReport);
  if (safeReport.priority_target?.id) {
    const target = { ...safeReport.priority_target, sourceSessionId: activeId, status: safeReport.priority_target.status || "new", savedAt: new Date().toISOString() };
    state.targets = [target, ...state.targets.filter((item) => item.id !== target.id)];
  }
  await writeJsonAtomic(statePath, state);
  return { session: completed, markdownPath, jsonPath };
}

function normalizeAnswerUpgrades(value) {
  const items = Array.isArray(value) ? value : (value && typeof value === "object" ? [value] : []);
  return items.map((item) => ({
    question: String(item?.question || "").trim().slice(0, 2000),
    original_answer: String(item?.original_answer || "").trim().slice(0, 20_000),
    revised_answer: String(item?.revised_answer || "").trim().slice(0, 20_000),
    changes: asArray(item?.changes).map((change) => String(change).trim().slice(0, 1000)).filter(Boolean).slice(0, 20),
  })).filter((item) => item.original_answer && item.revised_answer).slice(0, 50);
}

function derivePriorityTarget(report, sourceSessionId = "") {
  const existing = report?.priority_target;
  if (existing && typeof existing === "object" && String(existing.description || existing.label || "").trim()) {
    return {
      ...existing,
      id: String(existing.id || `target-${sourceSessionId}`).trim(),
      description: String(existing.description || existing.label).trim(),
      status: existing.status || "new",
    };
  }
  const candidates = [
    ["logic", asArray(report?.logic_feedback)[0]],
    ["habit", asArray(report?.repeated_habits)[0]],
    ["natural", asArray(report?.natural_upgrades)[0]],
    ["grammar", asArray(report?.must_correct)[0]],
  ];
  for (const [category, item] of candidates) {
    if (!item || typeof item !== "object") continue;
    const description = String(item.improved || item.reason || item.original || "").trim();
    if (!description) continue;
    return {
      id: `auto-${category}-${sourceSessionId || "latest"}`,
      description,
      status: "new",
      evidence: [String(item.original || "").trim()].filter(Boolean),
      reason: String(item.reason || "").trim(),
    };
  }
  const fallback = String(report?.next_target || "").trim();
  return fallback ? { id: `auto-next-${sourceSessionId || "latest"}`, description: fallback, status: "new" } : null;
}

async function saveSessionAnswerUpgrades({ sessionId: requestedId, answerUpgrades }) {
  const state = await ensureWorkspace();
  const index = state.sessions.findIndex((item) => item.id === requestedId && item.status === "completed");
  if (index < 0) throw new Error("找不到对应的已完成复盘。");
  const normalized = normalizeAnswerUpgrades(answerUpgrades);
  if (!normalized.length) throw new Error("回答建议不能为空。");
  const existing = state.sessions[index];
  const reportWithAnswers = { ...(existing.report || {}), answer_upgrades: normalized };
  const report = { ...reportWithAnswers, priority_target: derivePriorityTarget(reportWithAnswers, requestedId) };
  const updated = { ...existing, report, priorityTarget: report.priority_target || null };
  const markdownPath = existing.markdownPath || path.join(reportsDir, `${requestedId}.md`);
  const jsonPath = existing.jsonPath || path.join(reportsDir, `${requestedId}.json`);
  let rawReport = "";
  try {
    rawReport = String(JSON.parse(await fs.readFile(jsonPath, "utf8")).rawReport || "");
  } catch {}
  await fs.writeFile(markdownPath, reportMarkdown(updated, asArray(updated.transcript), report), "utf8");
  await writeJsonAtomic(jsonPath, { ...report, transcript: asArray(updated.transcript), rawReport });
  state.sessions[index] = updated;
  if (report.priority_target?.id) {
    const target = { ...report.priority_target, sourceSessionId: requestedId, savedAt: new Date().toISOString() };
    state.targets = [target, ...state.targets.filter((item) => item.id !== target.id)];
  }
  if (state.currentSession?.id === requestedId) state.currentSession = updated;
  await writeJsonAtomic(statePath, state);
  return { session: updated, markdownPath, jsonPath, answerUpgradeCount: normalized.length };
}

async function saveRecordingSettings({ enabled }) {
  const state = await ensureWorkspace();
  state.settings.recordingEnabled = Boolean(enabled);
  state.settings.recordingConsentAt = enabled ? new Date().toISOString() : "";
  await writeJsonAtomic(statePath, state);
  return { ...state.settings };
}

function safeRecordingPath(filePath) {
  const resolved = path.resolve(String(filePath || ""));
  const root = path.resolve(recordingsDir);
  if (!resolved.startsWith(`${root}${path.sep}`)) throw new Error("录音文件路径无效。");
  return resolved;
}

async function saveSessionRecording({ sessionId: requestedId, filePath, mimeType, size, durationMs = 0 }) {
  const state = await ensureWorkspace();
  const index = state.sessions.findIndex((item) => item.id === requestedId);
  if (index < 0) throw new Error("找不到对应的训练记录。");
  const resolved = safeRecordingPath(filePath);
  const stat = await fs.stat(resolved);
  const recording = {
    filePath: resolved,
    mimeType: String(mimeType || "audio/webm").slice(0, 120),
    size: Number(size) || stat.size,
    durationMs: Math.max(0, Number(durationMs) || 0),
    savedAt: new Date().toISOString(),
  };
  state.sessions[index] = { ...state.sessions[index], recording };
  if (state.currentSession?.id === requestedId) state.currentSession = state.sessions[index];
  await writeJsonAtomic(statePath, state);
  return { sessionId: requestedId, recording };
}

async function deleteSessionRecording({ sessionId: requestedId }) {
  const state = await ensureWorkspace();
  const index = state.sessions.findIndex((item) => item.id === requestedId);
  if (index < 0) throw new Error("找不到对应的训练记录。");
  const recording = state.sessions[index].recording;
  if (recording?.filePath) {
    const resolved = safeRecordingPath(recording.filePath);
    await fs.unlink(resolved).catch((error) => { if (error?.code !== "ENOENT") throw error; });
  }
  const updated = { ...state.sessions[index] };
  delete updated.recording;
  state.sessions[index] = updated;
  if (state.currentSession?.id === requestedId) state.currentSession = updated;
  await writeJsonAtomic(statePath, state);
  return { sessionId: requestedId, deleted: true };
}

async function serveSessionRecording(request, response, sessionIdValue) {
  const state = await ensureWorkspace();
  const session = state.sessions.find((item) => item.id === sessionIdValue);
  if (!session?.recording?.filePath) {
    sendJson(response, 404, { error: "这次训练没有保存录音。" });
    return;
  }
  const filePath = safeRecordingPath(session.recording.filePath);
  const stat = await fs.stat(filePath);
  const range = request.headers.range;
  const headers = {
    "Content-Type": session.recording.mimeType || "audio/webm",
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, no-store",
  };
  if (!range) {
    response.writeHead(200, { ...headers, "Content-Length": stat.size });
    createReadStream(filePath).pipe(response);
    return;
  }
  const match = range.match(/bytes=(\d*)-(\d*)/);
  const start = match?.[1] ? Number(match[1]) : 0;
  const end = match?.[2] ? Math.min(Number(match[2]), stat.size - 1) : stat.size - 1;
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= stat.size) {
    response.writeHead(416, { "Content-Range": `bytes */${stat.size}` });
    response.end();
    return;
  }
  response.writeHead(206, { ...headers, "Content-Length": end - start + 1, "Content-Range": `bytes ${start}-${end}/${stat.size}` });
  createReadStream(filePath, { start, end }).pipe(response);
}

async function readRequestJson(request) {
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > 5 * 1024 * 1024) {
      throw new Error("请求内容过大。");
    }
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

function validateDisplayName(value) {
  const displayName = String(value?.displayName || "").normalize("NFKC").trim();
  if (!displayName) throw new Error("用户名不能为空。");
  if ([...displayName].length > 30) throw new Error("用户名最多可输入30个字符。");
  if (/\p{Control}/u.test(displayName)) throw new Error("用户名包含不支持的字符。");
  return displayName;
}

async function saveLearnerProfile(value) {
  const displayName = validateDisplayName(value);
  const state = await ensureWorkspace();
  state.learner.displayName = displayName;
  state.learner.updatedAt = new Date().toISOString();
  await writeJsonAtomic(statePath, state);
  return state.learner;
}

function validateDashboardSelection(value) {
  const allowedRoutes = new Set([
    "continue_last_question",
    "next_question",
    "retrain_previous_session",
    "choose_history",
    "choose_question",
    "repeat_report_question",
  ]);
  const allowedParts = new Set(["Part 1", "Part 2", "Part 3", "Full mock"]);
  const allowedLengths = new Set(["quick", "standard", "full"]);
  if (!allowedRoutes.has(value.route)) throw new Error("训练路线无效。");
  if (!allowedParts.has(value.part)) throw new Error("训练 Part 无效。");
  if (!allowedLengths.has(value.length)) throw new Error("训练时长无效。");
  return {
    route: value.route,
    part: value.part,
    length: value.length,
    questionId: String(value.questionId || "").slice(0, 120),
    questionIds: asArray(value.questionIds).map((item) => String(item).slice(0, 120)).filter(Boolean).slice(0, 50),
    planItemId: String(value.planItemId || "").slice(0, 120),
    selectedReference: String(value.selectedReference || "").slice(0, 300),
    singleGoal: String(value.singleGoal || "").slice(0, 300),
  };
}

function validatePlanSettings(value) {
  const lengthDays = Number(value.lengthDays);
  const weeklyTarget = Number(value.weeklyTarget);
  const focus = String(value.focus || "balanced");
  if (![7, 14, 30].includes(lengthDays)) throw new Error("计划周期必须是7天、14天或30天。");
  if (![3, 5, 7].includes(weeklyTarget)) throw new Error("每周训练次数必须是3次、5次或7次。");
  if (!["balanced", "Part 1", "Part 2", "Part 3"].includes(focus)) throw new Error("训练重点无效。");
  return { lengthDays, weeklyTarget, focus };
}

function localDateKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

async function createPracticePlan(settings) {
  const state = await ensureWorkspace();
  state.plan = buildPracticePlan(state, settings);
  await writeJsonAtomic(statePath, state);
  return state.plan;
}

function buildPracticePlan(state, settings, existingStartDate = "") {
  const parts = settings.focus === "balanced" ? ["Part 1", "Part 2", "Part 3"] : [settings.focus];
  const questionsByPart = Object.fromEntries(parts.map((part) => [part, state.questions.filter((question) => question.part === part)]));
  const orderedQuestions = [];
  if (settings.focus === "balanced") {
    const maxPartLength = Math.max(...parts.map((part) => questionsByPart[part].length), 0);
    for (let index = 0; index < maxPartLength; index += 1) {
      for (const part of parts) {
        if (questionsByPart[part][index]) orderedQuestions.push(questionsByPart[part][index]);
      }
    }
  } else {
    orderedQuestions.push(...questionsByPart[settings.focus]);
  }
  const start = existingStartDate ? new Date(existingStartDate) : new Date();
  start.setHours(0, 0, 0, 0);
  const scheduledDays = [];
  for (let dayOffset = 0; dayOffset < settings.lengthDays; dayOffset += 1) {
    if (dayOffset % 7 >= settings.weeklyTarget) continue;
    scheduledDays.push(dayOffset);
  }
  const activeDays = scheduledDays.slice(0, Math.min(scheduledDays.length, orderedQuestions.length));
  const baseBatchSize = activeDays.length ? Math.floor(orderedQuestions.length / activeDays.length) : 0;
  const extraQuestionDays = activeDays.length ? orderedQuestions.length % activeDays.length : 0;
  const items = [];
  let questionCursor = 0;
  activeDays.forEach((dayOffset, index) => {
    const batchSize = baseBatchSize + (index < extraQuestionDays ? 1 : 0);
    const batch = orderedQuestions.slice(questionCursor, questionCursor + batchSize);
    questionCursor += batchSize;
    const date = new Date(start);
    date.setDate(start.getDate() + dayOffset);
    const batchParts = [...new Set(batch.map((question) => question.part))];
    items.push({
      id: `plan-day-${dayOffset + 1}`,
      day: dayOffset + 1,
      date: localDateKey(date),
      part: batchParts.length === 1 ? batchParts[0] : "Full mock",
      questionId: batch[0]?.id || "",
      questionIds: batch.map((question) => question.id),
      questionCount: batch.length,
      questions: batch.map((question) => ({
        id: question.id,
        part: question.part,
        selectedReference: question.prompt || question.topic,
      })),
      selectedReference: batch[0]?.prompt || batch[0]?.topic || "",
      status: "planned",
      completedQuestionIds: [],
      completedQuestionCount: 0,
    });
  });
  return {
    id: `plan-${Date.now()}`,
    planVersion: 2,
    ...settings,
    startDate: start.toISOString(),
    createdAt: new Date().toISOString(),
    status: "active",
    questionCount: orderedQuestions.length,
    items,
  };
}

let dashboardServerPromise;
function ensureDashboardServer() {
  if (dashboardServerPromise) return dashboardServerPromise;
  dashboardServerPromise = new Promise((resolve, reject) => {
    const httpServer = createServer(async (request, response) => {
      try {
        const requestUrl = new URL(request.url || "/", dashboardUrl);
        if (request.method === "GET" && requestUrl.pathname === "/api/health") {
          sendJson(response, 200, { ok: true, service: "ielts-speaking-coach-local" });
          return;
        }
        if (request.method === "GET" && requestUrl.pathname === "/api/dashboard") {
          const state = await ensureWorkspace();
          sendJson(response, 200, {
            learner: state.learner,
            currentSession: state.currentSession,
            sessions: state.sessions,
            targets: state.targets,
            issues: state.issues,
            vocabulary: state.vocabulary,
            plan: state.plan,
            questions: state.questions,
            questionSources: state.questionSources,
            recordingEnabled: state.settings.recordingEnabled,
            dataRoot,
          });
          return;
        }
        if (request.method === "POST" && requestUrl.pathname === "/api/profile") {
          const learner = await saveLearnerProfile(await readRequestJson(request));
          sendJson(response, 200, { saved: true, learner });
          return;
        }
        if (request.method === "GET" && requestUrl.pathname === "/api/questions") {
          const state = await ensureWorkspace();
          const part = requestUrl.searchParams.get("part") || "";
          const search = (requestUrl.searchParams.get("search") || "").toLowerCase();
          const questions = state.questions.filter((question) => {
            if (part && question.part !== part) return false;
            if (
              search &&
              !`${question.topic} ${question.prompt} ${question.label}`
                .toLowerCase()
                .includes(search)
            ) return false;
            return true;
          });
          sendJson(response, 200, {
            questions,
            sources: state.questionSources,
            total: questions.length,
          });
          return;
        }
        if (
          request.method === "POST" &&
          requestUrl.pathname === "/api/questions/import"
        ) {
          const payload = await readRequestJson(request);
          if (!Array.isArray(payload.questions) || payload.questions.length === 0) {
            throw new Error("questions 必须是非空数组。");
          }
          const sourceName = String(payload.sourceName || "Imported question bank");
          const sourceUrl = String(payload.sourceUrl || "");
          const imported = payload.questions.map((question, index) =>
            normalizeImportedQuestion(question, index, sourceName, sourceUrl)
          );
          const state = await ensureWorkspace();
          const byId = new Map(state.questions.map((question) => [question.id, question]));
          imported.forEach((question) => byId.set(question.id, question));
          state.questions = [...byId.values()];
          state.questionSources.unshift({
            title: sourceName.slice(0, 200),
            sourceUrl: sourceUrl.slice(0, 1000),
            importedAt: new Date().toISOString(),
            importLevel: "full-question",
            questionCount: imported.length,
          });
          await writeJsonAtomic(statePath, state);
          sendJson(response, 201, { imported: imported.length, total: state.questions.length });
          return;
        }
        if (
          request.method === "POST" &&
          requestUrl.pathname === "/api/plan"
        ) {
          const settings = validatePlanSettings(await readRequestJson(request));
          const plan = await createPracticePlan(settings);
          sendJson(response, 201, { saved: true, plan });
          return;
        }
        if (
          request.method === "POST" &&
          requestUrl.pathname === "/api/training-selection"
        ) {
          const selection = validateDashboardSelection(await readRequestJson(request));
          const session = await saveTrainingSelection(selection);
          sendJson(response, 201, {
            saved: true,
            session,
          });
          return;
        }
        if (request.method === "POST" && requestUrl.pathname === "/api/desktop/session-complete") {
          const payload = await readRequestJson(request);
          const saved = await completeDesktopSession(payload);
          sendJson(response, 201, { saved: true, ...saved });
          return;
        }
        if (request.method === "POST" && requestUrl.pathname === "/api/desktop/session-checkpoint") {
          const payload = await readRequestJson(request);
          const saved = await checkpointDesktopSession(payload);
          sendJson(response, 200, { saved: true, ...saved });
          return;
        }
        if (request.method === "POST" && requestUrl.pathname === "/api/report/answer-upgrades") {
          const payload = await readRequestJson(request);
          const saved = await saveSessionAnswerUpgrades(payload);
          sendJson(response, 200, { saved: true, ...saved });
          return;
        }
        if (request.method === "POST" && requestUrl.pathname === "/api/settings/recording") {
          const settings = await saveRecordingSettings(await readRequestJson(request));
          sendJson(response, 200, { saved: true, settings });
          return;
        }
        if (request.method === "POST" && requestUrl.pathname === "/api/desktop/session-recording") {
          const saved = await saveSessionRecording(await readRequestJson(request));
          sendJson(response, 200, { saved: true, ...saved });
          return;
        }
        if (request.method === "POST" && requestUrl.pathname === "/api/recordings/delete") {
          const deleted = await deleteSessionRecording(await readRequestJson(request));
          sendJson(response, 200, deleted);
          return;
        }
        if (request.method === "GET" && requestUrl.pathname.startsWith("/api/recordings/")) {
          await serveSessionRecording(request, response, decodeURIComponent(requestUrl.pathname.slice("/api/recordings/".length)));
          return;
        }
        if (
          request.method === "GET" &&
          (requestUrl.pathname === "/" || requestUrl.pathname === "/dashboard")
        ) {
          const html = await fs.readFile(dashboardPath);
          response.writeHead(200, {
            "Content-Type": "text/html; charset=utf-8",
            "Content-Length": html.length,
            "Cache-Control": "no-store",
          });
          response.end(html);
          return;
        }
        if (request.method === "GET" && requestUrl.pathname === "/api/upgrade-config") {
          sendJson(response, 200, await readUpgradePageConfig());
          return;
        }
        sendJson(response, 404, { error: "Not found" });
      } catch (error) {
        sendJson(response, 400, { error: error.message || "Request failed" });
      }
    });

    httpServer.once("error", (error) => {
      if (error.code === "EADDRINUSE") {
        resolve({ alreadyRunning: true });
        return;
      }
      reject(error);
    });
    httpServer.listen(dashboardPort, dashboardHost, () => {
      resolve({ alreadyRunning: false, server: httpServer });
    });
  });
  return dashboardServerPromise;
}

function openDashboardInBrowser() {
  if (process.platform === "win32") {
    const child = spawn("cmd.exe", ["/c", "start", "", dashboardUrl], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
    return;
  }
  const command = process.platform === "darwin" ? "open" : "xdg-open";
  const child = spawn(command, [dashboardUrl], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}

const server = new McpServer(
  {
    name: "ielts-speaking-coach-local",
    version: "0.1.0",
  },
  {
    instructions:
      "This is the learner's local IELTS Speaking record. Before practice, call get_training_context. If a planned dashboard session exists, use its saved route, Part, exact question, length, and goal immediately without asking the learner to repeat choices. When the learner chooses a route in chat, call set_training_selection. After the fixed-format review, call save_session_review. Never force retraining.",
  },
);

server.registerTool(
  "initialize_ielts_workspace",
  {
    title: "Initialize IELTS speaking workspace",
    description:
      "Create the learner's private local data workspace before the first practice session.",
    inputSchema: {
      displayName: z.string().max(80).optional(),
    },
    outputSchema: {
      dataRoot: z.string(),
      initialized: z.boolean(),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: false,
    },
  },
  async ({ displayName }) => {
    await ensureWorkspace(displayName || "");
    return textResult(`本地训练空间已准备好：${dataRoot}`, {
      dataRoot,
      initialized: true,
    });
  },
);

server.registerTool(
  "set_training_selection",
  {
    title: "Set IELTS training selection",
    description:
      "Save the learner's freely chosen route and today's practice settings before a Voice session.",
    inputSchema: {
      route: z.enum([
        "continue_last_question",
        "next_question",
        "retrain_previous_session",
        "choose_history",
        "choose_question",
        "repeat_report_question",
      ]),
      part: z.enum(["Part 1", "Part 2", "Part 3", "Full mock"]),
      length: z.enum(["quick", "standard", "full"]).default("standard"),
      questionId: z.string().max(120).optional(),
      questionIds: z.array(z.string().max(120)).max(50).optional(),
      planItemId: z.string().max(120).optional(),
      selectedReference: z.string().max(300).optional(),
      singleGoal: z.string().max(300).optional(),
    },
    outputSchema: {
      session: z.object({
        id: z.string(),
        route: z.string(),
        part: z.string(),
        length: z.string(),
        questionId: z.string(),
        questionIds: z.array(z.string()).optional(),
        planItemId: z.string().optional(),
        selectedReference: z.string(),
        singleGoal: z.string(),
        status: z.string(),
        startedAt: z.string(),
      }),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: false,
    },
  },
  async ({ route, part, length, questionId, questionIds, planItemId, selectedReference, singleGoal }) => {
    const session = await saveTrainingSelection({
      route,
      part,
      length,
      questionId,
      questionIds,
      planItemId,
      selectedReference,
      singleGoal,
    });

    return textResult(
      `已保存本次选择：${part} / ${route}。现在可以开始语音训练。`,
      { session },
    );
  },
);

server.registerTool(
  "open_dashboard",
  {
    title: "Open IELTS speaking dashboard",
    description:
      "Open the learner's private local dashboard to choose a practice route with buttons.",
    inputSchema: {},
    outputSchema: {
      dashboardUrl: z.string(),
      opened: z.boolean(),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: false,
    },
  },
  async () => {
    await ensureWorkspace();
    await ensureDashboardServer();
    openDashboardInBrowser();
    return textResult(`本地训练仪表盘已打开：${dashboardUrl}`, {
      dashboardUrl,
      opened: true,
    });
  },
);

server.registerTool(
  "get_training_context",
  {
    title: "Get IELTS training context",
    description:
      "Read the current selection, recent sessions, and optional saved target before continuing or retraining.",
    inputSchema: {},
    outputSchema: {
      currentSession: z.unknown().nullable(),
      recentSessions: z.array(z.unknown()),
      recommendedTarget: z.unknown().nullable(),
      routeChoices: z.array(z.string()),
      dataRoot: z.string(),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    },
  },
  async () => {
    const state = await ensureWorkspace();
    const recommendedTarget =
      state.targets.find((target) => target.status !== "stable") || null;
    const routeChoices = [
      "continue_last_question",
      "next_question",
      "retrain_previous_session",
      "choose_history",
      "choose_question",
    ];

    return textResult("已读取本地训练上下文。", {
      currentSession: state.currentSession,
      recentSessions: state.sessions.slice(0, 10),
      recommendedTarget,
      routeChoices,
      dataRoot,
    });
  },
);

server.registerTool(
  "list_question_bank",
  {
    title: "List IELTS question bank",
    description:
      "List imported IELTS speaking topics or exact questions, optionally filtered by Part or search text.",
    inputSchema: {
      part: z.enum(["Part 1", "Part 2", "Part 3"]).optional(),
      search: z.string().max(200).optional(),
      limit: z.number().int().min(1).max(500).default(200),
    },
    outputSchema: {
      questions: z.array(z.unknown()),
      total: z.number(),
      sources: z.array(z.unknown()),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    },
  },
  async ({ part, search = "", limit }) => {
    const state = await ensureWorkspace();
    const needle = search.trim().toLowerCase();
    const filtered = state.questions.filter((question) => {
      if (part && question.part !== part) return false;
      return !needle ||
        `${question.topic} ${question.prompt} ${question.label}`
          .toLowerCase()
          .includes(needle);
    });
    return textResult(`题库中找到 ${filtered.length} 道可选题目。`, {
      questions: filtered.slice(0, limit),
      total: filtered.length,
      sources: state.questionSources,
    });
  },
);

server.registerTool(
  "import_question_bank",
  {
    title: "Import IELTS question bank",
    description:
      "Import normalized IELTS speaking questions from a JSON array and save them to the learner's local question bank.",
    inputSchema: {
      sourceName: z.string().max(200),
      sourceUrl: z.string().max(1000).optional(),
      questionsJson: z.string().min(2).max(4_000_000),
    },
    outputSchema: {
      imported: z.number(),
      total: z.number(),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: false,
    },
  },
  async ({ sourceName, sourceUrl = "", questionsJson }) => {
    let parsed;
    try {
      parsed = JSON.parse(questionsJson);
    } catch {
      throw new Error("questionsJson 必须是有效的 JSON 数组。");
    }
    if (!Array.isArray(parsed) || parsed.length === 0) {
      throw new Error("questionsJson 必须是非空数组。");
    }
    const imported = parsed.map((question, index) =>
      normalizeImportedQuestion(question, index, sourceName, sourceUrl)
    );
    const state = await ensureWorkspace();
    const byId = new Map(state.questions.map((question) => [question.id, question]));
    imported.forEach((question) => byId.set(question.id, question));
    state.questions = [...byId.values()];
    state.questionSources.unshift({
      title: sourceName,
      sourceUrl,
      importedAt: new Date().toISOString(),
      importLevel: "full-question",
      questionCount: imported.length,
    });
    await writeJsonAtomic(statePath, state);
    return textResult(`已导入 ${imported.length} 道题。`, {
      imported: imported.length,
      total: state.questions.length,
    });
  },
);

server.registerTool(
  "save_session_review",
  {
    title: "Save standardized IELTS review",
    description:
      "Save the fixed-format Markdown review and its machine-readable JSON record after a practice session.",
    inputSchema: {
      sessionId: z.string().max(80).optional(),
      reportMarkdown: z.string().min(1),
      reportJson: z.string().min(2),
    },
    outputSchema: {
      sessionId: z.string(),
      markdownPath: z.string(),
      jsonPath: z.string(),
      saved: z.boolean(),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: false,
    },
  },
  async ({ sessionId: requestedId, reportMarkdown, reportJson }) => {
    const state = await ensureWorkspace();
    const activeId = requestedId || state.currentSession?.id || sessionId();

    let parsedReport;
    try {
      parsedReport = JSON.parse(reportJson);
    } catch {
      throw new Error("reportJson 必须是有效的 JSON 字符串。");
    }

    const markdownPath = path.join(reportsDir, `${activeId}.md`);
    const jsonPath = path.join(reportsDir, `${activeId}.json`);
    await fs.writeFile(markdownPath, `${reportMarkdown.trim()}\n`, "utf8");
    await writeJsonAtomic(jsonPath, parsedReport);

    const existingIndex = state.sessions.findIndex(
      (session) => session.id === activeId,
    );
    const existing =
      existingIndex >= 0
        ? state.sessions[existingIndex]
        : {
            id: activeId,
            route: "choose_history",
            part: parsedReport.focus_part || "Part 1",
            length: "standard",
            selectedReference: "",
            singleGoal: "",
            startedAt: new Date().toISOString(),
          };

    const completed = {
      ...existing,
      status: "completed",
      completedAt: new Date().toISOString(),
      focusPart: parsedReport.focus_part || existing.part,
      priorityTarget: parsedReport.priority_target || null,
      markdownPath,
      jsonPath,
    };

    if (existingIndex >= 0) {
      state.sessions.splice(existingIndex, 1);
    }
    state.sessions.unshift(completed);
    state.currentSession = completed;
    markPlanItemCompleted(state, completed);

    if (parsedReport.priority_target?.id) {
      const target = {
        ...parsedReport.priority_target,
        sourceSessionId: activeId,
        status: parsedReport.priority_target.status || "new",
        savedAt: new Date().toISOString(),
      };
      const oldTargetIndex = state.targets.findIndex(
        (item) => item.id === target.id,
      );
      if (oldTargetIndex >= 0) {
        state.targets.splice(oldTargetIndex, 1);
      }
      state.targets.unshift(target);
    }

    await writeJsonAtomic(statePath, state);

    return textResult(`复盘报告已保存到本地：${markdownPath}`, {
      sessionId: activeId,
      markdownPath,
      jsonPath,
      saved: true,
    });
  },
);

server.registerTool(
  "list_practice_history",
  {
    title: "List IELTS practice history",
    description:
      "List recent locally saved IELTS speaking sessions for review or optional retraining.",
    inputSchema: {
      limit: z.number().int().min(1).max(50).default(10),
    },
    outputSchema: {
      sessions: z.array(z.unknown()),
      targets: z.array(z.unknown()),
      questions: z.array(z.unknown()),
      questionSources: z.array(z.unknown()),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    },
  },
  async ({ limit }) => {
    const state = await ensureWorkspace();
    return textResult(`找到 ${Math.min(limit, state.sessions.length)} 条训练记录。`, {
      sessions: state.sessions.slice(0, limit),
      targets: state.targets,
      questions: state.questions,
      questionSources: state.questionSources,
    });
  },
);

server.registerTool(
  "get_dashboard_data",
  {
    title: "Get IELTS dashboard data",
    description:
      "Return the learner's local session and target data for a dashboard or progress summary.",
    inputSchema: {},
    outputSchema: {
      learner: z.unknown(),
      currentSession: z.unknown().nullable(),
      sessions: z.array(z.unknown()),
      targets: z.array(z.unknown()),
      dataRoot: z.string(),
      dashboardTemplate: z.string(),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    },
  },
  async () => {
    const state = await ensureWorkspace();
    return textResult("已读取仪表盘数据。", {
      learner: state.learner,
      currentSession: state.currentSession,
      sessions: state.sessions,
      targets: state.targets,
      dataRoot,
      dashboardTemplate: dashboardPath,
    });
  },
);

await ensureDashboardServer();

if (process.argv.includes("--dashboard-only")) {
  process.stdout.write(`IELTS Speaking Coach dashboard: ${dashboardUrl}\n`);
  await new Promise(() => {});
} else if (process.env.IELTS_SPEAKING_EMBEDDED !== "1") {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
