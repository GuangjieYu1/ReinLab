import ts from 'typescript';
import {writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
const base='24b44c11cc335938598adc44983ed4c04635d57f';
const formatted='179243692ed47097f0bed022e560f74acfd09274';
const paths=['services/control/src/bridge/openscience/role-project.ts','plugins/reinlab-os-plugin/index.js'];
const sha=value=>createHash('sha256').update(value).digest('hex');
const ignored=new Set(['pos','end','id','modifierFlagsCache','transformFlags','multiLine','hasTrailingComma','fileName','text','originalFileName','path','resolvedPath','identifierCount','nodeCount','symbolCount','parseDiagnostics','bindDiagnostics','bindSuggestionDiagnostics','lineMap','version','endFlowNode','flowNode']);
function canonical(node){
 if(ts.isParenthesizedExpression(node))return canonical(node.expression);
 if(ts.isParenthesizedTypeNode(node))return canonical(node.type);
 const fields={};
 for(const key of Object.keys(node).sort()){
  if(ignored.has(key)||key==='kind')continue;
  const value=key==='flags' ? node.flags & ~ts.NodeFlags.ContextFlags : node[key];
  if(typeof value==='string'||typeof value==='number'||typeof value==='boolean')fields[key]=value;
 }
 // Literal text is cooked by the parser (quotes/trivia do not become semantic differences).
 if(node.kind!==ts.SyntaxKind.SourceFile&&typeof node.text==='string')fields.text=node.text;
 const children=[];ts.forEachChild(node,child=>{children.push(canonical(child));});
 return {kind:ts.SyntaxKind[node.kind],fields,children};
}
function inspect(file,source){
 const ast=ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true,file.endsWith('.ts')?ts.ScriptKind.TS:ts.ScriptKind.JS);
 if(ast.parseDiagnostics.length)throw Error('PARSE_DIAGNOSTICS');
 const scanner=ts.createScanner(ts.ScriptTarget.Latest,false,file.endsWith('.ts')?ts.LanguageVariant.Standard:ts.LanguageVariant.Standard,source);
 const comments=[];for(let token=scanner.scan();token!==ts.SyntaxKind.EndOfFileToken;token=scanner.scan()){if([ts.SyntaxKind.SingleLineCommentTrivia,ts.SyntaxKind.MultiLineCommentTrivia].includes(token))comments.push(scanner.getTokenText().split('\n').map(line=>line.trim()).join('\n'));}
 return {ast:canonical(ast),comments};
}
const files=paths.map(file=>{
 const before=execFileSync('git',['show',base+':'+file],{encoding:'utf8'}),after=execFileSync('git',['show',formatted+':'+file],{encoding:'utf8'});
 const a=inspect(file,before),b=inspect(file,after);
 const beforeAst=JSON.stringify(a.ast),afterAst=JSON.stringify(b.ast);
 const astEqual=beforeAst===afterAst,commentsEqual=JSON.stringify(a.comments)===JSON.stringify(b.comments);
 if(!astEqual){writeFileSync('/tmp/reinlab-format-before-ast.json',JSON.stringify(a.ast,null,2));writeFileSync('/tmp/reinlab-format-after-ast.json',JSON.stringify(b.ast,null,2));}
 return {file,beforeSha256:sha(before),afterSha256:sha(after),beforeAstSha256:sha(beforeAst),afterAstSha256:sha(afterAst),astEqual,commentsEqual,parseErrors:0};
});
const sample=execFileSync('git',['show',base+':'+paths[0]],{encoding:'utf8'});
const same=(a,b)=>JSON.stringify(inspect(paths[0],a).ast)===JSON.stringify(inspect(paths[0],b).ast);
const sensitivity={
 literalChangeDetected:!same(sample,sample.replace("'deny'","'allow'")),
 operatorChangeDetected:!same(sample,sample.replace('!==','===')),
 declarationKindChangeDetected:!same(sample,sample.replace('const Action=','let Action=')),
 typeOnlyImportChangeDetected:!same(sample,sample.replace('import {z}', 'import type {z}')),
};
const report={baseRevision:base,formattedRevision:formatted,typescriptVersion:ts.version,formatter:'prettier@3.6.2',files,sensitivity,passed:files.every(file=>file.astEqual&&file.commentsEqual)&&Object.values(sensitivity).every(Boolean)};
writeFileSync('evidence/P1-10/format/ast-equivalence.json',JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report));if(!report.passed)process.exitCode=1;
