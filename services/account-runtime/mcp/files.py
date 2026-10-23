#!/usr/bin/env python3
"""Descriptor-relative files capability; stdin contains no capability credential.
The caller is the token-checking server. No model-supplied command or root is used.
"""
import os, sys, json, stat, fcntl, tempfile, shutil, ctypes, uuid, base64
MAX_FILE = 1024 * 1024
MAX_PATCH = 4 * MAX_FILE
DIRECTORY = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW

def denied(): raise ValueError('FILE_SCOPE_DENIED')
def parts(value):
    if not isinstance(value,str) or not value or len(value)>300 or value.startswith('/') or '\\' in value: denied()
    p=value.split('/')
    if any(not s or s in ('.','..','.git','AGENTS.md','CLAUDE.md','CONTEXT.md','openscience.json','.role-policy.json') for s in p): denied()
    return p

def directory_at(fd,name,create=False):
    if create:
        try: os.mkdir(name,0o700,dir_fd=fd)
        except FileExistsError: pass
    return os.open(name,DIRECTORY,dir_fd=fd)

def anchor(root):
    if not os.path.isabs(root) or os.path.realpath(root)!=root: denied()
    fd=os.open('/',DIRECTORY)
    try:
        for segment in root.split('/')[1:]:
            nxt=directory_at(fd,segment);os.close(fd);fd=nxt
        return fd
    except: os.close(fd);raise

def regular(fd):
    s=os.fstat(fd)
    if not stat.S_ISREG(s.st_mode) or s.st_nlink!=1: denied()
    return s

def read_at(fd,path,maximum=MAX_FILE):
    d=os.dup(fd)
    try:
        pp=parts(path)
        for name in pp[:-1]:
            nxt=directory_at(d,name);os.close(d);d=nxt
        h=os.open(pp[-1],os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=d)
        try:
            s=regular(h)
            if s.st_size>maximum: raise ValueError('FILE_TOO_LARGE')
            data=b''
            while len(data)<=maximum:
                chunk=os.read(h,min(65536,maximum+1-len(data)))
                if not chunk: break
                data+=chunk
            if len(data)>maximum: raise ValueError('FILE_TOO_LARGE')
            return data
        finally: os.close(h)
    finally: os.close(d)

def copy_tree(src,dst,budget):
    for name in os.listdir(src):
        st=os.stat(name,dir_fd=src,follow_symlinks=False)
        budget[0]+=1
        if budget[0]>4096: raise ValueError('DOSSIER_TOO_LARGE')
        if stat.S_ISDIR(st.st_mode):
            s=directory_at(src,name);d=directory_at(dst,name,True)
            try: copy_tree(s,d,budget);os.fsync(d)
            finally: os.close(s);os.close(d)
        elif stat.S_ISREG(st.st_mode) and st.st_nlink==1:
            # Copy every file through nofollow descriptors, never cp/tree link traversal.
            h=os.open(name,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=src)
            out=os.open(name,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600,dir_fd=dst)
            try:
                initial=regular(h);budget[1]+=initial.st_size
                if budget[1]>64*MAX_FILE: raise ValueError('DOSSIER_TOO_LARGE')
                total=0
                while True:
                    chunk=os.read(h,65536)
                    if not chunk: break
                    total+=len(chunk)
                    if total>initial.st_size: denied()
                    view=memoryview(chunk)
                    while view: view=view[os.write(out,view):]
                if total!=initial.st_size: denied()
                os.fsync(out)
            finally: os.close(h);os.close(out)
        else: denied()

def write_at(fd,path,content):
    pp=parts(path);d=os.dup(fd)
    try:
        for name in pp[:-1]:
            nxt=directory_at(d,name,True);os.close(d);d=nxt
        try:
            h=os.open(pp[-1],os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=d)
            try: regular(h)
            finally: os.close(h)
        except FileNotFoundError: pass
        h=os.open(pp[-1],os.O_WRONLY|os.O_CREAT|os.O_TRUNC|os.O_NOFOLLOW|os.O_NONBLOCK,0o600,dir_fd=d)
        try:
            regular(h);view=memoryview(content)
            while view: view=view[os.write(h,view):]
            os.fsync(h)
        finally: os.close(h)
        os.fsync(d)
    finally: os.close(d)

