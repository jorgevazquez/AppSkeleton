/**
 * Bootstrap-admin safety mechanism (feature #40 — "Bootstrap-admin safety
 * mechanism to prevent permanent lockout").
 *
 * ## The lockout this closes
 *
 * `manage.ts`'s own docs describe `rbac:manage` as *self-referential*: the
 * only way to create a role, delete a role, or grant/revoke a permission is
 * through an operation gated on the caller already holding `rbac:manage`
 * (`assertCanManage`) — and `policy.ts` rule 1 is deny-by-default, with no
 * back door. `seeds/index.ts`'s default-roles seed creates the `"admin"`
 * role and grants it `rbac:manage`, but deliberately assigns that role to
 * nobody — a seed cannot know who the real operator is, and hard-coding a
 * fixed literal user id (or credential) into every deployment would just
 * trade one lockout for a well-known, universally-shared backdoor. Put the
 * two together: a freshly-seeded (or entirely unseeded) system can have an
 * `"admin"` role that grants everything and exactly zero users who hold it —
 * at which point `rbac:manage` can never be exercised by anyone, ever,
 * without a human editing the database by hand. That is the permanent
 * lockout this module exists to prevent.
 *
 * {@link ensureBootstrapAdmin} closes the gap the same way a first-run
 * wizard or a `kubeadm`/database "initial admin password" flow does:
 * whenever it is called (this plugin's `onEnable` — see `../index.ts` —
 * calls it once per plugin load) and it finds that *no* user currently
 * holds the `"admin"` role, it provisions one: a freshly-generated,
 * random user id plus an opaque bootstrap token, immediately assigned the
 * `"admin"` role (creating that role — and granting it `rbac:manage` — if
 * `seedDefaultRolesAndPermissions` hasn't run yet either, so the bootstrap
 * account is actually useful the moment it exists, not just nominally
 * "admin").
 *
 * `"admin"` is duplicated here as a plain string literal rather than
 * imported from `../seeds/index.ts`'s `DEFAULT_ROLES` — the same
 * self-containment reason `store.ts`'s `RbacDbQueryCapability` and
 * `seeds/index.ts`'s own table-name constants document for their own
 * duplicated literals: `seeds/` is a free-standing fixture tree sitting
 * alongside `src/`, not a dependency of it, and this module (like the rest
 * of `src/`) must keep working whether or not that seed ever runs.
 *
 * ## Why the token is never sent through the structured (pino) logger
 *
 * `core/logger.ts`'s secret redaction has "no opt-out": any field whose key
 * matches `password`/`secret`/`token`/`apikey`/`authorization` is
 * unconditionally replaced with `[REDACTED]` before a pino logger ever
 * serializes it, precisely so a real secret can never leak into a JSON log
 * line that might be shipped to an aggregator, SIEM, or anywhere else
 * outside this one process. Routing the bootstrap token through that
 * logger would therefore silently redact the one value this whole
 * mechanism exists to reveal. {@link createConsoleBootstrapAdminReporter}
 * bypasses the structured logger entirely and writes a plain,
 * human-readable banner straight to `console.warn` instead — the same
 * "direct console output for a human operator, not a machine-consumed log
 * line" precedent `src/cli/seed.ts` and
 * `src/plugins/database-mysql/src/migrate.ts` already establish for
 * CLI-facing, human-facing messages. Nothing about the token itself is
 * ever written to `policyStore`/`roleCatalog` either — only the *account*
 * (user id + role assignment) persists in this plugin's own state; the
 * token is handed back to the caller and to the reporter and then
 * forgotten by this module.
 *
 * ## Idempotent by construction — no separate "already ran" flag
 *
 * {@link ensureBootstrapAdmin} carries no boolean latch of its own; it
 * simply re-checks "does any `UserRole` with `roleId === "admin"` exist"
 * every time it is called. The very first successful provisioning assigns
 * the bootstrap user the `"admin"` role, so the *next* call — another
 * plugin reload, a second boot — already observes at least one admin and
 * does nothing. This is feature #40 step 2 ("disabled automatically once at
 * least one admin exists"), and it holds identically whether that first
 * admin is the bootstrap account this module created or a real one an
 * operator created through `rbac:manage` before ever touching the bootstrap
 * path. See `tests/plugins/rbac/bootstrap-admin.test.ts` for both states
 * exercised directly (feature #40 step 3).
 */
import { randomBytes } from "node:crypto";
import { ValidationError } from "../../../core/errors.js";
import type { PermissionString } from "./permission.js";
import type { Role, UserRole } from "./types.js";

/**
 * The role id this module treats as "an admin exists" — the same literal
 * `seeds/index.ts`'s `DEFAULT_ROLES[0].id` uses, duplicated (not imported)
 * for the self-containment reason explained in this file's module doc.
 */
export const BOOTSTRAP_ADMIN_ROLE_ID = "admin";

/** The permission a freshly-created `"admin"` role is granted so the bootstrap account can actually self-heal via `rbac:manage`. */
export const BOOTSTRAP_ADMIN_MANAGE_PERMISSION_ID: PermissionString = "rbac:manage";

