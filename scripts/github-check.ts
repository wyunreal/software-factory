import { loadConfig, ConfigError } from "../src/config.ts";
import { GitHubIssuesBacklog } from "../src/backlog/github.ts";
import { Logger } from "../src/logger.ts";

const logger = new Logger({ script: "github-check" }, "info");

try {
  const config = loadConfig();
  console.log(`Checking GitHub credentials at ${config.github.apiUrl}`);
  const backlog = new GitHubIssuesBacklog(config.github, logger);
  await backlog.validate();
  console.log(
    "\nGitHub OK. Start runs from the webapp/API with a repo and issue URL.",
  );
} catch (error) {
  if (error instanceof ConfigError) {
    console.error(error.message);
  } else {
    console.error(error instanceof Error ? error.message : error);
  }
  process.exit(1);
}
