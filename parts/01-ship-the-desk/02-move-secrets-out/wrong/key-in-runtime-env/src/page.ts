// The desk's two web pages, written as plain HTML so the desk needs no front-end build.

// The look of the resident's page.
const residentStyles = `
body{font:16px system-ui;margin:0;background:#f6f5f1;color:#1d1d1b}
header{background:#1f4e3d;color:#fff;padding:16px 20px}
header h1{margin:0;font-size:20px}
header p{margin:4px 0 0;opacity:.8;font-size:14px}
main{max-width:720px;margin:24px auto;padding:0 16px}
select,button{font:inherit;padding:8px}
button{background:#1f4e3d;color:#fff;border:0;border-radius:6px;padding:8px 16px;cursor:pointer}
#out{background:#fff;border-radius:8px;padding:16px;margin-top:16px;min-height:120px;
white-space:pre-wrap;box-shadow:0 1px 4px #0001}
.tool{color:#555;font-family:monospace;font-size:13px}
.done{color:#1f4e3d;font-weight:600}
.err{color:#a33}
footer{color:#777;font-size:12px;margin-top:16px}`;

// The code that runs in the resident's browser: start a run, then show each event as it arrives.
const residentScript = `
const applicationPicker = document.getElementById('app');
for (let number = 140; number < 180; number++) {
  const option = document.createElement('option');
  option.textContent = 'HDC-2026-0' + number;
  applicationPicker.appendChild(option);
}
applicationPicker.value = 'HDC-2026-0142';

// One event in the stream looks like "event: token" on one line and "data: {...}" on the next.
function readEvent(block) {
  const name = (block.match(/^event: (.*)$/m) || [])[1];
  const data = JSON.parse((block.match(/^data: (.*)$/m) || [])[1] || '{}');
  return { name, data };
}

function addLine(output, className, text) {
  const line = document.createElement('div');
  line.className = className;
  line.textContent = text;
  output.appendChild(line);
}

function showEvent(output, answer, name, data) {
  if (name === 'tool') addLine(output, 'tool', 'checked: ' + data.name);
  if (name === 'token') {
    if (!answer.parentNode) output.appendChild(answer);
    answer.textContent += data.text;
  }
  if (name === 'error') addLine(output, 'err', data.message);
  if (name === 'done') {
    const cost = data.cost_usd == null ? '' : ', cost $' + Number(data.cost_usd).toFixed(4);
    addLine(output, 'done', 'Done. Run ' + data.run_id + cost);
  }
}

document.getElementById('go').onclick = async () => {
  const output = document.getElementById('out');
  output.innerHTML = '';
  const response = await fetch('/v1/runs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ application_id: applicationPicker.value }),
  });
  // A desk that does not stream answers in one piece, so show that piece as it is.
  if (!response.headers.get('content-type')?.includes('event-stream')) {
    output.textContent = await response.text();
    return;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const answer = document.createElement('div');
  let unread = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    unread += decoder.decode(value, { stream: true });
    // Each event ends with a blank line. One chunk can hold several events, or half of one.
    let end;
    while ((end = unread.indexOf('\\n\\n')) >= 0) {
      const { name, data } = readEvent(unread.slice(0, end));
      unread = unread.slice(end + 2);
      showEvent(output, answer, name, data);
    }
  }
};`;

/** The resident's page: pick an application and watch the desk check it. */
export function residentPage(version: string): string {
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Harrowby permit desk</title>
<style>${residentStyles}</style>
<header><h1>Harrowby District Council</h1>
<p>Permit desk: check that your application is complete</p></header>
<main><label>Your application <select id="app"></select></label>
<button id="go">Check my application</button><div id="out"></div>
<footer>Release ${version}</footer></main>
<script>${residentScript}
</script>`;
}

// The look of the staff page.
const staffStyles = `
body{font:16px system-ui;margin:0;background:#f6f5f1;color:#1d1d1b}
header{background:#26344d;color:#fff;padding:16px 20px}
header h1{margin:0;font-size:20px}
main{max-width:720px;margin:24px auto;padding:0 16px}
table{width:100%;border-collapse:collapse;background:#fff}
td,th{padding:8px 10px;border-bottom:1px solid #ddd;text-align:left}
button{background:#26344d;color:#fff;border:0;border-radius:6px;padding:6px 12px;font:inherit;
cursor:pointer}`;

/** One row of the queue: the application and a button that validates it. */
function staffRow(application: { id: string }): string {
  const action = `/staff/validate/${application.id}`;
  const validateForm = `<form method="post" action="${action}"><button>Validate</button></form>`;
  return `<tr><td>${application.id}</td><td>${validateForm}</td></tr>`;
}

/** The staff page: the applications that wait for an officer to validate them. */
export function staffPage(name: string, applications: { id: string }[]): string {
  const rows = applications.map(staffRow).join("");
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Staff: Harrowby permit desk</title>
<style>${staffStyles}</style>
<header><h1>Validation queue</h1><div>Signed in as ${name}</div></header><main>
<p>${applications.length} application(s) wait for an officer.</p>
<table><tr><th>Application</th><th></th></tr>
${rows}</table></main>`;
}
