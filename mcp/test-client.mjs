import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const testDataRoot = path.join(os.tmpdir(), "ielts-speaking-coach-mcp-test");

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(__dirname, "server.mjs")],
  env: {
    ...process.env,
    IELTS_SPEAKING_DATA_DIR: testDataRoot,
  },
});

const client = new Client({
  name: "ielts-speaking-coach-test",
  version: "0.1.0",
});

await client.connect(transport);

try {
  const tools = await client.listTools();
  const names = tools.tools.map((tool) => tool.name);
  for (const expected of [
    "initialize_ielts_workspace",
    "open_dashboard",
    "set_training_selection",
    "get_training_context",
    "save_session_review",
    "list_practice_history",
    "get_dashboard_data",
    "list_question_bank",
    "import_question_bank",
  ]) {
    assert(names.includes(expected), `Missing MCP tool: ${expected}`);
  }

  const initialized = await client.callTool({
    name: "initialize_ielts_workspace",
    arguments: { displayName: "Local test learner" },
  });
  assert.equal(initialized.structuredContent.initialized, true);

  const questionBank = await client.callTool({
    name: "list_question_bank",
    arguments: { part: "Part 1", limit: 100 },
  });
  assert.equal(questionBank.structuredContent.total, 37);
  const chosenQuestion = questionBank.structuredContent.questions[0];

  const part2Bank = await client.callTool({
    name: "list_question_bank",
    arguments: { part: "Part 2", limit: 100 },
  });
  assert.equal(part2Bank.structuredContent.total, 52);
  assert.match(part2Bank.structuredContent.questions[0].prompt, /^Describe\b/);
  assert.equal(part2Bank.structuredContent.questions[0].importLevel, "full-question");

  const selection = await client.callTool({
    name: "set_training_selection",
    arguments: {
      route: "choose_question",
      part: "Part 1",
      length: "quick",
      questionId: chosenQuestion.id,
      singleGoal: "Use a clear beginning, middle, and ending",
    },
  });
  assert.equal(selection.structuredContent.session.questionId, chosenQuestion.id);
  assert.equal(selection.structuredContent.session.selectedReference, chosenQuestion.prompt);
  const activeSessionId = selection.structuredContent.session.id;

  const saved = await client.callTool({
    name: "save_session_review",
    arguments: {
      sessionId: activeSessionId,
      reportMarkdown: "# Test review\n\nA fixed-format local report.",
      reportJson: JSON.stringify({
        session_id: activeSessionId,
        focus_part: "Part 2",
        priority_target: {
          id: "logic-timeline",
          label: "Use a clear timeline",
          status: "new",
          evidence: ["Then I go there."],
        },
        must_correct: [],
        naturalness: [],
        vocabulary: [],
        habits: [],
      }),
    },
  });
  assert.equal(saved.structuredContent.saved, true);

  const history = await client.callTool({
    name: "list_practice_history",
    arguments: { limit: 5 },
  });
  assert.equal(history.structuredContent.sessions[0].status, "completed");
  assert.equal(history.structuredContent.targets[0].id, "logic-timeline");

  process.stdout.write(
    `MCP smoke test passed with ${names.length} tools. Data: ${testDataRoot}\n`,
  );
} finally {
  await client.close();
}
