const API_BASE_URL = window.location.origin;
const fileInput = document.getElementById('fileInput');
const folderInput = document.getElementById('folderInput');
const dropZone = document.getElementById('dropZone');
const statusLine = document.getElementById('status');
const mainContent = document.getElementById('mainContent');

// ─── Drag & Drop Logic ───────────────────────────────────────────────────

dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('drag-over');
});

dropZone.addEventListener('dragleave', () => {
    dropZone.classList.remove('drag-over');
});

dropZone.addEventListener('drop', async (e) => {
    e.preventDefault();
    dropZone.classList.remove('drag-over');
    
    const items = e.dataTransfer.items;
    const files = [];
    
    const traverse = async (entry, path = '') => {
        if (entry.isFile) {
            const file = await new Promise((resolve) => entry.file(resolve));
            // Store the relative path in a custom property so we can use it in FormData
            file.relativePath = path + entry.name;
            files.push(file);
        } else if (entry.isDirectory) {
            const reader = entry.createReader();
            const entries = await new Promise((resolve) => reader.readEntries(resolve));
            for (const subEntry of entries) {
                await traverse(subEntry, path + entry.name + '/');
            }
        }
    };

    const promises = [];
    for (let i = 0; i < items.length; i++) {
        const entry = items[i].webkitGetAsEntry();
        if (entry) promises.push(traverse(entry));
    }
    
    await Promise.all(promises);
    if (files.length > 0) startAssessment(files);
});

// ─── File Input Logic ───────────────────────────────────────────────────

const handleFileSelect = (e) => {
    const files = Array.from(e.target.files).map(f => {
        f.relativePath = f.webkitRelativePath || f.name;
        return f;
    });
    if (files.length > 0) startAssessment(files);
};

fileInput.addEventListener('change', handleFileSelect);
folderInput.addEventListener('change', handleFileSelect);

// ─── Assessment Logic ────────────────────────────────────────────────────

async function startAssessment(files) {
    statusLine.innerText = `Processing ${files.length} documents...`;
    mainContent.innerHTML = '';
    dropZone.style.display = 'none'; // Hide dropzone once started
    
    const formData = new FormData();
    files.forEach(f => {
        formData.append('files', f, f.relativePath || f.name);
    });
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
        dropZone.style.display = 'block';
    }
}

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
    if (!result) return;
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
