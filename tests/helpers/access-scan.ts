import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import ts from "typescript";

/**
 * The analyzer behind the deny-by-default scan (tests/unit/access/deny-by-default.test.ts). It reads a module's SYNTAX TREE, not its text, so
 * a guard named in a comment or a string counts for nothing, and it decides in the order the code runs: a function is guarded only when a
 * guard call comes BEFORE its first read or write (a prisma call, an imported service or core function, an outbound `fetch`).
 *
 * What counts as a guard call (the one decision every guarded call asks, `src/lib/action-context.ts`, `src/lib/access/api.ts`):
 *  - `authorize`, `authorizeTenant`, `authorizeInActiveTenant`, `authorizeActiveTenant`, `authorizeSubject`, `withApiAuth`;
 *  - `runMutation({ action, resource }, run)` (an OBJECT first argument: the older `runMutation(run)` asks no role and is not a guard);
 *  - `withOwnedTarget("<action>", target, run)` (a STRING first argument: the older `withOwnedTarget(target, run)` asks no role).
 * `requireSession()` only says who is asking (a function that stops there reads or writes with no role asked); it is not a guard on its own.
 *
 * A function also passes when it delegates, in the same module, to a function that is itself guarded (a local helper such as
 * `getServiceContext(action)`), and fails when the helper it calls reads or writes before guarding.
 */

const GUARD_CALLS = new Set([
  "authorize",
  "authorizeTenant",
  "authorizeInActiveTenant",
  "authorizeActiveTenant",
  "authorizeSubject",
  // the older actions' wire-shape wrappers of the two above (src/lib/action-context.ts)
  "guardSubject",
  "guardTarget",
  "guardActiveTenant",
  "withApiAuth",
]);

/**
 * Imports whose calls read or write: services, the database, the audit log, the *-core modules (importers that fetch and compile). The pure
 * validators of `services/events/service-guards` (`requireId`, `parseScopeTarget`) read nothing.
 */
const EFFECT_MODULES = /(^@\/services\/(?!events\/service-guards$)|(^|\/)[a-z-]*service(\.ts)?$|^@\/lib\/db$|^@\/lib\/audit$|-core$|^@\/lib\/(importers|emission|typespec-official|compiler)\/)/;

const HTTP_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);

export type FunctionReport = {
  /** The exported name (a server action's name, or the HTTP method of a route handler). */
  name: string;
  line: number;
  /** A guard call comes before the first read or write (directly or through a local helper). */
  guarded: boolean;
  /** The function reads or writes at all (directly or through a local helper). */
  hasEffect: boolean;
};

type Summary = { guarded: boolean; hasEffect: boolean };

type Local = { name: string; node: ts.Node; exported: boolean };

const isFunctionLike = (node: ts.Node | undefined): boolean =>
  !!node && (ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isFunctionDeclaration(node));

/** The declarations of a module that can be called: top-level functions and `const x = <function or call>` (a handler wrapped by `withApiAuth(...)` is a call). */
function collectLocals(sf: ts.SourceFile): Map<string, Local> {
  const locals = new Map<string, Local>();
  const exportedNames = new Set<string>();
  for (const statement of sf.statements) {
    if (ts.isExportDeclaration(statement) && !statement.isTypeOnly && !statement.moduleSpecifier && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
      for (const element of statement.exportClause.elements) if (!element.isTypeOnly) exportedNames.add((element.propertyName ?? element.name).text);
    }
  }
  for (const statement of sf.statements) {
    // `export default foo;` exports the local `foo`; `export default <expression>` is an exported function of its own, named "default".
    if (ts.isExportAssignment(statement) && !statement.isExportEquals) {
      if (ts.isIdentifier(statement.expression)) exportedNames.add(statement.expression.text);
      else locals.set("default", { name: "default", node: statement, exported: true });
    }
  }
  for (const statement of sf.statements) {
    const isExported = ts.canHaveModifiers(statement) && !!ts.getModifiers(statement)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    const isDefault = ts.canHaveModifiers(statement) && !!ts.getModifiers(statement)?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword);
    if (ts.isFunctionDeclaration(statement) && !statement.name && isDefault) {
      locals.set("default", { name: "default", node: statement, exported: true });
    } else if (ts.isFunctionDeclaration(statement) && statement.name) {
      locals.set(statement.name.text, { name: statement.name.text, node: statement, exported: isExported || exportedNames.has(statement.name.text) });
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        // `export const { GET, POST } = handlers;` exports one handler per bound name (the Auth.js route does exactly this).
        if (ts.isObjectBindingPattern(declaration.name) && declaration.initializer) {
          for (const element of declaration.name.elements) {
            if (!ts.isIdentifier(element.name)) continue;
            locals.set(element.name.text, { name: element.name.text, node: declaration, exported: isExported || exportedNames.has(element.name.text) });
          }
          continue;
        }
        if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
        const init = declaration.initializer;
        if (isFunctionLike(init) || ts.isCallExpression(init)) {
          locals.set(declaration.name.text, { name: declaration.name.text, node: declaration, exported: isExported || exportedNames.has(declaration.name.text) });
        }
      }
    }
  }
  return locals;
}

function importedFrom(sf: ts.SourceFile): Map<string, string> {
  const imports = new Map<string, string>();
  for (const statement of sf.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) || statement.importClause?.isTypeOnly) continue;
    const from = statement.moduleSpecifier.text;
    const clause = statement.importClause;
    if (!clause) continue;
    if (clause.name) imports.set(clause.name.text, from);
    if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      for (const element of clause.namedBindings.elements) if (!element.isTypeOnly) imports.set(element.name.text, from);
    }
    if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) imports.set(clause.namedBindings.name.text, from);
  }
  return imports;
}

