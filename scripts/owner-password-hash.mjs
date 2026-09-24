// Generates OWNER_PASSWORD_HASH for the Vercel+Turso deployment (app/owner-auth.ts).
//
//   npm run owner:hash
//
// The password is read from the terminal with echo turned off, confirmed once, and then discarded.
// It is deliberately impossible to pass it any other way:
//
//   - No command-line argument. An argument lands in shell history, in `ps` output for every other
//     user on the machine, and in CI logs. Passing one is refused outright rather than accepted.
//   - No environment variable, no file, nothing committed.
//   - The password is never echoed, never printed, and never written anywhere. Only the hash is
//     printed, on stdout, so it can be piped or copied into the Vercel dashboard.
//
// The hash it prints is produced by hashOwnerPassword() in app/owner-auth.ts - the same function the
// login path's verifyOwnerPassword() checks against - so what this prints is what authenticates.
// tests/owner-auth.test.mjs proves that end to end through the real POST /api/auth/login handler.
import { createInterface } from "node:readline";
import { hashOwnerPassword, MAX_PASSWORD_BYTES } from "../app/owner-auth.ts";

// Minimum length for a password that is the only thing between the public internet and this
// deployment. Not a complexity ruleset - length is what actually matters against offline attack on a
// leaked hash - just a floor that rules out the passwords people type when they are in a hurry.
const MIN_PASSWORD_LENGTH = 12;

// Reads one line from the TTY without echoing it. readline's own `output` is bypassed for the typed
// characters: the prompt is written once, then keypress echo is suppressed until the line ends, so
// nothing the operator types reaches the terminal, the scrollback or a captured log.
function readSecret(prompt) {
  return new Promise((resolve, reject) => {
    const input = process.stdin;
    if (!input.isTTY) {
      reject(new Error(
        "No terminal is attached. Run `npm run owner:hash` directly in a terminal; this script will not " +
        "read a password from a pipe, a file or an argument, so it cannot end up in a log or in shell history.",
      ));
      return;
    }
    process.stdout.write(prompt);
    const rl = createInterface({ input, output: process.stdout, terminal: true });
    // `_writeToOutput` is how readline renders each keypress. Replacing it with a no-op for the
    // duration of this prompt is the standard way to take a password on a TTY without echo.
    rl._writeToOutput = () => {};
    rl.question("", answer => {
      rl.close();
      process.stdout.write("\n");
      resolve(answer);
    });
    rl.on("error", error => {
      rl.close();
      reject(error);
    });
  });
}

function fail(message) {
  console.error(message);
  process.exit(64);
}

async function main() {
  if (process.argv.length > 2) {
    fail(
      "owner:hash takes no arguments. A password given on the command line is recorded in shell history and " +
      "is visible to other processes; run `npm run owner:hash` with no arguments and type it at the prompt.",
    );
  }

  const password = await readSecret("Owner password (not shown): ");
  if (!password) fail("No password entered. Nothing was generated.");
  if (password.length < MIN_PASSWORD_LENGTH) {
    fail(`Password must be at least ${MIN_PASSWORD_LENGTH} characters. Nothing was generated.`);
  }
  if (Buffer.byteLength(password) > MAX_PASSWORD_BYTES) {
    fail(`Password must be at most ${MAX_PASSWORD_BYTES} bytes. Nothing was generated.`);
  }

  const confirmation = await readSecret("Confirm password (not shown): ");
  if (confirmation !== password) fail("The two entries did not match. Nothing was generated.");

  // Everything below goes to stderr so that `npm run owner:hash > hash.txt` captures the hash alone.
  console.error("");
  console.error("Set this as the OWNER_PASSWORD_HASH environment variable (Vercel project settings).");
  console.error("It is a hash, not the password: it is safe to copy, but there is no way to read the");
  console.error("password back out of it, so keep the password itself in a password manager.");
  console.error("");
  console.log(hashOwnerPassword(password));
}

main().catch(error => {
  console.error(error.message);
  process.exit(1);
});
