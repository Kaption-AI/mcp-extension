import {mkdtemp,writeFile,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {resolveLocalAttachment} from '../attachment';
import {TOOLS} from '../tools';
let dir:string;
beforeEach(async()=>{dir=await mkdtemp(join(tmpdir(),'kaption-attachment-test-'));});
afterEach(async()=>{await rm(dir,{recursive:true,force:true});});
const ref='a'.repeat(64), token='b'.repeat(64);
const slot={attachmentRef:ref,uploadUrl:`https://schedule.kaptionai.com/attachments/${ref}?token=${token}`};
it('mcp-local-send.REFERENCES.2 path uploads bounded bytes and forwards only ref',async()=>{
 const path=join(dir,'synthetic.pdf');await writeFile(path,'abc');
 const create=jest.fn(async()=>slot),fetcher=jest.fn(async()=>new Response(null,{status:204}));
 const result=await resolveLocalAttachment('send_message',{attachment:{path}},create,fetcher as any);
 expect(create).toHaveBeenCalledWith({name:'synthetic.pdf',mime:'application/pdf',size:3});
 expect(fetcher.mock.calls.length).toBe(1);expect(result).toEqual({attachment:{ref}});
});
it('rejects relative paths, directories, empty/oversized files, ambiguous sources and URLs',async()=>{
 const empty=join(dir,'empty.pdf'),big=join(dir,'big.pdf');await writeFile(empty,'');await writeFile(big,Buffer.alloc(8388609));
 const create=jest.fn(async()=>slot);
 for(const attachment of [{path:'relative.pdf'},{path:dir},{path:empty},{path:big},{path:empty,ref},{url:'https://example.com/file'}])await expect(resolveLocalAttachment('send_message',{attachment},create)).rejects.toThrow('attachment:');
 expect(create).not.toHaveBeenCalled();
});
it('rejects bot schedule paths and refuses untrusted upload destinations',async()=>{
 const path=join(dir,'synthetic.pdf');await writeFile(path,'abc');const create=jest.fn(async()=>({...slot,uploadUrl:'https://example.com/steal'}));const fetcher=jest.fn();
 await expect(resolveLocalAttachment('manage_scheduled_messages',{action:'create',mode:'bot',attachment:{path}},create)).rejects.toThrow('local create/update');
 await expect(resolveLocalAttachment('send_message',{attachment:{path}},create,fetcher)).rejects.toThrow('invalid upload destination');expect(fetcher).not.toHaveBeenCalled();
});
it('schemas enforce exclusive ref/base64/path and advertise create_attachment_upload',()=>{
 const schema=TOOLS.find(t=>t.name==='send_message')!.inputSchema;
 const parse=(attachment:any)=>schema.safeParse({conversation_id:'synthetic',attachment}).success;
 expect(parse({ref})).toBe(true);expect(parse({path:'/tmp/file.pdf'})).toBe(true);
 expect(parse({ref,path:'/tmp/file.pdf'})).toBe(false);expect(parse({url:'https://example.com'})).toBe(false);
 expect(TOOLS.some(t=>t.name==='create_attachment_upload')).toBe(true);
});
