import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const skillDir = resolve(scriptDir, "..");
const destination = resolve(process.argv[2] || "ielts-speaking-workspace");

await mkdir(join(destination, "data", "reports"), { recursive: true });
await mkdir(join(destination, "recordings"), { recursive: true });
await copyFile(
  join(skillDir, "assets", "dashboard-template.html"),
  join(destination, "dashboard.html")
);

const profile = {
  learner_name: "Learner",
  current_plan: { length_days: 14, current_day: 1 },
  active_target: null,
  consent_to_store_audio: false
};

const questions = [
  {
    id: "p3-education-001",
    part: 3,
    topic: "Education",
    prompt: "Should schools teach more practical skills?",
    followups: [
      "Which skills matter most?",
      "Who should decide the curriculum?"
    ],
    source: "Built-in sample",
    status: "new"
  }
];

await writeFile(join(destination, "data", "profile.json"), JSON.stringify(profile, null, 2));
await writeFile(join(destination, "data", "questions.json"), JSON.stringify(questions, null, 2));
await writeFile(join(destination, "data", "plan.json"), JSON.stringify({ sessions: [] }, null, 2));
await writeFile(join(destination, "data", "targets.json"), JSON.stringify({ targets: [] }, null, 2));

console.log(`IELTS Speaking workspace created at: ${destination}`);
console.log(`Open: ${join(destination, "dashboard.html")}`);
