import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import { pool } from "../db/pool.js";
import { migrate } from "../db/migrate.js";
import { createSystemAdmin } from "../services/userService.js";

/**
 * Creates a system administrator, who is also Org Admin of the first organization (created if none exists).
 *   npm run create-admin -- --username admin [--email admin@example.com]
 * The password is read from ADMIN_PASSWORD or prompted for (input hidden).
 */
function promptHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const out = rl as unknown as { _writeToOutput: (s: string) => void; output: NodeJS.WriteStream };
    out._writeToOutput = (s: string) => {
      if (s.includes(question)) out.output.write(s);
    };
    rl.question(question, (answer) => {
      rl.close();
      process.stdout.write("\n");
      resolve(answer);
    });
  });
}

async function main() {
  const { values } = parseArgs({ options: { username: { type: "string" }, email: { type: "string" } } });
  if (!values.username) throw new Error("Usage: npm run create-admin -- --username <name> [--email <address>]");
  let password = process.env.ADMIN_PASSWORD;
  if (!password) {
    password = await promptHidden("Password: ");
    const confirm = await promptHidden("Confirm password: ");
    if (password !== confirm) throw new Error("Passwords do not match");
  }
  await migrate(pool);
  await createSystemAdmin({ username: values.username, password, email: values.email?.toLowerCase() ?? null });
  console.log(`Created system administrator "${values.username}"`);
}

main()
  .catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
