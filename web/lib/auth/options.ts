import type { NextAuthOptions } from "next-auth";
import Apple from "next-auth/providers/apple";
import AzureAD from "next-auth/providers/azure-ad";
import Credentials from "next-auth/providers/credentials";
import GitHub from "next-auth/providers/github";
import GitLab from "next-auth/providers/gitlab";
import Google from "next-auth/providers/google";
import { secureCookies, sessionTtlSeconds } from "./config";
import { profileEmail, profileImage, profileName, isVerifiedOAuthEmail } from "./oauth";
import {
  appleConfigured,
  azureAdConfigured,
  githubConfigured,
  gitlabConfigured,
  googleConfigured,
} from "./oauth-providers";
import { hashPassword, verifyPassword } from "./password";
import { clientAddress, rateLimit } from "./rate-limit";
import { findAuthUserByEmail, upsertOAuthUser } from "./store";
import { normalizeEmail, readPasswordInput } from "./validation";

let dummyHash: Promise<string> | null = null;

// NextAuth v4 treats an empty NEXTAUTH_URL as an invalid origin. Treat it as
// unset so it can fall back to the request host (AUTH_TRUST_HOST).
if (process.env.NEXTAUTH_URL !== undefined && !process.env.NEXTAUTH_URL.trim()) {
  delete process.env.NEXTAUTH_URL;
}

function dummyPasswordHash(): Promise<string> {
  dummyHash ??= hashPassword("factory-dummy-password-never-used");
  return dummyHash;
}

const providers: NextAuthOptions["providers"] = [];

if (googleConfigured()) {
  providers.push(
    Google({
      clientId: process.env.AUTH_GOOGLE_ID!,
      clientSecret: process.env.AUTH_GOOGLE_SECRET!,
    }),
  );
}
if (githubConfigured()) {
  providers.push(
    GitHub({
      clientId: process.env.AUTH_GITHUB_ID!,
      clientSecret: process.env.AUTH_GITHUB_SECRET!,
    }),
  );
}
if (appleConfigured()) {
  providers.push(
    Apple({
      clientId: process.env.AUTH_APPLE_ID!,
      clientSecret: process.env.AUTH_APPLE_SECRET!,
    }),
  );
}
if (azureAdConfigured()) {
  providers.push(
    AzureAD({
      clientId: process.env.AUTH_AZURE_AD_ID!,
      clientSecret: process.env.AUTH_AZURE_AD_SECRET!,
      tenantId: process.env.AUTH_AZURE_AD_TENANT_ID || "common",
    }),
  );
}
if (gitlabConfigured()) {
  providers.push(
    GitLab({
      clientId: process.env.AUTH_GITLAB_ID!,
      clientSecret: process.env.AUTH_GITLAB_SECRET!,
    }),
  );
}

providers.push(
  Credentials({
    credentials: {
      email: { label: "Email", type: "email" },
      password: { label: "Contraseña", type: "password" },
    },
    async authorize(credentials, request) {
      try {
        const email = normalizeEmail(credentials?.email);
        const password = readPasswordInput(credentials?.password);
        const ip = clientAddress(request);

        const ipLimit = rateLimit(`login:ip:${ip}`, 20, 10 * 60_000);
        if (!ipLimit.allowed) return null;
        const emailLimit = rateLimit(`login:email:${email}`, 5, 10 * 60_000);
        if (!emailLimit.allowed) return null;

        const user = await findAuthUserByEmail(email);
        // Always run the KDF so a missing account and a wrong password look alike.
        const passwordHash = user?.passwordHash ?? (await dummyPasswordHash());
        const valid = await verifyPassword(password, passwordHash);
        if (!user || !user.passwordHash || !valid) return null;

        return {
          id: user.id,
          email: user.email,
          name: user.name,
          image: user.image ?? null,
        };
      } catch {
        return null;
      }
    },
  }),
);

async function applyUserToToken(
  token: Record<string, unknown>,
  user: { id: string; email?: string | null; name?: string | null; image?: string | null },
): Promise<void> {
  token.uid = user.id;
  token.email = user.email ?? "";
  token.name = user.name ?? "";
  token.picture = user.image ?? null;
}

export const authOptions: NextAuthOptions = {
  secret:
    process.env.NEXTAUTH_SECRET?.trim() ||
    process.env.AUTH_SECRET?.trim() ||
    process.env.WEB_AUTH_SECRET?.trim(),
  session: {
    strategy: "jwt",
    maxAge: sessionTtlSeconds(),
  },
  useSecureCookies: secureCookies(),
  pages: {
    signIn: "/login",
    error: "/login",
  },
  providers,
  callbacks: {
    async signIn({ account, profile }) {
      if (account?.provider === "credentials") return true;
      if (!account) return false;
      return isVerifiedOAuthEmail(account.provider, profile);
    },

    async jwt({ token, user, account, profile }) {
      if (account?.provider === "credentials" && user) {
        await applyUserToToken(token as Record<string, unknown>, user);
        return token;
      }

      if (account && account.provider !== "credentials") {
        const email = profileEmail(profile);
        if (!email || !account.providerAccountId) {
          throw new Error("El proveedor OAuth no devolvió un email verificado.");
        }
        const resolved = await upsertOAuthUser({
          provider: account.provider,
          providerAccountId: account.providerAccountId,
          email,
          name: profileName(profile, email),
          image: profileImage(profile),
        });
        await applyUserToToken(token as Record<string, unknown>, resolved);
      }

      return token;
    },

    async session({ session, token }) {
      const uid = (token as Record<string, unknown>).uid;
      if (session.user) {
        session.user.id = typeof uid === "string" ? uid : token.sub ?? "";
        session.user.email = token.email ?? "";
        session.user.name = token.name ?? "";
        session.user.image =
          typeof token.picture === "string" ? token.picture : null;
      }
      return session;
    },

    async redirect({ url, baseUrl }) {
      if (url.startsWith("/")) return `${baseUrl}${url}`;
      try {
        if (new URL(url).origin === baseUrl) return url;
      } catch {
        // Fall through to the safe default.
      }
      return baseUrl;
    },
  },
};