/** The identifier a call is made on: `a` for `a()`, `prisma` for `prisma.user.findMany()`, `ns` for `ns.fn()`. */
function calleeRoot(expression: ts.Expression): string | null {
  let current: ts.Expression = expression;
  for (;;) {
    if (ts.isIdentifier(current)) return current.text;
    if (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) current = current.expression;
    else if (ts.isNonNullExpression(current) || ts.isParenthesizedExpression(current) || ts.isAwaitExpression(current)) current = current.expression;
    else return null;
  }
}

const calleeName = (expression: ts.Expression): string | null => {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  return null;
};

export function analyzeModule(text: string, fileName = "module.ts"): { useServer: boolean; functions: FunctionReport[] } {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, fileName.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const first = sf.statements[0];
  const useServer = !!first && ts.isExpressionStatement(first) && ts.isStringLiteral(first.expression) && first.expression.text === "use server";

  const locals = collectLocals(sf);
  const imports = importedFrom(sf);
  const memo = new Map<string, Summary>();
  const inProgress = new Set<string>();

  /** One call, as the order of events sees it: a guard, a read or write, or nothing. */
  function classify(call: ts.CallExpression, self: string): "guard" | "effect" | null {
    const name = calleeName(call.expression);
    const root = calleeRoot(call.expression);

    if (name === "runMutation" && root === "runMutation") return call.arguments[0] && ts.isObjectLiteralExpression(call.arguments[0]) ? "guard" : null;
    if (name === "withOwnedTarget" && root === "withOwnedTarget") {
      const argument = call.arguments[0];
      return argument && (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument)) ? "guard" : null;
    }
    if (name && root === name && GUARD_CALLS.has(name)) return "guard";

    if (root === "prisma" || root === "fetch") return "effect";
    if (root && imports.has(root) && EFFECT_MODULES.test(imports.get(root)!)) return "effect";

    // A call to a function of the same module counts as that function does (its own summary).
    if (name && root === name && locals.has(name) && name !== self) {
      const summary = summarize(name);
      if (summary.guarded) return "guard";
      return summary.hasEffect ? "effect" : null;
    }
    return null;
  }

  function summarize(name: string): Summary {
    const cached = memo.get(name);
    if (cached) return cached;
    // A cycle between local functions: judged without the call that closes it.
    if (inProgress.has(name)) return { guarded: false, hasEffect: false };
    inProgress.add(name);
    const local = locals.get(name)!;
    let firstGuard = -1;
    let firstEffect = -1;
    let index = 0;
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const kind = classify(node, name);
        if (kind === "guard" && firstGuard < 0) firstGuard = index;
        if (kind === "effect" && firstEffect < 0) firstEffect = index;
        index++;
      }
      ts.forEachChild(node, visit);
    };
    visit(local.node);
    inProgress.delete(name);
    const summary: Summary = { guarded: firstGuard >= 0 && (firstEffect < 0 || firstGuard < firstEffect), hasEffect: firstEffect >= 0 };
    memo.set(name, summary);
    return summary;
  }

  const functions: FunctionReport[] = [];
  for (const local of locals.values()) {
    if (!local.exported) continue;
    const summary = summarize(local.name);
    functions.push({ name: local.name, line: sf.getLineAndCharacterOfPosition(local.node.getStart(sf)).line + 1, ...summary });
  }
  return { useServer, functions: functions.sort((a, b) => a.line - b.line) };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// The repository
// ---------------------------------------------------------------------------------------------------------------------------------

const posix = (path: string) => path.split(sep).join("/");

export function listSourceFiles(dir: string, pattern: RegExp, found: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "generated" || name === "node_modules") continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) listSourceFiles(full, pattern, found);
    else if (pattern.test(name)) found.push(posix(relative(".", full)));
  }
  return found.sort();
}

/** `"<file>#<name>"`, the key of an allow-list or pending entry. */
export const entryKey = (file: string, name: string) => `${file}#${name}`;

export type Surface = { key: string; file: string; name: string; line: number; guarded: boolean; hasEffect: boolean; kind: "action" | "route" };

/** `src/app/api/v1/schemas/[id]/route.ts` -> `/api/v1/schemas/[id]`. */
export const routePathOf = (file: string) => file.replace(/^src\/app/, "").replace(/\/route\.ts$/, "").replace(/\/\([^/]+\)/g, "") || "/";

/** Every exported function of every "use server" module, and every HTTP handler of every `route.ts`, with whether it is guarded. */
export function scanRepository(root = "src"): Surface[] {
  const surfaces: Surface[] = [];
  for (const file of listSourceFiles(root, /\.(ts|tsx)$/)) {
    const text = readFileSync(file, "utf8");
    const isRoute = /\/route\.ts$/.test(file);
    if (!isRoute && !text.includes("use server")) continue;
    const { useServer, functions } = analyzeModule(text, file);
    if (!isRoute && !useServer) continue;
    for (const fn of functions) {
      if (isRoute && !HTTP_METHODS.has(fn.name)) continue;
      surfaces.push({ key: entryKey(isRoute ? routePathOf(file) : file, fn.name), file, name: fn.name, line: fn.line, guarded: fn.guarded, hasEffect: fn.hasEffect, kind: isRoute ? "route" : "action" });
    }
  }
  return surfaces;
}
