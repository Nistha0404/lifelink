document.addEventListener('DOMContentLoaded', () => {
  let currentHospital = null;

  // Elements
  const welcomeMessage = document.getElementById('welcome-message');
  const logoutBtn = document.getElementById('logoutBtn');

  // SOS
  const hospitalSosForm = document.getElementById('hospital-sos-form');
  const hospitalSosMessage = document.getElementById('hospital-sos-message');
  const liveSosList = document.getElementById('live-sos-list');

  // Stock Lite
  const inventoryContainer = document.getElementById('inventory-container');
  const saveInventoryBtn = document.getElementById('save-inventory-btn');
  const inventoryMessage = document.getElementById('inventory-message');

  // Verification
  const verifyInput = document.getElementById('verify-token-input');
  const verifyBtn = document.getElementById('verify-btn');
  const verifyMsg = document.getElementById('verify-message');
  const verifyResults = document.getElementById('verify-results');

  function initializeDashboard() {
    const s = sessionStorage.getItem('currentHospital');
    if (!s) { window.location.href = 'hospital-login.html'; return; }
    currentHospital = JSON.parse(s);
    welcomeMessage.textContent = `Welcome, ${currentHospital.hospital_name}`;
    renderStockLiteControls();
    startPollingForSOS();
  }

  // SOS Broadcast
  hospitalSosForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const payload = {
      hospitalId: currentHospital.hospital_id,
      component: document.getElementById('sos-component').value,
      bloodType: document.getElementById('sos-blood-type').value,
      units: document.getElementById('sos-units').value,
      urgency: document.getElementById('sos-urgency').value,
    };
    try {
      const res = await fetch('/api/server/hospital-sos', {
        method: 'POST', headers: { 'Content-Type':'application/json' },
        body: JSON.stringify(payload)
      });
      const out = await res.json();
      displayMessage(hospitalSosMessage, out.message, out.success);
    } catch (err) {
      console.error(err);
      displayMessage(hospitalSosMessage, 'Server connection error.', false);
    }
  });

  // Stock Lite
  function renderStockLiteControls() {
    inventoryContainer.innerHTML = '';
    const bloodGroups = ["A+","A-","B+","B-","AB+","AB-","O+","O-"];
    const inv = currentHospital.blood_inventory || {};
    for (const type of bloodGroups) {
      const item = inv[type] || { units: 0, confidence: 'Low' };
      const html = `
        <div class="inventory-item">
          <label>${type}</label>
          <input type="number" data-blood-type="${type}" class="stock-units" value="${item.units}" min="0">
          <select data-blood-type="${type}" class="stock-confidence">
            <option value="High" ${item.confidence === 'High' ? 'selected' : ''}>High</option>
            <option value="Medium" ${item.confidence === 'Medium' ? 'selected' : ''}>Medium</option>
            <option value="Low" ${item.confidence === 'Low' ? 'selected' : ''}>Low</option>
          </select>
        </div>`;
      inventoryContainer.insertAdjacentHTML('beforeend', html);
    }
  }

  saveInventoryBtn.addEventListener('click', async () => {
    const updated = {};
    document.querySelectorAll('.inventory-item').forEach(item => {
      const unitsEl = item.querySelector('.stock-units');
      const confEl = item.querySelector('.stock-confidence');
      const type = unitsEl.dataset.bloodType;
      updated[type] = {
        units: parseInt(unitsEl.value, 10) || 0,
        confidence: confEl.value,
        timestamp: new Date().toISOString()
      };
    });
    try {
      const res = await fetch('/api/server/update-inventory', {
        method:'POST', headers:{ 'Content-Type':'application/json' },
        body: JSON.stringify({ hospitalId: currentHospital.hospital_id, inventory: updated })
      });
      const out = await res.json();
      if (out.success) {
        currentHospital.blood_inventory = updated;
        sessionStorage.setItem('currentHospital', JSON.stringify(currentHospital));
      }
      displayMessage(inventoryMessage, out.message, out.success);
    } catch (err) {
      console.error(err);
      displayMessage(inventoryMessage, 'Server connection error.', false);
    }
  });

  // Unified Token Verification
  verifyInput.addEventListener('input', () => {
    // digits only, max 4
    verifyInput.value = (verifyInput.value || '').replace(/\D/g, '').slice(0, 4);
    clearVerifyUI();
  });

  // Support Enter key to verify
  verifyInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      verifyBtn.click();
    }
  });

  verifyBtn.addEventListener('click', async () => {
    const token = (verifyInput.value || '').trim();
    if (!/^\d{4}$/.test(token)) {
      showVerifyMsg('Please enter a valid 4-digit token.', false);
      return;
    }
    try {
      showVerifyMsg('Verifying…', true);
      const res = await fetch('/api/hospital/verify-token', {
        method:'POST',
        headers:{ 'Content-Type':'application/json' },
        body: JSON.stringify({ token })
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        showVerifyMsg(data.message || 'Token not found.', false);
        verifyResults.innerHTML = '';
        return;
      }
      renderVerificationResult(data);
      showVerifyMsg('Verified', true);
    } catch (err) {
      console.error(err);
      showVerifyMsg('Server error while verifying.', false);
      verifyResults.innerHTML = '';
    }
  });

  function qrFor(obj) {
    const payload = encodeURIComponent(JSON.stringify(obj));
    return `https://api.qrserver.com/v1/create-qr-code/?size=160x160&data=${payload}`;
  }

  function renderVerificationResult(data) {
    if (data.type === 'patient') {
      const { patient_token, patient, request_id } = data;
      verifyResults.innerHTML = `
        <div class="kv" style="margin-top:8px;">
          <div>Type</div><div>Patient</div>
          <div>Full Name</div><div>${esc(patient.full_name)}</div>
          <div>Blood Type Needed</div><div>${esc(patient.blood_type_needed)}</div>
          <div>Pincode</div><div>${esc(patient.pincode || 'N/A')}</div>
          <div>Request ID</div><div>${esc(String(request_id))}</div>
          <div>Patient Token</div><div><span class="pill">${esc(patient_token)}</span></div>
          <div>Token QR</div><div><img class="qr-preview" src="${qrFor({type:'patient_token', token: patient_token})}" alt="Patient QR"></div>
        </div>
        <div class="divider"></div>
        <div class="muted">Confirm patient identity with token/QR before proceeding.</div>
      `;
    } else if (data.type === 'donor') {
      const { donor_token, donor, matched_patient_token, request_id, commitment_id, commitment_status } = data;
      verifyResults.innerHTML = `
        <div class="kv" style="margin-top:8px;">
          <div>Type</div><div>Donor</div>
          <div>Full Name</div><div>${esc(donor.full_name)}</div>
          <div>Blood Type</div><div>${esc(donor.blood_type || 'N/A')}</div>
          <div>Last Donation</div><div>${donor.last_donation_date ? esc(new Date(donor.last_donation_date).toLocaleDateString()) : 'N/A'}</div>
          <div>Donor Token</div><div><span class="pill">${esc(donor_token)}</span></div>
          <div>Token QR</div><div><img class="qr-preview" src="${qrFor({type:'donor_token', token: donor_token})}" alt="Donor QR"></div>
        </div>
        <div class="divider"></div>
        <div class="kv">
          <div>Matched Patient Token</div><div><span class="pill">${esc(matched_patient_token)}</span></div>
          <div>Request ID</div><div>${esc(String(request_id))}</div>
          <div>Commitment</div><div>#${esc(String(commitment_id))} (${esc(commitment_status)})</div>
        </div>
        <div class="divider"></div>
        <div class="muted">Confirm donor identity and cross-check matched patient token.</div>
      `;
    } else {
      verifyResults.innerHTML = '';
    }
  }

  function clearVerifyUI() {
    verifyMsg.textContent = '';
    verifyMsg.className = 'message-area';
    verifyResults.innerHTML = '';
  }
  function showVerifyMsg(msg, ok) {
    verifyMsg.textContent = msg;
    verifyMsg.className = 'message-area ' + (ok ? 'ok' : 'err');
  }
  function esc(s) {
    if (s == null) return '';
    return String(s)
      .replace(/&/g,'&amp;').replace(/</g,'&lt;')
      .replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  }

  // Live SOS polling (fill in your existing logic if applicable)
  // Live SOS polling
  let sosPollInterval; // This will store our timer
  async function startPollingForSOS() {
    if (!currentHospital || !currentHospital.hospital_id) {
        console.log("No hospital info, can't start monitor.");
        return;
    }
    
    // Stop any old timer
    if (sosPollInterval) clearInterval(sosPollInterval);

    // Fetch alerts immediately
    await fetchSosAlerts();
    
    // Then, check for new alerts every 15 seconds
    sosPollInterval = setInterval(fetchSosAlerts, 15000);
  }

  // This function fetches new alerts from your server
  async function fetchSosAlerts() {
    try {
        const response = await fetch(`/api/server/sos-alerts/${currentHospital.hospital_id}`);
        const requests = await response.json();

        liveSosList.innerHTML = ''; // Clear the list

        if (!requests || requests.length === 0) {
            liveSosList.innerHTML = '<li class="no-requests">No active SOS requests.</li>';
            return;
        }

        // Add each new request to the list
        requests.forEach(req => {
            const li = document.createElement('li');
            li.className = 'sos-request-item'; // Add a class for styling
            li.innerHTML = `
                <div class="sos-info">
                    <strong>Blood: ${req.blood_type_needed}</strong>
                    <span>Pincode: ${req.pincode}</span>
                    <span class="muted">Token: ${req.patient_token}</span>
                </div>
                <div class="sos-actions">
                    <button class="btn-primary" onclick="acceptRequest(${req.request_id})">Accept</button>
                </div>
            `;
            liveSosList.appendChild(li);
        });
    } catch (e) {
        console.error("Error fetching SOS alerts:", e);
        liveSosList.innerHTML = '<li>Error loading requests.</li>';
    }
  }

  // This runs when the hospital clicks the "Accept" button
  // We must make it global so the "onclick" in the HTML can find it
  window.acceptRequest = async (requestId) => {
    try {
        const response = await fetch('/api/server/accept-request', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                requestId: requestId,
                hospitalId: currentHospital.hospital_id
            })
        });
        
        const result = await response.json();

        if (result.success) {
            alert('Request accepted! The patient is being notified.');
        } else {
            alert(`Error: ${result.message}`);
        }
        
        // Refresh the list immediately
        fetchSosAlerts();
    } catch (e) {
        alert('An error occurred. Please try again.');
    }
  }

  function displayMessage(el, msg, ok) {
    el.textContent = msg;
    el.style.color = ok ? 'green' : 'red';
    setTimeout(() => { el.textContent = ''; }, 3000);
  }

  logoutBtn.addEventListener('click', () => {
    sessionStorage.removeItem('currentHospital');
    window.location.href = 'hospital-login.html';
  });

  initializeDashboard();
});