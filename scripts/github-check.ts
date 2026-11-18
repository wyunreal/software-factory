import { loadConfig, ConfigError } from "../src/config.ts";
import { GitHubIssuesBacklog } from "../src/backlog/github.ts";
import { Logger } from "../src/logger.ts";

const logger = new Logger({ script: "github-check" }, "info");

try {
  const config = loadConfig();
  if (!config.github.repository) {
    console.log(
      "No default repo configured (GITHUB_REPOSITORY/FACTORY_REPO_URL). " +
        "Polling is disabled; start runs from the webapp or POST /api/runs.",
    );
    process.exit(0);
  }
  console.log(
    `Checking GitHub Issues backlog at ${config.github.repository} (${config.github.apiUrl})`,
  );
  const backlog = new GitHubIssuesBacklog(config.github, logger);
  await backlog.validate();
  const tickets = await backlog.fetchReadyTickets();
  console.log(`\nGitHub Issues OK. ${tickets.length} ready issue(s):`);
  for (const ticket of tickets) {
    console.log(
      `- ${ticket.ref}: ${ticket.title} (${ticket.acceptanceCriteria.length} criteria)`,
    );
  }
} catch (error) {
  if (error instanceof ConfigError) {
    console.error(error.message);
  } else {
    console.error(error instanceof Error ? error.message : error);
  }
  process.exit(1);
}
