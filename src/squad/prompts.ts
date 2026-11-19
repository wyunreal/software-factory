import type { Ticket } from "../domain/types.ts";
import { ticketPrompt } from "../domain/ticket.ts";
import { truncate } from "../util.ts";

export function planningPrompt(ticket: Ticket, baseBranch: string): string {
  return [
    "Analyze the following ticket and produce the implementation plan.",
    "",
    ticketPrompt(ticket),
    "",
    `The repository is checked out in the current directory. The base branch is \`${baseBranch}\`.`,
    "Explore the code before planning. Do not modify files and do not run shell commands.",
    "Your final message is the plan; it will be stored as the run artifact.",
  ].join("\n");
}

export function builderPrompt(
  ticket: Ticket,
  plan: string,
  feedback?: {
    testOutput?: string;
    review?: string;
    feedback?: string;
  },
  hints?: { setup?: string | null; test?: string | null },
): string {
  const sections = [
    "Implement the following ticket in the current git worktree.",
    "",
    ticketPrompt(ticket),
    "",
    "Implementation plan:",
    truncate(plan, 60_000),
    "",
    "Rules: implement the smallest complete change, follow the repository conventions,",
    "add or update tests, and leave the changes uncommitted. Do not run git commit or git push.",
    "Set up the project, build it, run its tests, and fix any setup/build/test failure",
    "you find using the project's native tooling.",
    "Your final message must be the implementation report.",
  ];
  if (hints?.setup || hints?.test) {
    sections.push("", "Configured command hints (verify them before using):");
    if (hints.setup) sections.push(`- setup: ${hints.setup}`);
    if (hints.test) sections.push(`- test: ${hints.test}`);
  }
  if (feedback?.testOutput) {
    sections.push(
      "",
      "A previous attempt failed the automated test gate. Fix the cause.",
      "Test output:",
      "```",
      truncate(feedback.testOutput, 20_000),
      "```",
    );
  }

  if (feedback?.review) {
    sections.push(
      "",
      "A previous attempt failed code review. Address the findings.",
      "Review:",
      truncate(feedback.review, 20_000),
    );
  }

  if (feedback?.feedback) {
    sections.push(
      "",
      "A human reviewer requested changes on the pull request. Address every",
      "actionable item below, and keep the existing working behaviour intact.",
      "Human review feedback:",
      truncate(feedback.feedback, 20_000),
    );
  }

  return sections.join("\n");
}

