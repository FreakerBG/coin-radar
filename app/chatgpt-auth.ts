import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { OWNER_USER_ID, SESSION_COOKIE, verifyOwnerSession } from "./owner-auth";

export type ChatGPTUser = {
  userId: string;
  displayName: string;
  email: string;
  fullName: string | null;
};

const USER_ID_HEADER = "oai-authenticated-user-id";
const USER_EMAIL_HEADER = "oai-authenticated-user-email";
const USER_FULL_NAME_HEADER = "oai-authenticated-user-full-name";
const USER_FULL_NAME_ENCODING_HEADER =
  "oai-authenticated-user-full-name-encoding";
const PERCENT_ENCODED_UTF8 = "percent-encoded-utf-8";
const SIGN_IN_PATH = "/signin-with-chatgpt";
const SIGN_OUT_PATH = "/signout-with-chatgpt";
const CALLBACK_PATH = "/callback";

// oai-authenticated-user-* headers are trustworthy only because OpenAI Sites' private front door
// sets them itself, after Sign in with ChatGPT, and the Site cannot be reached without it. The
// isolated Vercel build (next.config.ts) has no such front door and is publicly reachable, so a
// visitor there can set these headers directly and pick any identity. Never honor them off Sites.
function runsOutsideSites(): boolean {
  return typeof process !== "undefined" && Boolean(process.env?.VERCEL);
}

// Reads one cookie by name from the request's raw Cookie header. Deliberately not next/headers'
// cookies() API: that helper is unavailable in some request contexts this module is called from, and
// parsing the header directly keeps this identical to how the rest of this module already reads
// `headers()` for the Sites path.
function readCookie(cookieHeader: string | null, name: string): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      return null;
    }
  }
  return null;
}

// Off Sites (the Vercel+Turso deployment), identity comes only from the owner-auth session cookie
// (app/owner-auth.ts) - a signed, expiring cookie set by POST /api/auth/login after verifying the
// owner's password. A valid cookie resolves to a fixed synthetic user id so existing per-user storage
// (research_accounts etc., keyed by user_id) keeps working unchanged. Never the Sites headers: those
// remain forgeable off Sites (see above) and are never read at all in this branch.
async function getVercelOwnerUser(): Promise<ChatGPTUser | null> {
  const requestHeaders = await headers();
  const cookie = readCookie(requestHeaders.get("cookie"), SESSION_COOKIE);
  const userId = verifyOwnerSession(cookie);
  if (!userId) return null;
  return { userId, displayName: "Owner", email: `${OWNER_USER_ID}@vercel.local`, fullName: null };
}

export async function getChatGPTUser(): Promise<ChatGPTUser | null> {
  if (runsOutsideSites()) return getVercelOwnerUser();
  const requestHeaders = await headers();
  const userId = requestHeaders.get(USER_ID_HEADER);
  const email = requestHeaders.get(USER_EMAIL_HEADER);
  if (!userId || !email) return null;

  const encodedFullName = requestHeaders.get(USER_FULL_NAME_HEADER);
  const fullName =
    encodedFullName &&
    requestHeaders.get(USER_FULL_NAME_ENCODING_HEADER) === PERCENT_ENCODED_UTF8
      ? safeDecodeURIComponent(encodedFullName)
      : null;

  return {
    userId,
    displayName: fullName ?? email,
    email,
    fullName,
  };
}

export async function requireChatGPTUser(
  returnTo: string,
): Promise<ChatGPTUser> {
  const user = await getChatGPTUser();
  if (user) return user;

  redirect(chatGPTSignInPath(returnTo));
}

export function chatGPTSignInPath(returnTo: string): string {
  const safeReturnTo = safeRelativeReturnPath(returnTo);
  return `${SIGN_IN_PATH}?return_to=${encodeURIComponent(safeReturnTo)}`;
}

export function chatGPTSignOutPath(returnTo = "/"): string {
  const safeReturnTo = safeRelativeReturnPath(returnTo);
  return `${SIGN_OUT_PATH}?return_to=${encodeURIComponent(safeReturnTo)}`;
}

function safeRelativeReturnPath(value: string): string {
  if (!value.startsWith("/") || value.startsWith("//")) return "/";

  let url: URL;
  try {
    url = new URL(value, "https://app.local");
  } catch {
    return "/";
  }
  if (url.origin !== "https://app.local") return "/";
  if (isReservedAuthPath(url.pathname)) return "/";

  return `${url.pathname}${url.search}${url.hash}`;
}

function isReservedAuthPath(pathname: string): boolean {
  return (
    pathname === SIGN_IN_PATH ||
    pathname === SIGN_OUT_PATH ||
    pathname === CALLBACK_PATH
  );
}

function safeDecodeURIComponent(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}
