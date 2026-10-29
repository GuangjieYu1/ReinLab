import ts from 'typescript';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const sdk = (spec: string) => /(?:^|[/:])@synsci\/sdk(?:[/@]|$)/.test(spec.replaceAll('\\', '/'));
const server = (spec: string) => /^@reinlab\/(control|worker|os-plugin)(\/|$)/.test(spec);
function denied(file: string, spec: string): boolean {
  if (spec.startsWith('file:') || spec.includes('%')) return true;
  if (['module', 'node:module', 'vm', 'node:vm'].includes(spec)) return true;
  const resolved = spec.startsWith('.') ? path.posix.normalize(path.posix.join(path.posix.dirname(file), spec)) : spec;
  if (resolved === '.artifacts' || resolved.startsWith('.artifacts/')) return true;
  if (sdk(spec)) return true;
  if (file.startsWith('packages/contracts/')) return spec !== 'zod' && !spec.startsWith('zod/') && !(spec.startsWith('.') && resolved.startsWith('packages/contracts/'));
  if (file.startsWith('src/')) return spec.startsWith('/') || spec.startsWith('file:') || server(spec) || spec.startsWith('@synsci/') || (spec.startsWith('.') && !resolved.startsWith('src/') && !resolved.startsWith('packages/contracts/'));
  return false;
}
export function checkSource(file: string, source: string, resolve?: (spec: string) => string | undefined): string[] {
  const out: string[] = [];
  // Only the byte-identical, reviewed user-provided test loader needs variable
  // imports for Playwright and its 17 scenarios. Production and changed loaders
  // retain the ordinary static import rule; literal SDK imports are still checked.
  const legacyLoader = file === 'e2e/legacy/run.mjs' && createHash('sha256').update(source).digest('hex') === '2614dbd898d96c9fad6366a94a15d36ddac486c610eb7b5ad34763a570b134b9';
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  // Bind the isolated file without Node ambient globals: local UI fields named
  // `module` are valid; the CommonJS loader must never escape static checking.
  let checker: ts.TypeChecker | undefined;
  function bound(node: ts.Identifier) {
    if (!checker) {
      const options: ts.CompilerOptions = { noLib: true, noResolve: true, target: ts.ScriptTarget.Latest };
      const host = ts.createCompilerHost(options);
      host.getSourceFile = name => name === file ? tree : undefined;
      checker = ts.createProgram([file], options, host).getTypeChecker();
    }
    return Boolean(checker.getSymbolAtLocation(node)?.declarations?.some(declaration => {
      for (let ancestor: ts.Node | undefined = declaration; ancestor; ancestor = ancestor.parent) {
        if (ts.canHaveModifiers(ancestor) && ts.getModifiers(ancestor)?.some(m => m.kind === ts.SyntaxKind.DeclareKeyword)) return false;
        if ((ts.isImportClause(ancestor) || ts.isImportSpecifier(ancestor)) && ancestor.isTypeOnly) return false;
      }
      return (ts.isVariableDeclaration(declaration) && Boolean(declaration.initializer)) || ts.isParameter(declaration) || ts.isFunctionDeclaration(declaration) || ts.isClassDeclaration(declaration) || ts.isImportClause(declaration) || ts.isImportSpecifier(declaration) || ts.isNamespaceImport(declaration);
    }));
  }
  function check(node: ts.Node, target: ts.Node | undefined) {
    if (!target || !ts.isStringLiteralLike(target)) { if (!legacyLoader) out.push(`${file}: 禁止无法静态验证的模块导入`); return; }
    if (denied(file, target.text)) out.push(`${file}:${tree.getLineAndCharacterOfPosition(node.getStart()).line + 1}: 禁止依赖 ${target.text}`);
    const identity = resolve?.(target.text);
    if (identity && ((sdk(identity)) || (file.startsWith('src/') && /^(services|plugins)\//.test(identity)) || (file.startsWith('packages/contracts/') && !identity.startsWith('packages/contracts/') && !/(?:^|\/)node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?zod\//.test(identity)))) out.push(`${file}: 导入解析后越界 ${target.text}`);
  }
  function visit(node: ts.Node) {
    if (ts.isIdentifier(node) && ['getBuiltinModule', 'eval', 'Function'].includes(node.text)) out.push(`${file}: 禁止无法静态校验的模块加载入口 ${node.text}`);
    const propertyName = ts.isIdentifier(node) && ((ts.isPropertyAccessExpression(node.parent) && node.parent.name === node) || ((ts.isPropertyAssignment(node.parent) || ts.isPropertySignature(node.parent)) && node.parent.name === node));
    if (ts.isIdentifier(node) && ['module', 'global', 'globalThis', 'process'].includes(node.text) && !propertyName && !bound(node)) {
      let expression: ts.Node = node;
      while ((ts.isParenthesizedExpression(expression.parent) || ts.isAsExpression(expression.parent) || ts.isTypeAssertionExpression(expression.parent) || ts.isNonNullExpression(expression.parent) || ts.isSatisfiesExpression(expression.parent)) && expression.parent.expression === expression) expression = expression.parent;
      const direct = ts.isPropertyAccessExpression(expression.parent) && expression.parent.expression === expression ? expression.parent.name.text : undefined;
      const allowed: Record<string, string[]> = {
        module: [], global: [],
        globalThis: ['localStorage', 'crypto', 'fetch', 'setTimeout', 'clearTimeout', 'structuredClone'],
        process: ['env', 'argv', 'pid', 'version', 'versions', 'platform', 'arch', 'cwd', 'exit', 'exitCode', 'stdout', 'stderr', 'stdin', 'on', 'once', 'off', 'hrtime', 'uptime', 'memoryUsage', 'kill', 'execPath'],
      };
      const safe = direct && allowed[node.text].includes(direct);
      if (!safe) out.push(`${file}: 禁止全局加载器来源 ${node.text} 流出静态检查`);
    }
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && ['global', 'globalThis'].includes(node.expression.text) && ['module', 'require', 'process'].includes(node.name.text)) out.push(`${file}: 禁止全局模块加载入口`);
    if (ts.isElementAccessExpression(node) && ts.isIdentifier(node.expression) && ['module', 'global', 'globalThis', 'process'].includes(node.expression.text)) out.push(`${file}: 禁止计算全局模块加载入口`);
    if (ts.isIdentifier(node) && node.text === 'require' && !(ts.isCallExpression(node.parent) && node.parent.expression === node)) out.push(`${file}: 禁止 require 别名或属性调用`);
    if (ts.isElementAccessExpression(node) && node.argumentExpression && ts.isStringLiteralLike(node.argumentExpression) && node.argumentExpression.text === 'require') out.push(`${file}: 禁止 require 属性调用`);
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) { if (node.moduleSpecifier) check(node, node.moduleSpecifier); }
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) check(node, node.moduleReference.expression);
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) check(node, node.arguments[0]);
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) check(node, node.argument.literal);
    ts.forEachChild(node, visit);
  }
  visit(tree);
  return out;
}
export function checkManifest(file: string, manifest: { dependencies?: Record<string, string>; devDependencies?: Record<string, string>; optionalDependencies?: Record<string, string> }): string[] {
  return Object.entries({ ...manifest.dependencies, ...manifest.devDependencies, ...manifest.optionalDependencies }).flatMap(([spec, version]) => {
    if (sdk(version) && spec !== '@synsci/sdk') return [`${file}: 禁止 SDK 别名 ${spec}`];
    if (file === 'services/control/package.json' && sdk(spec)) return [];
    return denied(file === 'package.json' ? 'src/package.json' : file, spec) ? [`${file}: 禁止依赖 ${spec}`] : [];
  });
}
export function checkWorkspace(root: string): string[] {
  const out: string[] = [];
  const config = ts.readConfigFile(path.join(root, 'tsconfig.json'), ts.sys.readFile);
  const options = ts.parseJsonConfigFileContent(config.config ?? {}, ts.sys, root).options;
  function walk(dir: string) {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (['node_modules', 'dist', '.git', 'evidence'].includes(e.name)) continue;
      if (path.resolve(dir) === path.resolve(root) && e.name === '.artifacts') continue;
      const full = path.join(dir, e.name), relative = path.relative(root, full).split(path.sep).join('/');
      if (e.isSymbolicLink()) { out.push(`${relative}: 源码树禁止符号链接绕过`); continue; }
      if (e.isDirectory()) walk(full);
      else if (/\.[cm]?[jt]sx?$/.test(e.name)) out.push(...checkSource(relative, fs.readFileSync(full, 'utf8'), spec => {
        const resolved = ts.resolveModuleName(spec, full, options, ts.sys).resolvedModule?.resolvedFileName;
        return resolved ? path.relative(root, resolved).split(path.sep).join('/') : undefined;
      }));
      else if (e.name === 'package.json') out.push(...checkManifest(relative, JSON.parse(fs.readFileSync(full, 'utf8'))));
    }
  }
  walk(root);
  return out;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const errors = checkWorkspace(process.cwd());
  if (errors.length) { console.error(errors.join('\n')); process.exitCode = 1; }
  else console.log('依赖边界检查通过');
}
