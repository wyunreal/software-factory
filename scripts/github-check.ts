import { loadConfig, ConfigError } from "../src/config.ts";
import { GitHubIssuesBacklog } from "../src/backlog/github.ts";
import { GitHubAppAuth } from "../src/github-app.ts";
import { Logger } from "../src/logger.ts";

const logger = new Logger({ script: "github-check" }, "info");

try {
  const config = loadConfig();
  console.log(
    `Checking GitHub App ${config.github.appId} (${config.github.slug})`,
  );
  const auth = new GitHubAppAuth(config.github, logger);
  const backlog = new GitHubIssuesBacklog(config.github, auth, logger);
  await backlog.validate();
  console.log(
    "\nGitHub App credentials OK. Install the app on target repositories from the webapp.",
  );
} catch (error) {
  if (error instanceof ConfigError) {
    console.error(error.message);
  } else {
    console.error(error instanceof Error ? error.message : error);
  }
  process.exit(1);
}
