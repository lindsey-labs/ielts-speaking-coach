import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(__dirname, "server.mjs")],
  env: process.env,
});

const client = new Client({
  name: "ielts-speaking-coach-local-initializer",
  version: "0.1.0",
});

await client.connect(transport);

try {
  const initialized = await client.callTool({
    name: "initialize_ielts_workspace",
    arguments: {},
  });
  const context = await client.callTool({
    name: "get_training_context",
    arguments: {},
  });

  if (initialized.isError || context.isError) {
    throw new Error(
      `Local initialization failed:\n${JSON.stringify({ initialized, context }, null, 2)}`,
    );
  }

  process.stdout.write(
    `${initialized.content[0].text}\nMCP connection passed. Sessions: ${context.structuredContent?.recentSessions?.length ?? 0}\n`,
  );
} finally {
  await client.close();
}
