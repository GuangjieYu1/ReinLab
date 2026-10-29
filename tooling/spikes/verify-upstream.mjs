import {readFile} from 'node:fs/promises';import path from 'node:path';import {createHash} from 'node:crypto';
const root=process.argv[2];if(!root)throw Error('请传只读OpenScience源码目录');
const manifest=JSON.parse(await readFile('evidence/P1-09/source-manifest.json','utf8')),excerpt=JSON.parse(await readFile('evidence/P1-09/source-excerpts.json','utf8'));
let checked=0;for(const file of manifest.sources){const content=await readFile(path.join(root,file.path),'utf8');if(createHash('sha256').update(content).digest('hex')!==file.sha256)throw Error('UPSTREAM_SOURCE_CHANGED');for(const e of excerpt.excerpts.filter(e=>e.path===file.path))if(!content.includes(e.text))throw Error('UPSTREAM_EXCERPT_CHANGED');checked++;}console.log(JSON.stringify({checked,changed:0}));
