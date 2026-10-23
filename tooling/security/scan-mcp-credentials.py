#!/usr/bin/env python3
"""Exact-value audit. Credentials are read only into this process, never argv/env/output.
Reports counts only. Source credential files and private runtime configs are intentionally
outside the forbidden scan scopes; raw images are scanned as bytes, without OCR.
"""
import argparse, json, os, stat, shlex, subprocess, sys, re, uuid, tempfile
from pathlib import Path

def private_bytes(file, strict=False):
    p=Path(file)
    if not p.is_absolute() or p.resolve()!=p: raise ValueError()
    fd=os.open(p,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
    try:
        s=os.fstat(fd)
        if not stat.S_ISREG(s.st_mode) or s.st_nlink!=1 or s.st_mode&0o077 or s.st_size>65536: raise ValueError()
        if strict and (stat.S_IMODE(s.st_mode)!=0o600 or s.st_uid!=os.getuid()):raise ValueError()
        return os.read(fd,65537)
    finally: os.close(fd)

def selected_env(data,key):
    for line in data.decode('utf8').splitlines():
        line=line.strip()
        if line.startswith('export '): line=line[7:]
        if not line.startswith(key+'='): continue
        values=shlex.split(line,comments=True,posix=True)
        if len(values)!=1: raise ValueError()
        return values[0].split('=',1)[1]
    raise ValueError()

def scan_stream(stream,values):
    variants={label:list(set([value,json.dumps(value,ensure_ascii=False)[1:-1]])) for label,value in values.items()}
    needles={label:[v.encode() for v in vv if v] for label,vv in variants.items()}
    maximum=max(len(v) for vv in needles.values() for v in vv);carry=b'';counts={label:0 for label in values}
    while True:
        chunk=stream.read(1024*1024)
        if not chunk: break
        data=carry+chunk
        for label,patterns in needles.items():
            for pattern in patterns:
                start=0
                while True:
                    start=data.find(pattern,start)
                    if start<0:break
                    if start+len(pattern)>len(carry):counts[label]+=1
                    start+=len(pattern)
        carry=data[-(maximum-1):] if maximum>1 else b''
    return counts

def scan_file(file,values):
    # No blocking device/FIFO reads or symlink races in broad log/worktree scans.
    fd=os.open(file,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
    with os.fdopen(fd,'rb') as stream:
        if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):raise ValueError()
        return scan_stream(stream,values)

def audit_status(scopes):
    if any(s.get('required',True) and not s.get('available',True) or s['readErrors'] for s in scopes.values()):return 'incomplete'
    return 'legacy_hits' if any(s['matchingFiles'] for s in scopes.values()) else 'passed'

def git_objects(root):
    # Even ref names are untrusted: Git diagnostics must never reach tool output.
    listed=subprocess.check_output(['git','rev-list','--objects','--all','--reflog'],cwd=root,stderr=subprocess.DEVNULL).splitlines()
    return list(dict.fromkeys(line.split(b' ',1)[0] for line in listed))

def scan_tree(base,values,exclude=(),required=True):
    scope={'files':0,'matchingFiles':0,'readErrors':0,'available':base.exists(),'required':required,'occurrences':{label:0 for label in values}}
    if not scope['available']:return scope
    def inaccessible(_error):scope['readErrors']+=1
    for directory,dirs,files in os.walk(base,followlinks=False,onerror=inaccessible):
        dirs[:]=[d for d in dirs if d not in exclude and not Path(directory,d).is_symlink()]
        for filename in files:
            p=Path(directory,filename)
            try:
                if p.is_symlink():continue
                counts=scan_file(p,values)
                scope['files']+=1;scope['matchingFiles']+=int(any(counts.values()))
                for label,n in counts.items():scope['occurrences'][label]+=n
            except (OSError,ValueError):scope['readErrors']+=1
    return scope

def account_values(directory):
    root=Path(directory)
    def private_directory(path):
        metadata=path.lstat()
        if not stat.S_ISDIR(metadata.st_mode) or stat.S_IMODE(metadata.st_mode)!=0o700 or metadata.st_uid!=os.getuid():raise ValueError()
    if not root.is_absolute() or root.resolve()!=root:raise ValueError()
    private_directory(root)
    entries=sorted(root.iterdir())
    if not entries:raise ValueError()
    values={}
    for index,folder in enumerate(entries):
        private_directory(folder)
        if str(uuid.UUID(folder.name))!=folder.name:raise ValueError()
        file=folder/'account.json'
        metadata=file.lstat()
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_uid!=os.getuid() or stat.S_IMODE(metadata.st_mode)!=0o600:raise ValueError()
        account=json.loads(private_bytes(file,strict=True))
        if set(account)!=set(['schema','accountId','auth','container']) or account['schema']!='account_credentials@1' or account['accountId']!=folder.name:raise ValueError()
        for key in ('auth','container'):
            value=account[key]
            if not isinstance(value,str) or not re.fullmatch('[A-Za-z0-9_-]{43}',value):raise ValueError()
            values['account_'+str(index)+'_'+key]=value
    return values,len(entries)

def publish_report(file,report):
    target=Path(file)
    if not target.is_absolute():raise ValueError()
    try:
        metadata=target.lstat()
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink!=1 or metadata.st_uid!=os.getuid():raise ValueError()
    except FileNotFoundError:pass
    fd,temporary=tempfile.mkstemp(prefix='reinlab-scan-',dir=target.parent.resolve())
    try:
        with os.fdopen(fd,'w') as output:
            output.write(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
            output.flush();os.fsync(output.fileno())
        os.replace(temporary,target)
    finally:
        if os.path.exists(temporary):os.unlink(temporary)

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--root',required=True)
    parser.add_argument('--deepseek-file',required=True)
    parser.add_argument('--signing-key-file',required=True)
    parser.add_argument('--capability-fixture-file',required=True)
    parser.add_argument('--output',required=True)
    parser.add_argument('--task-prefix',default='reinlab-p111-')
    parser.add_argument('--account-credential-root')
    args=parser.parse_args()
    root=Path(args.root).resolve()
    values={'deepseek_key':selected_env(private_bytes(args.deepseek_file),'DEEPSEEK_API_KEY'),'mcp_signing_key':private_bytes(args.signing_key_file).decode().strip(),'mcp_fixture_token':json.loads(private_bytes(args.capability_fixture_file))['token']}
    account_file_count=0
    if args.account_credential_root:
        extra,account_file_count=account_values(args.account_credential_root)
        values.update(extra)
    if not args.task_prefix or '/' in args.task_prefix or not args.task_prefix.startswith('reinlab-'):raise ValueError()
    if any(len(v)<16 for v in values.values()):raise ValueError()
    scopes={}
    def fresh():return {'files':0,'matchingFiles':0,'readErrors':0,'available':True,'required':True,'occurrences':{label:0 for label in values}}
    def add(scope,counts):
        scope['files']+=1;scope['matchingFiles']+=int(any(counts.values()))
        for label,n in counts.items():scope['occurrences'][label]+=n
    def tree(name,base,exclude=(),required=True):
        scopes[name]=scan_tree(base,values,exclude,required)
    tree('worktree',root,('.git','node_modules'))
    tree('evidence',root/'evidence')
    # Every unique Git object from refs/reflogs, including commit messages and tree paths.
    history=fresh();scopes['git_history']=history
    objects=git_objects(root)
    proc=subprocess.Popen(['git','cat-file','--batch'],cwd=root,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL)
    class Limited:
        def __init__(self,stream,left):self.stream,self.left=stream,left
        def read(self,n):
            if not self.left:return b''
            data=self.stream.read(min(n,self.left));self.left-=len(data)
            if not data:raise ValueError()
            return data
    try:
        for oid in objects:
            proc.stdin.write(oid+b'\n');proc.stdin.flush()
            header=proc.stdout.readline().split()
            if len(header)!=3:raise ValueError()
            size=int(header[2]);limited=Limited(proc.stdout,size)
            counts=scan_stream(limited,values)
            add(history,counts)
            if proc.stdout.read(1)!=b'\n':raise ValueError()
    finally:
        proc.stdin.close();proc.stdout.close();proc.wait()
    home=Path.home();codex=Path(os.environ.get('CODEX_HOME',str(home/'.codex')))
    for name,base in [('codex_log',codex/'log'),('codex_logs',codex/'logs'),('codex_sessions',codex/'sessions'),('shell_snapshots',codex/'shell_snapshots')]:tree(name,base,required=name not in ('codex_log','codex_logs'))
    local=fresh();scopes['local_task_logs']=local
    for p in Path('/tmp').glob(args.task_prefix+'*'):
        if not p.is_file() or p.is_symlink():continue
        try:
            add(local,scan_file(p,values))
        except (OSError,ValueError):local['readErrors']+=1
    report={'schemaVersion':1,'method':'exact raw values + JSON escaped variants; streaming byte scan','selectedValues':len(values),'accountCredentialFiles':account_file_count,'scopes':scopes,'excluded':['third-party node_modules','protected source credential/config files outside scan scopes'],'limitations':['No OCR of historic screenshots; byte scan only','Only selected current values are tested; rotated historic keys and all historic capability tokens are not claimed covered','Process ENV absence is verified separately, not inferred from this byte scan','codex/log and codex/logs are optional layouts; availability is reported explicitly, sessions and shell_snapshots are required'],'status':audit_status(scopes)}
    publish_report(args.output,report)
    print(json.dumps({'status':report['status'],'scopes':{k:{key:v[key] for key in ('matchingFiles','readErrors','available','required')} for k,v in scopes.items()}}))
if __name__=="__main__":
    try:main()
    except Exception:
        print(json.dumps({'code':'CREDENTIAL_SCAN_FAILED'}));sys.exit(1)