/** The one-time credential {@link ensureBootstrapAdmin} hands back when it provisions a bootstrap admin. */
export interface BootstrapAdminCredential {
  readonly userId: string;
  readonly token: string;
}

/**
 * Storage this module needs, independent of whatever ultimately backs it —
 * mirrors `manage.ts`'s `RbacManagementStore` dependency-inversion pattern.
 * `../index.ts` wires this over the same in-memory `policyStore`/
 * `roleCatalog` state `check()` and `rbac:manage` already read/mutate, so a
 * provisioned bootstrap admin is immediately effective.
 */
export interface BootstrapAdminStore {
  listUserRoles(): Promise<readonly UserRole[]> | readonly UserRole[];
  getRole(id: string): Promise<Role | undefined> | (Role | undefined);
  createRole(role: Role): Promise<void> | void;
  assignPermissionToRole(roleId: string, permissionId: PermissionString): Promise<void> | void;
  assignRoleToUser(userId: string, roleId: string): Promise<void> | void;
}

/** Generates the bootstrap account's identity/secret. Injected so tests can assert on deterministic values instead of real randomness. */
export interface BootstrapAdminIdSource {
  generateUserId(): string;
  generateToken(): string;
}

/** Cryptographically random user id / token pair — the default {@link BootstrapAdminIdSource} used outside tests. */
export const defaultBootstrapAdminIdSource: BootstrapAdminIdSource = {
  generateUserId: () => `bootstrap-admin-${randomBytes(6).toString("hex")}`,
  generateToken: () => randomBytes(32).toString("hex"),
};

/** Receives the plaintext credential exactly once, at the moment it is provisioned — see this file's module doc for why this is never the structured logger. */
export interface BootstrapAdminReporter {
  reportProvisioned(credential: BootstrapAdminCredential): void;
}

const BANNER_RULE = "=".repeat(78);

/**
 * The production {@link BootstrapAdminReporter}: a plain-text banner on
 * `console.warn` (or `write`, if a caller — e.g. a test — supplies one), not
 * the structured pino logger. `write` receives the whole multi-line banner
 * as a single string so a test double can assert on it as one value.
 */
export function createConsoleBootstrapAdminReporter(
  write: (line: string) => void = (line) => console.warn(line),
): BootstrapAdminReporter {
  return {
    reportProvisioned({ userId, token }) {
      write(
        [
          "",
          BANNER_RULE,
          '  BOOTSTRAP ADMIN PROVISIONED — no user currently holds the "admin" role.',
          "  This credential is shown ONLY ONCE. Copy it now — it will not be logged again.",
          "",
          `  user id : ${userId}`,
          `  token   : ${token}`,
          "",
          "  Use it to authenticate, create a real admin account through rbac:manage,",
          "  then remove this bootstrap account — it currently holds full rbac:manage access.",
          BANNER_RULE,
          "",
        ].join("\n"),
      );
    },
  };
}

/**
 * Feature #40 step 1 + step 2: if zero users currently hold the `"admin"`
 * role, provision one (creating the `"admin"` role itself, with the
 * `rbac:manage` grant, if it doesn't exist yet) and report the credential
 * exactly once via `reporter`. If at least one user already holds
 * `"admin"` — whether from a prior call, a real operator-created admin, or
 * data hydrated from persistent storage — this is a no-op and returns
 * `undefined`: the bootstrap path is, by construction, already disabled
 * (see this file's module doc, "Idempotent by construction").
 */
export async function ensureBootstrapAdmin(
  store: BootstrapAdminStore,
  reporter: BootstrapAdminReporter,
  idSource: BootstrapAdminIdSource = defaultBootstrapAdminIdSource,
): Promise<BootstrapAdminCredential | undefined> {
  const userRoles = await store.listUserRoles();
  const hasAdmin = userRoles.some((userRole) => userRole.roleId === BOOTSTRAP_ADMIN_ROLE_ID);
  if (hasAdmin) {
    return undefined;
  }

  const existingRole = await store.getRole(BOOTSTRAP_ADMIN_ROLE_ID);
  if (!existingRole) {
    await store.createRole({
      id: BOOTSTRAP_ADMIN_ROLE_ID,
      name: "Administrator",
      description: "Full system access, including managing roles and permissions.",
    });
  }

  try {
    await store.assignPermissionToRole(
      BOOTSTRAP_ADMIN_ROLE_ID,
      BOOTSTRAP_ADMIN_MANAGE_PERMISSION_ID,
    );
  } catch (error) {
    // The "admin" role may already hold this grant (e.g. seeded, or
    // hydrated from persistent storage) — that is success, not failure,
    // for this module's purposes; any other error still propagates.
    if (!(error instanceof ValidationError)) {
      throw error;
    }
  }

  const credential: BootstrapAdminCredential = {
    userId: idSource.generateUserId(),
    token: idSource.generateToken(),
  };
  await store.assignRoleToUser(credential.userId, BOOTSTRAP_ADMIN_ROLE_ID);

  reporter.reportProvisioned(credential);
  return credential;
}
