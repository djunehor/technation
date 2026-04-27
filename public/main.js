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
    block.className = 'result-block proforma';
    
    const isEndorsed = result.overallVerdict === 'ENDORSED';
    const lastRound = result.rounds && result.rounds.length > 0 ? result.rounds[result.rounds.length - 1] : null;
    const feedback = lastRound ? lastRound.reviewerNotes : '';
    const isTalent = result.pathway === 'Exceptional Talent';
    
    // Safety check for older results
    const furtherDetails = result.furtherDetails || {
        outstandingTrackRecord: false,
        strengthOfEvidence: false,
        meritOfPresenceInUK: false,
        sufficientLeadershipEvidence: false,
        evidenceWithinFiveYears: false
    };

    if (isEndorsed) {
        block.innerHTML = `
            <div class="endorsement-success-card">
                <div class="success-icon">🎉</div>
                <h1>Endorsement Successful</h1>
                <p>The candidate <strong>${result.candidateName}</strong> has been recommended for endorsement under the <strong>${result.pathway}</strong> pathway.</p>
                <div class="verdict-badge endorse">ENDORSED</div>
            </div>
        `;
    } else {
        block.innerHTML = `
            <div class="proforma-header">
                <div class="verdict-tag reject">${result.overallVerdict}</div>
                <h2>Tech Nation Global Talent Assessment Proforma</h2>
                <div class="candidate-meta">
                    Candidate: <strong>${result.candidateName}</strong> | Pathway: <strong>${result.pathway}</strong>
                </div>
                <div class="proforma-actions no-print">
                    <button class="btn-download-pdf" onclick="downloadPDF()">Download Official Proforma (PDF)</button>
                </div>
            </div>

            <div class="proforma-section">
                <div class="section-title-bar">
                    <h3>Feedback – Mandatory and Optional Eligibility Criteria:</h3>
                    <span class="yes-no-label">YES/NO</span>
                </div>
                
                <table class="proforma-table">
                    <tbody>
                        <tr class="main-fulfillment">
                            <td>The applicant has fulfilled the necessary eligibility criteria to be considered under the Global Talent route.</td>
                            <td class="no">NO</td>
                        </tr>
                        <tr class="sub-header"><td colspan="2">Details of which area(s) have been fulfilled are listed below:</td></tr>
                        <tr class="sub-header"><td colspan="2">Meet the Mandatory Criteria:</td></tr>
                        
                        <!-- Talent Mandatory -->
                        <tr class="category-row"><td>Talent:</td><td></td></tr>
                        <tr class="${!isTalent ? 'dimmed' : ''}">
                            <td>Show that they have been recognised as a leading talent in the digital technology sector in the last 5 years</td>
                            <td class="${isTalent ? (result.mandatoryCriteria.met ? 'yes' : 'no') : ''}">${isTalent ? (result.mandatoryCriteria.met ? 'YES' : 'NO') : '-'}</td>
                        </tr>
                        
                        <!-- Promise Mandatory -->
                        <tr class="category-row"><td>Promise:</td><td></td></tr>
                        <tr class="${isTalent ? 'dimmed' : ''}">
                            <td>Show that they have been recognised as having the potential to be a leading talent in the digital technology field in the last 5 years</td>
                            <td class="${!isTalent ? (result.mandatoryCriteria.met ? 'yes' : 'no') : ''}">${!isTalent ? (result.mandatoryCriteria.met ? 'YES' : 'NO') : '-'}</td>
                        </tr>
                        <tr class="${isTalent ? 'dimmed' : ''}">
                            <td>The applicant is at an early stage in their digital technology career</td>
                            <td class="${!isTalent ? (result.mandatoryCriteria.met ? 'yes' : 'no') : ''}">${!isTalent ? (result.mandatoryCriteria.met ? 'YES' : 'NO') : '-'}</td>
                        </tr>

                        <tr class="sub-header"><td colspan="2">Meet two of the Optional Criteria:</td></tr>
                        <tr class="category-row"><td>Talent:</td><td></td></tr>
                        ${[1, 2, 3, 4].map(i => {
                            const oc = result.optionalCriteria.find(o => o.id === `OC${i}`);
                            const name = getTalentOCName(i);
                            return `
                            <tr class="${!isTalent ? 'dimmed' : ''}">
                                <td><strong>${i}</strong> - ${name}</td>
                                <td class="${isTalent && oc ? (oc.met ? 'yes' : 'no') : ''}">${isTalent && oc ? (oc.met ? 'YES' : 'NO') : '-'}</td>
                            </tr>`;
                        }).join('')}

                        <tr class="category-row"><td>Promise:</td><td></td></tr>
                        ${[1, 2, 3, 4].map(i => {
                            const oc = result.optionalCriteria.find(o => o.id === `OC${i}`);
                            const name = getPromiseOCName(i);
                            return `
                            <tr class="${isTalent ? 'dimmed' : ''}">
                                <td><strong>${i}</strong> - ${name}</td>
                                <td class="${!isTalent && oc ? (oc.met ? 'yes' : 'no') : ''}">${!isTalent && oc ? (oc.met ? 'YES' : 'NO') : '-'}</td>
                            </tr>`;
                        }).join('')}
                    </tbody>
                </table>
            </div>

            <div class="proforma-section">
                <div class="section-title-bar">
                    <h3>Feedback – further details</h3>
                    <span class="yes-no-label">YES/NO</span>
                </div>
                <table class="proforma-table">
                    <tbody>
                        <tr class="sub-header"><td colspan="2">Details of decision made are listed below:</td></tr>
                        <tr>
                            <td>People who enter through Global Talent are expected to have an outstanding track record/career history. The reviewers felt that the applicant’s track record was sufficiently strong to be endorsed under Global Talent.</td>
                            <td class="${furtherDetails.outstandingTrackRecord ? 'yes' : 'no'}">${furtherDetails.outstandingTrackRecord ? 'YES' : 'NO'}</td>
                        </tr>
                        <tr>
                            <td>The strength of the evidence as presented in the supporting statement(s), persuaded the reviewers that the applicant met the mandatory and optional criteria and should therefore be endorsed under Global Talent.</td>
                            <td class="${furtherDetails.strengthOfEvidence ? 'yes' : 'no'}">${furtherDetails.strengthOfEvidence ? 'YES' : 'NO'}</td>
                        </tr>
                        <tr>
                            <td>The reviewers felt the application demonstrated that the applicant’s presence in the UK will be of sufficient merit to be endorsed for entry through the Global Talent route.</td>
                            <td class="${furtherDetails.meritOfPresenceInUK ? 'yes' : 'no'}">${furtherDetails.meritOfPresenceInUK ? 'YES' : 'NO'}</td>
                        </tr>
                        <tr>
                            <td>The reviewers felt that there was sufficient evidence within the application to demonstrate that the applicant could be considered a leader/potential leader in the field of digital technology.</td>
                            <td class="${furtherDetails.sufficientLeadershipEvidence ? 'yes' : 'no'}">${furtherDetails.sufficientLeadershipEvidence ? 'YES' : 'NO'}</td>
                        </tr>
                        <tr>
                            <td>The reviewers confirm that the age of the evidence submitted as part of the application sufficiently shows that the applicant has demonstrated exceptional talent or promise within the last 5 years.</td>
                            <td class="${furtherDetails.evidenceWithinFiveYears ? 'yes' : 'no'}">${furtherDetails.evidenceWithinFiveYears ? 'YES' : 'NO'}</td>
                        </tr>
                    </tbody>
                </table>
            </div>

            <div class="proforma-section">
                <h3>Assessment panel feedback:</h3>
                <div class="feedback-content markdown-body">
                    ${marked.parse(feedback || result.summary)}
                </div>
            </div>
        `;
    }
    
    mainContent.appendChild(block);
    statusLine.innerText = 'Assessment Complete';
    window.scrollTo(0, document.body.scrollHeight);
}

