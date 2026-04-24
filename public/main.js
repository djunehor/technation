const API_BASE_URL = window.location.origin;
const fileInput = document.getElementById('fileInput');
const statusLine = document.getElementById('status');
const mainContent = document.getElementById('mainContent');

fileInput.addEventListener('change', async (e) => {
    const files = Array.from(e.target.files);
    if (files.length === 0) return;

    statusLine.innerText = `Processing ${files.length} documents...`;
    mainContent.innerHTML = '';
    
    const formData = new FormData();
    files.forEach(f => formData.append('files', f));
    formData.append('candidateName', 'Applicant');

    try {
        const response = await fetch(`${API_BASE_URL}/api/assess`, {
            method: 'POST',
            body: formData
        });

        const { assessmentId } = await response.json();
        startStreaming(assessmentId);
    } catch (error) {
        statusLine.innerText = `Error: ${error.message}`;
    }
});

function addLog(message, isAccent = false) {
    const block = document.createElement('div');
    block.className = `log-block ${isAccent ? 'accent' : ''}`;
    block.innerHTML = marked.parse(message);
    mainContent.appendChild(block);
    window.scrollTo(0, document.body.scrollHeight);
}

function startStreaming(id) {
    const eventSource = new EventSource(`${API_BASE_URL}/api/assess/${id}/stream`);
    
    eventSource.onmessage = (event) => {
        const data = JSON.parse(event.data);
        if (data.type === 'log') {
            const msg = data.message;
            if (msg.includes('Round') || msg.includes('Detected:')) {
                addLog(msg, true);
            } else if (msg === 'Assessment complete.') {
                eventSource.close();
                fetchResult(id);
            } else {
                addLog(msg);
            }
        }
    };
}

async function fetchResult(id) {
    const res = await fetch(`${API_BASE_URL}/api/assess/${id}`);
    const data = await res.json();
    renderResult(data.result);
}

function renderResult(result) {
    const block = document.createElement('div');
    block.className = 'result-block';
    
    const isEndorsed = result.overallVerdict === 'ENDORSED';
    
    block.innerHTML = `
        <div class="verdict-tag ${isEndorsed ? 'endorse' : 'reject'}">${result.overallVerdict}</div>
        <div class="markdown-body">${marked.parse(result.summary)}</div>
        <div class="criteria-grid">
            ${renderCriteria('Mandatory Criteria', result.mandatoryCriteria)}
            ${result.optionalCriteria.map(oc => renderCriteria(oc.name, oc)).join('')}
        </div>
    `;
    
    mainContent.appendChild(block);
    statusLine.innerText = 'Assessment Complete';
    window.scrollTo(0, document.body.scrollHeight);
}

function renderCriteria(name, data) {
    return `
        <div class="criteria-card">
            <div class="criteria-name">
                <span>${name}</span>
                <span class="${data.met ? 'met' : 'fail'}">${data.met ? 'MET' : 'NOT MET'}</span>
            </div>
            <div class="markdown-body" style="font-size: 0.85rem; color: #4b5563;">
                ${marked.parse(data.justification)}
            </div>
        </div>
    `;
}
