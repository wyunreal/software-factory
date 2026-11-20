import fs from "node:fs";

// Build a plain Kubernetes Secret manifest from a .env file and print it as
// JSON. scripts/seal-secrets.sh pipes this directly into kubeseal, so secret
// values are never written to a plaintext file on disk.
//
// Usage:
//   node scripts/lib/env-secret.mjs <env-file> <namespace> <secret-name>

const [envFile, namespace, secretName] = process.argv.slice(2);

if (!envFile || !namespace || !secretName) {
  console.error(
    "Usage: node scripts/lib/env-secret.mjs <env-file> <namespace> <secret-name>",
  );
  process.exit(2);
}

const SECRET_KEYS = [
  // Database
  "POSTGRES_PASSWORD",
  "DATABASE_URL",
  "WEB_DATABASE_URL",
  // Factory / API
  "FACTORY_API_TOKEN",
  "OPENCODE_SERVER_PASSWORD",
  // GitHub App
  "GITHUB_APP_ID",
  "GITHUB_APP_SLUG",
  "GITHUB_APP_PRIVATE_KEY",
  "GITHUB_APP_PRIVATE_KEY_BASE64",
  "GITHUB_APP_WEBHOOK_SECRET",
  // Webapp / NextAuth
  "WEB_AUTH_SECRET",
  "NEXTAUTH_SECRET",
  "WEB_REGISTRATION_CODE",
  // OAuth providers
  "AUTH_GOOGLE_ID",
  "AUTH_GOOGLE_SECRET",
  "AUTH_GITHUB_ID",
  "AUTH_GITHUB_SECRET",
  "AUTH_APPLE_ID",
  "AUTH_APPLE_SECRET",
  "AUTH_AZURE_AD_ID",
  "AUTH_AZURE_AD_SECRET",
  "AUTH_AZURE_AD_TENANT_ID",
  "AUTH_GITLAB_ID",
  "AUTH_GITLAB_SECRET",
  // Model providers used by the OpenCode runtime
  "OLLAMA_API_KEY",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "OPENROUTER_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "MISTRAL_API_KEY",
  "GROQ_API_KEY",
  "DEEPSEEK_API_KEY",
  "XAI_API_KEY",
  "AZURE_OPENAI_API_KEY",
];

const REQUIRED_KEYS = [
  "POSTGRES_PASSWORD",
  "DATABASE_URL",
  "FACTORY_API_TOKEN",
  "OPENCODE_SERVER_PASSWORD",
  "GITHUB_APP_ID",
  "GITHUB_APP_SLUG",
  "GITHUB_APP_WEBHOOK_SECRET",
  "WEB_AUTH_SECRET",
];

function parseValue(raw) {
  let value = raw.trim();

  if (value.startsWith('"')) {
    let out = "";
    let escaped = false;
    for (let i = 1; i < value.length; i += 1) {
      const ch = value[i];
      if (escaped) {
        if (ch === "n") out += "\n";
        else if (ch === "r") out += "\r";
        else if (ch === "t") out += "\t";
        else out += ch;
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        return out;
      } else {
        out += ch;
      }
    }
    return out;
  }

  if (value.startsWith("'")) {
    const end = value.indexOf("'", 1);
    return end === -1 ? value.slice(1) : value.slice(1, end);
  }

  const comment = value.search(/\s+#/);
  if (comment !== -1) value = value.slice(0, comment);
  return value.trim();
}

function parseEnv(text) {
  const values = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(
      /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/,
    );
    if (!match) continue;
    values[match[1]] = parseValue(match[2]);
  }
  return values;
}

const values = parseEnv(fs.readFileSync(envFile, "utf8"));

// GITHUB_APP_PRIVATE_KEY_PATH is useful locally, but the path does not exist
// inside the cluster. Inline the key under the key the application expects.
if (values.GITHUB_APP_PRIVATE_KEY_PATH) {
  if (!values.GITHUB_APP_PRIVATE_KEY && !values.GITHUB_APP_PRIVATE_KEY_BASE64) {
    const path = values.GITHUB_APP_PRIVATE_KEY_PATH.replace(
      /^~(?=\/)/,
      process.env.HOME || "",
    );
    try {
      values.GITHUB_APP_PRIVATE_KEY = fs.readFileSync(path, "utf8");
    } catch (error) {
      console.error(
        `Error: cannot read GITHUB_APP_PRIVATE_KEY_PATH (${path}): ${error.message}`,
      );
      process.exit(1);
    }
  }
  delete values.GITHUB_APP_PRIVATE_KEY_PATH;
}

const missing = REQUIRED_KEYS.filter((key) => !values[key]?.trim());
if (!values.GITHUB_APP_PRIVATE_KEY && !values.GITHUB_APP_PRIVATE_KEY_BASE64) {
  missing.push("GITHUB_APP_PRIVATE_KEY or GITHUB_APP_PRIVATE_KEY_BASE64");
}
if (values.FACTORY_API_TOKEN && values.FACTORY_API_TOKEN.length < 16) {
  console.error("Error: FACTORY_API_TOKEN must be at least 16 characters.");
  process.exit(1);
}
if (values.WEB_AUTH_SECRET && values.WEB_AUTH_SECRET.length < 32) {
  console.error("Error: WEB_AUTH_SECRET must be at least 32 characters.");
  process.exit(1);
}
if (missing.length > 0) {
  console.error("Error: missing required values in .env:");
  for (const key of missing) console.error(`  - ${key}`);
  process.exit(1);
}

const stringData = {};
for (const key of SECRET_KEYS) {
  const value = values[key];
  if (value !== undefined && value !== "") stringData[key] = value;
}

const included = Object.keys(stringData);
if (included.length === 0) {
  console.error("Error: no secret keys were found in .env.");
  process.exit(1);
}

process.stderr.write(
  `Sealing ${included.length} secret keys: ${included.join(", ")}\n`,
);

process.stdout.write(
  JSON.stringify(
    {
      apiVersion: "v1",
      kind: "Secret",
      metadata: { name: secretName, namespace },
      type: "Opaque",
      stringData,
    },
    null,
    2,
  ),
);