function getTalentOCName(i) {
    const names = [
        "A proven track record for innovation as a founder or senior executive of a product-led digital technology company or as an employee working on a new digital field or concept",
        "Proof of recognition for work beyond the applicant’s occupation that contributes to the advancement of the field",
        "They have made significant technical, commercial or entrepreneurial contributions to the field as a founder, senior executive or employee of a product-led digital technology company",
        "They have demonstrated exceptional ability in the field by academic contributions through research published or endorsed by an expert."
    ];
    return names[i-1];
}

function getPromiseOCName(i) {
    const names = [
        "Innovation as a founder of a product-led digital technology company or as an employee working on a new digital field or concept",
        "A proof of recognition for work beyond the applicant’s occupation that contributes to the advancement of the field",
        "They have made significant technical, commercial or entrepreneurial contributions to the field as a founder or employee of a product-led digital technology company",
        "They have demonstrated exceptional ability in the field by academic contributions through research endorsed by an expert"
    ];
    return names[i-1];
}

window.downloadPDF = function() {
    console.log('[DEBUG] Starting PDF Export (Fixed Scroll Logic)...');
    const element = document.querySelector('.result-block.proforma') || document.querySelector('.endorsement-success-card');
    
    if (!element) {
        console.error('[DEBUG] ERROR: No capture target found!');
        return;
    }

    const candidateName = document.querySelector('.candidate-meta strong')?.innerText || 
                          document.querySelector('.endorsement-success-card strong')?.innerText || 
                          'Unknown';
    
    // Save current scroll position
    const oldScrollY = window.scrollY;
    
    // Move to top for clean capture
    window.scrollTo(0, 0);

    const opt = {
        margin: [10, 5, 10, 5],
        filename: `TechNation_Proforma_${candidateName.replace(/\s+/g, '_')}.pdf`,
        image: { type: 'jpeg', quality: 0.98 },
        html2canvas: { 
            scale: 2, 
            useCORS: true, 
            logging: true,
            backgroundColor: '#ffffff' 
            // Removed buggy scrollY: -window.scrollY
        },
        jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' }
    };

    html2pdf().set(opt).from(element).save().then(() => {
        console.log('[DEBUG] PDF Export complete. Restoring scroll...');
        window.scrollTo(0, oldScrollY);
    }).catch(err => {
        console.error('[DEBUG] PDF Export Error:', err);
        window.scrollTo(0, oldScrollY);
    });
};
