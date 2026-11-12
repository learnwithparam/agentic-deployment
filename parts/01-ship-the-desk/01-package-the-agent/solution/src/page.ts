// The resident's page: pick an application and watch the desk check it.
export const residentPage = (version: string) => `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Harrowby permit desk</title>
<style>body{font:16px system-ui;margin:0;background:#f6f5f1;color:#1d1d1b}header{background:#1f4e3d;color:#fff;padding:16px 20px}
header h1{margin:0;font-size:20px}header p{margin:4px 0 0;opacity:.8;font-size:14px}main{max-width:720px;margin:24px auto;padding:0 16px}
select,button{font:inherit;padding:8px}button{background:#1f4e3d;color:#fff;border:0;border-radius:6px;padding:8px 16px;cursor:pointer}
#out{background:#fff;border-radius:8px;padding:16px;margin-top:16px;min-height:120px;white-space:pre-wrap;box-shadow:0 1px 4px #0001}
.tool{color:#555;font-family:monospace;font-size:13px}.done{color:#1f4e3d;font-weight:600}.err{color:#a33}footer{color:#777;font-size:12px;margin-top:16px}</style>
<header><h1>Harrowby District Council</h1><p>Permit desk: check that your application is complete</p></header>
<main><label>Your application <select id="app"></select></label> <button id="go">Check my application</button><div id="out"></div>
<footer>Release ${version}</footer></main>
<script>
const sel=document.getElementById('app');for(let n=140;n<180;n++){const o=document.createElement('option');o.textContent='HDC-2026-0'+n;sel.appendChild(o)}sel.value='HDC-2026-0142';
document.getElementById('go').onclick=async()=>{const out=document.getElementById('out');out.innerHTML='';
const r=await fetch('/v1/runs',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({application_id:sel.value})});
if(!r.headers.get('content-type')?.includes('event-stream')){out.textContent=await r.text();return}
const rd=r.body.getReader(),dec=new TextDecoder();let buf='';const text=document.createElement('div');
for(;;){const {value,done}=await rd.read();if(done)break;buf+=dec.decode(value,{stream:true});let i;while((i=buf.indexOf('\\n\\n'))>=0){const raw=buf.slice(0,i);buf=buf.slice(i+2);
const ev=(raw.match(/^event: (.*)$/m)||[])[1],data=JSON.parse((raw.match(/^data: (.*)$/m)||[])[1]||'{}');
if(ev==='tool'){const d=document.createElement('div');d.className='tool';d.textContent='checked: '+data.name;out.appendChild(d)}
if(ev==='token'){if(!text.parentNode){out.appendChild(text)}text.textContent+=data.text}
if(ev==='error'){const d=document.createElement('div');d.className='err';d.textContent=data.message;out.appendChild(d)}
if(ev==='done'){const d=document.createElement('div');d.className='done';d.textContent='Done. Run '+data.run_id+(data.cost_usd==null?'':', cost $'+Number(data.cost_usd).toFixed(4));out.appendChild(d)}}}};
</script>`;

export const staffPage = (name: string, rows: { id: string }[]) => `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Staff: Harrowby permit desk</title>
<style>body{font:16px system-ui;margin:0;background:#f6f5f1;color:#1d1d1b}header{background:#26344d;color:#fff;padding:16px 20px}header h1{margin:0;font-size:20px}
main{max-width:720px;margin:24px auto;padding:0 16px}table{width:100%;border-collapse:collapse;background:#fff}td,th{padding:8px 10px;border-bottom:1px solid #ddd;text-align:left}
button{background:#26344d;color:#fff;border:0;border-radius:6px;padding:6px 12px;font:inherit;cursor:pointer}</style>
<header><h1>Validation queue</h1><div>Signed in as ${name}</div></header><main>
<p>${rows.length} application(s) wait for an officer.</p><table><tr><th>Application</th><th></th></tr>
${rows.map((r) => `<tr><td>${r.id}</td><td><form method="post" action="/staff/validate/${r.id}"><button>Validate</button></form></td></tr>`).join("")}</table></main>`;
