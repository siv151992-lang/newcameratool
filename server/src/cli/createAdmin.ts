import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import { pool } from "../db/pool.js";
import { migrate } from "../db/migrate.js";
import { createUser } from "../services/userService.js";

/**
 * Creates an administrator account.
 *   npm run create-admin -- --username admin
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
  const { values } = parseArgs({ options: { username: { type: "string" }, role: { type: "string", default: "admin" } } });
  if (!values.username) throw new Error("Usage: npm run create-admin -- --username <name> [--role admin|operator|viewer]");
  const role = values.role as "admin" | "operator" | "viewer";
  if (!["admin", "operator", "viewer"].includes(role)) throw new Error("--role must be admin, operator or viewer");
  let password = process.env.ADMIN_PASSWORD;
  if (!password) {
    password = await promptHidden("Password: ");
    const confirm = await promptHidden("Confirm password: ");
    if (password !== confirm) throw new Error("Passwords do not match");
  }
  await migrate(pool);
  await createUser({ username: values.username, password, role }, null);
  console.log(`Created ${role} user "${values.username}"`);
}

main()
  .catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
