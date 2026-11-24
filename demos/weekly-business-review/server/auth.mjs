// Simulated Microsoft Entra ID sign-in: the account picker issues a signed session cookie.
// Production replaces this with OpenID Connect (authorization code + PKCE) against Entra ID.

import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

export const ROLES = {
  owner: "Owner",
  editor: "Editor",
  approver: "Approver",
  viewer: "Viewer",
};

/** Which roles may do what. The server checks every mutation against this table. */
export const PERMISSIONS = {
  "data.import": ["owner", "editor"],
  "data.edit": ["owner", "editor"],
  "briefing.edit": ["owner", "editor"],
  "briefing.requestReview": ["owner", "editor"],
  "briefing.comment": ["owner", "editor", "approver", "viewer"],
  "briefing.approve": ["owner", "approver"],
  "briefing.share": ["owner", "editor"],
  "report.pin": ["owner", "editor", "approver", "viewer"],
  "automation.manage": ["owner", "editor"],
  "members.manage": ["owner"],
};

export function can(role, permission) {
  return Boolean(role && PERMISSIONS[permission]?.includes(role));
}

export function createAuth(dataDir) {
  const secretPath = NodePath.join(dataDir, "session-secret");
  if (!NodeFS.existsSync(secretPath))
    NodeFS.writeFileSync(secretPath, NodeCrypto.randomBytes(32).toString("hex"));
  const secret = NodeFS.readFileSync(secretPath, "utf8");
  const sign = (value) => NodeCrypto.createHmac("sha256", secret).update(value).digest("base64url");

  return {
    cookieFor(userId) {
      const value = `${userId}.${Date.now()}`;
      return `wbr_session=${value}.${sign(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800`;
    },
    clearCookie: "wbr_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0",
    userIdFrom(request) {
      const cookie = (request.headers.cookie ?? "")
        .split(";")
        .map((part) => part.trim())
        .find((part) => part.startsWith("wbr_session="));
      if (!cookie) return null;
      const raw = cookie.slice("wbr_session=".length);
      const cut = raw.lastIndexOf(".");
      const value = raw.slice(0, cut);
      const expected = Buffer.from(sign(value));
      const given = Buffer.from(raw.slice(cut + 1));
      if (expected.length !== given.length || !NodeCrypto.timingSafeEqual(expected, given))
        return null;
      return value.split(".")[0];
    },
  };
}