export function qaPrompt(
  ticket: Ticket,
  plan: string,
  buildReport: string,
  testCommand: string | null,
): string {  return [
    "Verify the implementation of the following ticket.",
    "",
    ticketPrompt(ticket),
    "",
    "Implementation plan:",
    truncate(plan, 40_000),
    "",
    "Implementation report:",
    truncate(buildReport, 40_000),
    "",
    `Test command: ${testCommand ? `\`${testCommand}\`` : "(not configured)"}`,
    "Add or repair automated tests where coverage is missing, then run the test command.",
    "You may only edit test files. Report production bugs instead of fixing them.",
    "Your final message must be the QA report.",
  ].join("\n");
}

export function triagePrompt(input: {
  ticket: Ticket;
  plan: string;
  buildReport: string;
  review: string;
  diffStat: string;
  comments: string;
}): string {
  return [
    "Evaluate the following new human comments on the pull request.",
    "",
    ticketPrompt(input.ticket),
    "",
    "Implementation plan:",
    truncate(input.plan, 30_000),
    "",
    "Implementation report:",
    truncate(input.buildReport, 20_000),
    "",
    "Previous review:",
    truncate(input.review, 15_000),
    "",
    "Changed files:",
    input.diffStat || "(no diff stat available)",
    "",
    "New human comments:",
    truncate(input.comments, 30_000),
    "",
    "Decide per comment whether it requires code changes. Return only the JSON",
    "document described in your instructions.",
  ].join("\n");
}

export function reviewPrompt(
  ticket: Ticket,
  plan: string,
  diffStat: string,
  testReport: string,
): string {
  return [
    "Review the current change in the worktree against the ticket.",
    "",
    ticketPrompt(ticket),
    "",
    "Implementation plan:",
    truncate(plan, 30_000),
    "",
    "Changed files:",
    diffStat || "(no diff stat available)",
    "",
    "Automated test gate result:",
    truncate(testReport, 20_000),
    "",
    "Inspect the diff with read-only git commands and read the affected files.",
    "Do not modify anything. Start your final answer with VERDICT: PASS or VERDICT: FAIL.",
  ].join("\n");
}

export function verificationPrompt(input: {
  ticket: Ticket;
  testHint: string | null;
}): string {
  return [
    "You are the verification gate for this worktree. Do not modify any file.",
    "",
    `Ticket: ${input.ticket.ref} — ${input.ticket.title}`,
    input.testHint ? `Optional hint from the run configuration: \`${input.testHint}\`` : "",
    "",
    "Inspect the repository and decide how this change should be verified. Run the",
    "checks the project itself uses (tests, build, lint, or an equivalent), capture",
    "the commands, exit codes and relevant output.",
    "If the project has no automated checks, report skipped=true.",
    "",
    "Return ONLY a fenced JSON block:",
    "```json",
    '{"skipped":false,"passed":true,"exitCode":0,"timedOut":false,"command":"<command you ran>","durationMs":1234,"output":"..."}',
    "```",
  ]
    .filter(Boolean)
    .join("\n");
}

export function pullRequestBody(input: {
  ticket: Ticket;
  plan: string;
  buildReport: string;
  qaReport: string;
  testReport: string;
  review: string;
  reworkCount: number;
}): string {
  const issueNumber =
    input.ticket.number ?? parseIssueRef(input.ticket.ref);
  return [
    `## ${input.ticket.title}`,
    "",
    `Ticket: ${input.ticket.url}`,
    `Factory reference: \`${input.ticket.ref}\``,
    issueNumber ? `Closes #${issueNumber}` : "",
    `Rework cycles: ${input.reworkCount}`,
    "",
    "## Implementation plan",
    "",
    truncate(input.plan, 8_000),
    "",
    "## Implementation report",
    "",
    truncate(input.buildReport, 8_000),
    "",
    "## QA report",
    "",
    truncate(input.qaReport, 6_000),
    "",
    "## Automated tests",
    "",
    truncate(input.testReport, 6_000),
    "",
    "## Review",
    "",
    truncate(input.review, 6_000),
    "",
    "---",
    "",
    "_Generated by the Software Factory. A human must review and merge this change._",
  ].join("\n");
}

export function deliveryComment(input: {
  prUrl: string | null;
  branch: string;
  testsSummary: string;
  reworkCount: number;
}): string {
  return [
    "✅ **Software Factory: ready for human review**",
    "",
    input.prUrl ? `Pull request: ${input.prUrl}` : "Pull request: not created (local delivery mode)",
    `Branch: \`${input.branch}\``,
    `Tests: ${input.testsSummary}`,
    `Rework cycles: ${input.reworkCount}`,
    "",
    "The factory has stopped here. Review and merge manually.",
  ].join("\n");
}

export function blockedComment(input: {
  reason: string;
  branch: string | null;
  reworkCount: number;
}): string {
  return [
    "⛔ **Software Factory: blocked**",
    "",
    truncate(input.reason, 3_500),
    "",
    input.branch ? `Branch: \`${input.branch}\`` : null,
    `Rework cycles: ${input.reworkCount}`,
    "",
    "A human needs to review the failure and reopen the issue or remove the state labels to retry.",
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

function parseIssueRef(ref: string): number | null {
  const match = /^GH-(\d+)$/i.exec(ref);
  return match?.[1] ? Number(match[1]) : null;
}
