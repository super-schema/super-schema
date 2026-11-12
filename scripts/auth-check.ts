import { config } from "dotenv";
import { checkSsoConfiguration } from "../src/lib/auth/sso-configuration";

const args = process.argv.slice(2);
if (args.some((arg) => arg !== "--production")) {
  console.error("Usage: npm run auth:check -- [--production]");
  process.exitCode = 1;
} else {
  const mode = args.includes("--production") ? "production" : process.env.NODE_ENV || "development";
  // Same file precedence as Next.js; exported environment variables take precedence over files.
  config({ path: [`.env.${mode}.local`, ...(mode === "test" ? [] : [".env.local"]), `.env.${mode}`, ".env"], quiet: true });
  const report = checkSsoConfiguration({ ...process.env, NODE_ENV: mode });
  if (report.problems.length) {
    console.error(`SSO configuration is incomplete:\n- ${report.problems.join("\n- ")}`);
    process.exitCode = 1;
  } else {
    console.log("SSO configuration passed (offline; identity-provider registration still needs a tenant sign-in).");
    for (const provider of report.providers) {
      console.log(`${provider.id}: ${provider.callbackUrl}`);
      console.log(`  Domains: ${provider.allowedDomains.join(", ") || "unrestricted"}; first-login email linking: ${provider.linkExistingUsers ? "enabled" : "disabled"}`);
    }
  }
}
