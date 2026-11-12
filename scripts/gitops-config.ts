import { config as dotenv } from "dotenv";
import { parseArgs } from "node:util";
import {
  GitOpsConfigurationError,
  loadGitOpsConfig,
  applyGitOpsEnvironment,
  requiredGitOpsSetupFields,
  resolveGitOpsApp,
} from "../src/lib/gitops/config.mjs";
import { GitOpsError } from "../src/lib/gitops/contracts";
import { SecretBoxError } from "../src/lib/crypto/secret-box";
dotenv({ path: ".env.local", quiet: true });
dotenv({ quiet: true });

async function main() {
  const args = parseArgs({
    allowPositionals: true,
    options: { config: { type: "string" }, help: { type: "boolean" } },
  });
  const command = args.positionals[0] ?? "validate";
  if (args.values.help) {
    console.log(
      "gitops:config [validate|apply] [--config path]\nvalidate is offline and opens no database. apply uses the configured operator's actual RBAC assignments.",
    );
    return;
  }
  if (args.positionals.length > 1 || !["validate", "apply"].includes(command))
    throw new GitOpsConfigurationError(
      "Use validate or apply, with optional --config path",
    );
  const loaded = loadGitOpsConfig({
    configPath: args.values.config,
    required: true,
  });
  if (!loaded)
    throw new GitOpsConfigurationError(
      "Copy gitops.config.example.yaml to gitops.config.yaml first",
    );
  const missing = requiredGitOpsSetupFields(loaded.config);
  if (command === "validate") {
    console.log("GitOps configuration is valid.");
    if (missing.length)
      console.log(`Required before apply: ${missing.join(", ")}`);
    console.log(
      "App credentials must be supplied through secret references or already configured in the UI. No database or GitHub changes were made.",
    );
    return;
  }
  if (missing.length)
    throw new GitOpsConfigurationError(
      `Complete these fields before apply: ${missing.join(", ")}`,
    );
  process.env.GITOPS_CONFIG_FILE = loaded.filePath;
  applyGitOpsEnvironment(loaded);
  resolveGitOpsApp(loaded); // Reject incomplete secret references before opening a database.
  // Dynamic imports ensure validation and incomplete templates never open the application database.
  const [
    { prisma },
    { ROLE_ROW_SELECT, assignmentsFromRows },
    { contextRole },
    { applyGitOpsConfiguration },
  ] = await Promise.all([
    import("../src/lib/db"),
    import("../src/lib/access/assignments"),
    import("../src/lib/access"),
    import("../src/services/gitops/configuration"),
  ]);
  try {
    const user = await prisma.user.findUnique({
      where: { email: loaded.config.scope.operatorEmail.toLowerCase() },
      select: {
        id: true,
        disabledAt: true,
        roles: { select: ROLE_ROW_SELECT },
      },
    });
    if (!user || user.disabledAt)
      throw new GitOpsConfigurationError(
        "scope.operatorEmail must identify an existing enabled application user",
      );
    const assignments = assignmentsFromRows(user.roles);
    const result = await applyGitOpsConfiguration(loaded, {
      userId: user.id,
      userRole: contextRole(assignments),
      assignments,
      tenantId: loaded.config.scope.tenantId,
      prisma,
    });
    console.log(JSON.stringify(result, null, 2));
    console.log(
      "Settings applied. Connect GitHub and bootstrap content through /gitops. Git-owned workflow changes appear as private change sets requiring a PR.",
    );
  } finally {
    await prisma.$disconnect();
    if ((process.env.DB_PROVIDER ?? "pglite") === "pglite") {
      const { getPgliteClient } = await import("../src/lib/db-adapter");
      await getPgliteClient().close();
    }
  }
}
main().catch((error) => {
  console.error(
    error instanceof GitOpsConfigurationError ||
      error instanceof GitOpsError ||
      error instanceof SecretBoxError
      ? error.message
      : "GitOps configuration failed. Check the database migration, operator permissions, branches and GitHub credentials.",
  );
  process.exitCode = 1;
});