def exchange(a,an,b,bn):
    libc=ctypes.CDLL(None,use_errno=True)
    if sys.platform=='darwin': fn=libc.renameatx_np
    elif sys.platform=='linux': fn=libc.renameat2
    else: raise ValueError('ATOMIC_EXCHANGE_UNSUPPORTED')
    fn.argtypes=[ctypes.c_int,ctypes.c_char_p,ctypes.c_int,ctypes.c_char_p,ctypes.c_uint]
    fn.restype=ctypes.c_int
    if fn(a,an.encode(),b,bn.encode(),2)!=0: raise ValueError('ATOMIC_EXCHANGE_FAILED')

def lock_at(directory):
    # Darwin/APFS can report ENOENT when concurrent O_CREAT opens race on a
    # previously absent name. Create once exclusively, then open the existing
    # permanent lock inode without O_CREAT. Never retry permission/link errors.
    flags=os.O_RDWR|os.O_NOFOLLOW|os.O_NONBLOCK
    try: return os.open('lock',flags,dir_fd=directory)
    except FileNotFoundError:
        try: return os.open('lock',flags|os.O_CREAT|os.O_EXCL,0o600,dir_fd=directory)
        except FileExistsError: return os.open('lock',flags,dir_fd=directory)

def main(req):
    root=req['root']; dossier=str(uuid.UUID(req['dossier']));operation=req['operation'];args=req['args']
    rootfd=anchor(root);dossiers=directory_at(rootfd,'dossiers');state=directory_at(rootfd,'mcp-state',True)
    versions=directory_at(state,dossier,True)
    lock=lock_at(versions)
    try:
        if regular(lock).st_mode & 0o077: denied()
        fcntl.flock(lock,fcntl.LOCK_EX)
        source=directory_at(dossiers,dossier)
        try:
            if operation=='read': return {'path':args['path'],'content':read_at(source,args['path']).decode('utf8','strict')}
            if operation=='list':
                p=args.get('path','');target=os.dup(source)
                try:
                    if p:
                        for segment in parts(p):
                            nxt=directory_at(target,segment);os.close(target);target=nxt
                    entries=[]
                    for name in sorted(os.listdir(target)):
                        s=os.stat(name,dir_fd=target,follow_symlinks=False)
                        if not stat.S_ISDIR(s.st_mode) and (not stat.S_ISREG(s.st_mode) or s.st_nlink!=1): denied()
                        entries.append({'name':name,'kind':'directory' if stat.S_ISDIR(s.st_mode) else 'file'})
                    return {'entries':entries}
                finally: os.close(target)
            if operation=='importPaper':
                asset=str(uuid.UUID(args['assetId']))
                metadata=json.dumps(args['metadata'],ensure_ascii=False)
                changes=[{'path':'papers/'+asset+'.json','content':metadata}]
                if args.get('pdf') is not None:
                    binary=base64.b64decode(args['pdf'],validate=True)
                    if len(binary)>8*MAX_FILE or not binary.startswith(b'%PDF-'): denied()
                    changes.append({'path':'papers/'+asset+'.pdf','content':binary})
                req['writeTargets']=['papers/']
            elif operation=='undo':
                version=str(uuid.UUID(args['versionId']));old=directory_at(versions,version)
                try:
                    meta=json.loads(read_at(versions,version+'.json',65536))
                    before=os.fstat(old)
                    if [before.st_dev,before.st_ino]!=meta['sourceIdentity']: denied()
                    changes=[]
                    for p in meta['paths']:
                        try: content=read_at(old,p).decode('utf8','strict')
                        except FileNotFoundError: content=None
                        changes.append({'path':p,'content':content})
                finally: os.close(old)
            else:
                changes=args['changes'] if operation=='patch' else [{'path':args['path'],'content':args['content']}]
            if not 1<=len(changes)<=32: denied()
            total=0;seen=set()
            for change in changes:
                p=change['path'];parts(p)
                if p in seen: denied()
                seen.add(p)
                if not any(p==t or t.endswith('/') and p.startswith(t) for t in req['writeTargets']): denied()
                data=change['content'] if isinstance(change['content'],bytes) else (change['content'] or '').encode('utf8');total+=len(data)
                if len(data)>(8*MAX_FILE if operation=='importPaper' else MAX_FILE) or total>(9*MAX_FILE if operation=='importPaper' else MAX_PATCH): raise ValueError('FILE_TOO_LARGE')
            stage=str(uuid.uuid4());stagefd=directory_at(versions,stage,True)
            committed=False
            try:
                copy_tree(source,stagefd,[0,0])
                for change in changes:
                    if change['content'] is not None: write_at(stagefd,change['path'],change['content'] if isinstance(change['content'],bytes) else change['content'].encode('utf8'))
                    else:
                        pp=parts(change['path']);d=os.dup(stagefd)
                        try:
                            for name in pp[:-1]:
                                nxt=directory_at(d,name);os.close(d);d=nxt
                            os.unlink(pp[-1],dir_fd=d);os.fsync(d)
                        except FileNotFoundError: pass
                        finally: os.close(d)
                if req.get('fault')=='before_commit': raise ValueError('INJECTED_PRECOMMIT_FAILURE')
                before=os.fstat(source);current=os.stat(dossier,dir_fd=dossiers,follow_symlinks=False)
                if (before.st_dev,before.st_ino)!=(current.st_dev,current.st_ino): denied()
                os.fsync(stagefd)
                # Metadata precedes the commit. Inode identity distinguishes a committed
                # old version from a crash orphan that still contains the staged new tree.
                meta={'paths':[c['path'] for c in changes],'sourceIdentity':[before.st_dev,before.st_ino]}
                h=os.open(stage+'.json',os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600,dir_fd=versions)
                try: os.write(h,json.dumps(meta).encode());os.fsync(h)
                finally: os.close(h)
                os.fsync(versions)
                exchange(dossiers,dossier,versions,stage)
                committed=True
                os.fsync(dossiers);os.fsync(versions)
                history=sorted([n for n in os.listdir(versions) if n.endswith('.json')],key=lambda n:os.stat(n,dir_fd=versions).st_mtime_ns)
                for name in history[:-50]:
                    shutil.rmtree(os.path.join(root,'mcp-state',dossier,name[:-5]));os.unlink(name,dir_fd=versions)
                return {'versionId':stage,'paths':meta['paths']}
            finally:
                os.close(stagefd)
                if not committed:
                    shutil.rmtree(os.path.join(root,'mcp-state',dossier,stage))
                    try: os.unlink(stage+'.json',dir_fd=versions)
                    except FileNotFoundError: pass
        finally: os.close(source)
    finally:
        os.close(lock);os.close(versions);os.close(state);os.close(dossiers);os.close(rootfd)
try:
    raw=sys.stdin.buffer.read(12*MAX_FILE+1)
    if len(raw)>12*MAX_FILE: raise ValueError('FILE_TOO_LARGE')
    result=main(json.loads(raw))
    sys.stdout.write(json.dumps({'result':result},ensure_ascii=False))
except Exception as exc:
    code=str(exc) if isinstance(exc,ValueError) and str(exc) in ('FILE_SCOPE_DENIED','FILE_TOO_LARGE','DOSSIER_TOO_LARGE','ATOMIC_EXCHANGE_UNSUPPORTED','ATOMIC_EXCHANGE_FAILED','INJECTED_PRECOMMIT_FAILURE','UNDO_REQUIRES_SCOPED_VERSION') else 'FILE_SCOPE_DENIED'
    sys.stdout.write(json.dumps({'error':code}))
    sys.exit(1)
