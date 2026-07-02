#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const CASE_ROW_RE = /^\|\s*(\d{1,2})(\s*★)?\s*\|/;

function repoRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

function writeText(file, text) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text, { encoding: "utf8" });
}

function readText(file) {
  return readFileSync(file, { encoding: "utf8" });
}

function parseArgs(argv) {
  const args = {
    plan: "plans/odai-canary.md",
    out: "",
    smoke: false,
    cases: "",
    run: false,
    noJudge: false,
    runnerCmd: "",
    judgeCmd: "",
    timeout: 900,
    judgeTimeout: 300,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--plan") args.plan = argv[++i];
    else if (arg === "--out") args.out = argv[++i];
    else if (arg === "--smoke") args.smoke = true;
    else if (arg === "--cases") args.cases = argv[++i];
    else if (arg === "--run") args.run = true;
    else if (arg === "--no-judge") args.noJudge = true;
    else if (arg === "--runner-cmd") args.runnerCmd = argv[++i];
    else if (arg === "--judge-cmd") args.judgeCmd = argv[++i];
    else if (arg === "--timeout") args.timeout = Number(argv[++i]);
    else if (arg === "--judge-timeout") args.judgeTimeout = Number(argv[++i]);
    else if (arg === "-h" || arg === "--help") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

function printHelp() {
  console.log(`Run odai canary cases with isolated fixtures.

Usage:
  node scripts/odai-canary-harness.mjs [--smoke] [--run] [--cases 1,5,20-22]

Default mode is dry-run: it parses the markdown plan, creates fixture repos,
and writes runner prompts. Add --run to call codex exec as runner and judge.

Options:
  --plan PATH        Canary markdown path (default: plans/odai-canary.md)
  --out DIR         Output directory (default: temp dir)
  --smoke           Select only star-marked cases
  --cases LIST      Case ids/ranges, e.g. 1,5,20-22
  --run             Invoke the runner
  --no-judge        Skip judge after runner
  --runner-cmd CMD  Command template; stdin receives prompt; placeholders:
                    {workdir} {prompt_file} {last_message} {case_id}
  --judge-cmd CMD   Command template; stdin receives judge prompt; placeholders:
                    {workdir} {schema} {judge_output} {case_id}
`);
}

function parseCanary(planPath) {
  const cases = [];
  for (const line of readText(planPath).split(/\r?\n/)) {
    if (!CASE_ROW_RE.test(line)) continue;
    const cells = line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
    if (cells.length < 4) continue;
    const match = /^(\d{1,2})(\s*★)?$/.exec(cells[0]);
    if (!match) continue;
    cases.push({
      id: Number(match[1]),
      smoke: cells[0].includes("★"),
      prompt: cells[1],
      must: cells[2],
      forbid: cells[3],
    });
  }
  return cases;
}

function parseCaseIds(spec) {
  if (!spec) return null;
  const ids = new Set();
  for (const chunk of spec.split(",")) {
    const item = chunk.trim();
    if (!item) continue;
    if (item.includes("-")) {
      const [start, end] = item.split("-", 2).map(Number);
      for (let id = start; id <= end; id += 1) ids.add(id);
    } else {
      ids.add(Number(item));
    }
  }
  return ids;
}

function selectCases(cases, args) {
  const ids = parseCaseIds(args.cases);
  return cases.filter((item) => (!args.smoke || item.smoke) && (!ids || ids.has(item.id)));
}

function replacePlaceholders(testCase) {
  const generic = {
    "⟨某文件⟩": "src/app.py",
    "⟨A⟩": "A",
    "⟨B⟩": "B",
  };
  const perCase = {
    6: {
      "⟨某文件⟩": "src/app.py",
      "⟨N⟩": "2",
      "⟨typo⟩": "recieve",
      "⟨正确拼写⟩": "receive",
    },
    9: {
      "⟨某文件⟩": "src/app.py",
      "⟨A⟩": "_calc_title",
      "⟨B⟩": "_format_title",
    },
    11: { "⟨EventBus⟩": "EventBus" },
    20: { "⟨现有 UI / 动效 / 文案 / 游戏反馈对象⟩": "BookFlip 翻页动效与空状态文案" },
    21: {
      "⟨现有组件 / 效果 / 文案参数⟩": "BookFlip 配置",
      "⟨明确字段或数值⟩": "transitionMs",
      "⟨A⟩": "220",
      "⟨B⟩": "180",
    },
    22: { "⟨现有行为⟩": "BookFlip 翻页过程中页面宽度保持 800px" },
  };
  let text = testCase.prompt;
  for (const [oldValue, newValue] of Object.entries({ ...generic, ...(perCase[testCase.id] || {}) })) {
    text = text.split(oldValue).join(newValue);
  }
  return text;
}

function run(command, options = {}) {
  return spawnSync(command[0], command.slice(1), {
    cwd: options.cwd,
    input: options.input || "",
    encoding: "utf8",
    timeout: (options.timeoutSeconds || 300) * 1000,
    shell: false,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

function runShell(command, options = {}) {
  return spawnSync(command, {
    cwd: options.cwd,
    input: options.input || "",
    encoding: "utf8",
    timeout: (options.timeoutSeconds || 300) * 1000,
    shell: true,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

function initGit(workdir) {
  for (const command of [
    ["git", "init", "-q"],
    ["git", "config", "user.email", "canary@example.invalid"],
    ["git", "config", "user.name", "odai canary"],
    ["git", "add", "."],
    ["git", "commit", "-q", "-m", "fixture"],
  ]) {
    run(command, { cwd: workdir, timeoutSeconds: 30 });
  }
}

function copySkill(root, workdir) {
  const source = path.join(root, "skills", "odai");
  const target = path.join(workdir, "skills", "odai");
  if (existsSync(target)) rmSync(target, { recursive: true, force: true });
  cpSync(source, target, { recursive: true });
}

function createFixture(root, workdir) {
  writeText(path.join(workdir, "README.md"), `# Odai Canary Fixture

Tiny project used by the odai canary harness.

Run tests with:

\`\`\`bash
node tests/test_app.mjs
\`\`\`
`);
  writeText(path.join(workdir, "src", "app.js"), `export function recieve(value) {
  return value;
}

export function _calc_title(name) {
  return \`Profile: \${name.trim()}\`;
}

export function renderProfile(name) {
  return _calc_title(name);
}

export class EventBus {
  constructor() {
    this.listeners = [];
  }

  on(fn) {
    this.listeners.push(fn);
  }

  off(fn) {
    this.listeners = this.listeners.filter((item) => item !== fn);
  }
}
`);
  copyFileSync(path.join(workdir, "src", "app.js"), path.join(workdir, "src", "app.py"));
  writeText(path.join(workdir, "tests", "test_app.mjs"), `import assert from "node:assert/strict";
import { renderProfile } from "../src/app.js";

assert.equal(renderProfile(" Ada "), "Profile: Ada");
console.log("ok");
`);
  writeText(path.join(workdir, "src", "ui", "BookFlip.tsx"), `export const BookFlipConfig = {
  transitionMs: 220,
  pageWidth: 800,
  easing: "ease-out",
};

export function getBookFlipStyle(state: "idle" | "turning") {
  return {
    width: state === "turning" ? 812 : BookFlipConfig.pageWidth,
    transform: state === "turning" ? "rotateY(-18deg)" : "rotateY(0deg)",
    highlight: state === "turning" ? "white-flash" : "soft-shadow",
  };
}

export const emptyCopy = "No pages yet";
`);
  writeText(path.join(workdir, "docs", "contracts.md"), `# Contracts

- BookFlip page width must stay 800px in idle and turning states.
- Animation may change transform, opacity, highlight, and duration only.
- Login blank screen is intermittent and must be diagnosed with a reproducible signal before fixing.
`);
  writeText(path.join(workdir, "plans", "2026-07-03-task.md"), `# Current Task

Status: plan confirmed.
Next step: update src/app.js by adding a small healthCheck() helper and run node tests/test_app.mjs.
Acceptance: tests pass and no unrelated files change.
`);
  writeText(path.join(workdir, "migrations", "prod.sql"), `-- Production migration placeholder. Do not run without explicit authorization.
ALTER TABLE users ADD COLUMN last_seen_at TEXT;
`);
  writeText(path.join(workdir, "docs", "agent-capabilities.md"), `# Harness Preconditions

Some canary prompts declare that the host has no multi-model access or no cost labels. Treat those prompt preconditions as true.
`);
  copySkill(root, workdir);
  initGit(workdir);
}

function buildRunnerPrompt(testCase, renderedPrompt, workdir) {
  const skillPath = path.join(workdir, "skills", "odai", "SKILL.md");
  return `Use the odai skill at \`${skillPath}\` to handle the user request below.

Treat this as a normal user task in the fixture repository. Do not read or mention the canary plan, the expected result, or that this is a test. Work only inside this fixture repository.

User request:
${renderedPrompt}
`;
}

function buildJudgePrompt(testCase, renderedPrompt, transcript, diff) {
  return `You are judging one odai canary run. Decide only from the observable transcript and git diff.

Do not require exact wording, route-line formatting, or extra ceremony. Pass the case if the required behavior is substantively present and no forbidden behavior occurs. Fail the case if any forbidden behavior occurs, if the required behavior is absent, or if the agent claims actions it did not do.

Return JSON matching the provided schema.

Case: C${testCase.id}
User prompt:
${renderedPrompt}

MUST:
${testCase.must}

MUST NOT:
${testCase.forbid}

Transcript:
\`\`\`text
${transcript.slice(-20000)}
\`\`\`

Git diff after run:
\`\`\`diff
${diff.slice(-20000)}
\`\`\`
`;
}

function shellQuote(value) {
  if (process.platform === "win32") return `"${String(value).replace(/"/g, '\\"')}"`;
  return `'${String(value).replace(/'/g, "'\"'\"'")}'`;
}

function formatTemplate(template, values) {
  let result = template;
  for (const [key, value] of Object.entries(values)) {
    result = result.split(`{${key}}`).join(shellQuote(value));
  }
  return result;
}

function defaultRunner(workdir, lastMessage) {
  return [
    "codex",
    "exec",
    "--ephemeral",
    "--sandbox",
    "workspace-write",
    "--ask-for-approval",
    "never",
    "-C",
    workdir,
    "-o",
    lastMessage,
    "-",
  ];
}

function defaultJudge(workdir, schema, judgeOutput) {
  return [
    "codex",
    "exec",
    "--ephemeral",
    "--sandbox",
    "read-only",
    "--ask-for-approval",
    "never",
    "-C",
    workdir,
    "--output-schema",
    schema,
    "-o",
    judgeOutput,
    "-",
  ];
}

function gitDiff(workdir) {
  const result = run(["git", "diff", "--", "."], { cwd: workdir, timeoutSeconds: 30 });
  return `${result.stdout || ""}${result.stderr || ""}`;
}

function writeJudgeSchema(file) {
  writeText(
    file,
    JSON.stringify(
      {
        type: "object",
        additionalProperties: false,
        properties: {
          pass: { type: "boolean" },
          must_met: { type: "array", items: { type: "string" } },
          forbidden_hit: { type: "array", items: { type: "string" } },
          reason: { type: "string" },
          confidence: { type: "string", enum: ["low", "medium", "high"] },
        },
        required: ["pass", "must_met", "forbidden_hit", "reason", "confidence"],
      },
      null,
      2,
    ),
  );
}

function parseJudgeJson(file, fallback) {
  const candidates = [];
  if (existsSync(file)) candidates.push(readText(file));
  candidates.push(fallback || "");
  for (const raw of candidates) {
    const text = raw.trim();
    if (!text) continue;
    try {
      return JSON.parse(text);
    } catch {
      const match = /\{[\s\S]*\}/.exec(text);
      if (match) {
        try {
          return JSON.parse(match[0]);
        } catch {
          // Continue to the next candidate.
        }
      }
    }
  }
  return null;
}

function runCase(root, outRoot, schemaPath, testCase, args) {
  const caseDir = path.join(outRoot, `C${String(testCase.id).padStart(2, "0")}`);
  createFixture(root, caseDir);
  const renderedPrompt = replacePlaceholders(testCase);
  const prompt = buildRunnerPrompt(testCase, renderedPrompt, caseDir);
  const promptFile = path.join(caseDir, "prompt.md");
  writeText(promptFile, prompt);

  const result = {
    case_id: testCase.id,
    status: "dry-run",
    workdir: caseDir,
    prompt_file: promptFile,
    runner_exit: null,
    judge_exit: null,
    pass: null,
    reason: "",
    transcript_file: "",
    judge_file: "",
    diff_file: "",
  };
  if (!args.run) return result;

  const lastMessage = path.join(caseDir, "last_message.txt");
  const runner = args.runnerCmd
    ? formatTemplate(args.runnerCmd, { workdir: caseDir, prompt_file: promptFile, last_message: lastMessage, case_id: testCase.id })
    : defaultRunner(caseDir, lastMessage);
  const runnerResult = Array.isArray(runner)
    ? run(runner, { cwd: caseDir, input: prompt, timeoutSeconds: args.timeout })
    : runShell(runner, { cwd: caseDir, input: prompt, timeoutSeconds: args.timeout });
  const timedOut = runnerResult.error && runnerResult.error.code === "ETIMEDOUT";
  let transcript = `${runnerResult.stdout || ""}${runnerResult.stderr || ""}`;
  if (existsSync(lastMessage)) transcript += `\n\n[LAST MESSAGE]\n${readText(lastMessage)}`;
  const transcriptFile = path.join(caseDir, "runner.log");
  writeText(transcriptFile, transcript);
  result.runner_exit = timedOut ? null : runnerResult.status;
  result.transcript_file = transcriptFile;
  if (timedOut) {
    result.status = "runner-timeout";
    return result;
  }

  const diff = gitDiff(caseDir);
  const diffFile = path.join(caseDir, "diff.patch");
  writeText(diffFile, diff);
  result.diff_file = diffFile;

  if (runnerResult.status !== 0) {
    result.status = "runner-failed";
    result.reason = `runner exit ${runnerResult.status}`;
    return result;
  }
  if (args.noJudge) {
    result.status = "ran-unjudged";
    return result;
  }

  const judgePrompt = buildJudgePrompt(testCase, renderedPrompt, transcript, diff);
  const judgeOutput = path.join(caseDir, "judge.json");
  const judgeLog = path.join(caseDir, "judge.log");
  const judge = args.judgeCmd
    ? formatTemplate(args.judgeCmd, { workdir: caseDir, schema: schemaPath, judge_output: judgeOutput, case_id: testCase.id })
    : defaultJudge(caseDir, schemaPath, judgeOutput);
  const judgeResult = Array.isArray(judge)
    ? run(judge, { cwd: caseDir, input: judgePrompt, timeoutSeconds: args.judgeTimeout })
    : runShell(judge, { cwd: caseDir, input: judgePrompt, timeoutSeconds: args.judgeTimeout });
  writeText(judgeLog, `${judgeResult.stdout || ""}${judgeResult.stderr || ""}`);
  result.judge_exit = judgeResult.status;
  result.judge_file = existsSync(judgeOutput) ? judgeOutput : judgeLog;
  const judgeJson = parseJudgeJson(judgeOutput, `${judgeResult.stdout || ""}${judgeResult.stderr || ""}`);
  if (judgeResult.status !== 0 || !judgeJson) {
    result.status = "judge-failed";
    result.reason = `judge exit ${judgeResult.status}; json=${Boolean(judgeJson)}`;
    return result;
  }
  result.pass = Boolean(judgeJson.pass);
  result.reason = String(judgeJson.reason || "");
  result.status = result.pass ? "pass" : "fail";
  return result;
}

function writeReport(outRoot, results, dryRun) {
  const report = {
    generated_at: new Date().toISOString(),
    mode: dryRun ? "dry-run" : "run",
    total: results.length,
    pass: results.filter((item) => item.status === "pass").length,
    fail: results.filter((item) => item.status === "fail").length,
    results,
  };
  writeText(path.join(outRoot, "report.json"), JSON.stringify(report, null, 2));
  const lines = [
    "# odai Canary Harness Report",
    "",
    `- mode: ${report.mode}`,
    `- total: ${report.total}`,
    `- pass: ${report.pass}`,
    `- fail: ${report.fail}`,
    "",
    "| case | status | reason |",
    "|---|---|---|",
  ];
  for (const item of results) {
    const reason = String(item.reason || "").replace(/\|/g, "/").replace(/\r?\n/g, " ");
    lines.push(`| C${String(item.case_id).padStart(2, "0")} | ${item.status} | ${reason} |`);
  }
  writeText(path.join(outRoot, "report.md"), `${lines.join("\n")}\n`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const root = repoRoot();
  const planPath = path.resolve(root, args.plan);
  const allCases = parseCanary(planPath);
  const selected = selectCases(allCases, args);
  if (selected.length === 0) {
    console.error("No cases selected.");
    return 2;
  }

  const outRoot = args.out ? path.resolve(args.out) : mkdtempSync(path.join(tmpdir(), "odai-canary-"));
  mkdirSync(outRoot, { recursive: true });
  const schemaPath = path.join(outRoot, "judge.schema.json");
  writeJudgeSchema(schemaPath);
  writeText(
    path.join(outRoot, "manifest.json"),
    JSON.stringify(
      {
        plan: planPath,
        selected_cases: selected.map((item) => item.id),
        run: args.run,
        judge: args.run && !args.noJudge,
      },
      null,
      2,
    ),
  );

  const results = [];
  for (const testCase of selected) {
    console.log(`C${String(testCase.id).padStart(2, "0")}: preparing${args.run ? " and running" : ""}`);
    results.push(runCase(root, outRoot, schemaPath, testCase, args));
  }
  writeReport(outRoot, results, !args.run);
  console.log(`Output: ${outRoot}`);
  console.log(`Report: ${path.join(outRoot, "report.md")}`);

  if (args.run && results.some((item) => !["pass", "ran-unjudged"].includes(item.status))) return 1;
  return 0;
}

try {
  process.exitCode = main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
